//
//  MizarConnection.swift
//  MizarKit
//
//  The authenticated client.
//
//  One socket carries everything: unary calls are correlated by the `id` echo,
//  and the host pushes interactions (approvals, questions) as unsolicited
//  `event` frames on the same connection. There is no second channel to keep in
//  sync, which is what makes a phone recovering from the background a matter of
//  one reconnect rather than a set of independent recoveries.
//
//  Two properties are deliberate:
//
//  - **A request always settles.** Every call is bounded; a host that stops
//    answering produces a timeout error rather than a task that hangs forever,
//    and the pending continuation is resumed exactly once on every path.
//  - **Unknown frames do not break the socket.** A host newer than the app may
//    send a frame type this build has never heard of; it is delivered as
//    `.unknown` and ignored rather than failing to decode and tearing down the
//    connection.
//

import Foundation

/// The authenticated Mizar client.
public actor MizarConnection {
    /// How to reach the host.
    public struct Configuration: Sendable {
        /// `host:port`.
        public var authority: String
        /// The device token from pairing.
        public var token: String
        /// Whether to use `wss`.
        public var secure: Bool
        /// Reported to the host at `hello`, for the device roster.
        public var appVersion: String?
        /// Reported to the host at `hello`.
        public var deviceModel: String?
        /// How long a unary call may take before it is failed.
        public var requestTimeout: Duration

        public init(
            authority: String,
            token: String,
            secure: Bool = false,
            appVersion: String? = nil,
            deviceModel: String? = nil,
            requestTimeout: Duration = .seconds(60),
        ) {
            self.authority = authority
            self.token = token
            self.secure = secure
            self.appVersion = appVersion
            self.deviceModel = deviceModel
            self.requestTimeout = requestTimeout
        }
    }

    /// Where the connection is in its lifecycle.
    public enum State: Sendable, Equatable {
        case idle
        case connecting
        /// Handshaken; the host's welcome is available.
        case ready(WelcomeFrame)
        case failed(String)

        /// The welcome, when connected.
        public var welcome: WelcomeFrame? {
            if case .ready(let welcome) = self { return welcome }
            return nil
        }
    }

    private let configuration: Configuration
    private let makeTransport: @Sendable () -> WebSocketTransport

    private var transport: WebSocketTransport?
    private var receiveTask: Task<Void, Never>?
    private var state: State = .idle

    /// Unary calls awaiting their answer, keyed by correlation id.
    private var pending: [String: CheckedContinuation<JSONValue?, any Error>] = [:]
    /// Whoever is awaiting the handshake.
    private var handshake: CheckedContinuation<WelcomeFrame, any Error>?
    /// Live event subscribers.
    private var subscribers: [UUID: AsyncStream<ServerFrame>.Continuation] = [:]

    /// - Parameters:
    ///   - configuration: how to reach the host, and how patient to be.
    ///   - makeTransport: produces a fresh socket per connection attempt.
    ///     Injecting this is what makes the client testable without a network.
    public init(
        configuration: Configuration,
        makeTransport: @escaping @Sendable () -> WebSocketTransport = { URLSessionWebSocketTransport() },
    ) {
        self.configuration = configuration
        self.makeTransport = makeTransport
    }

    /// The current lifecycle state.
    public var currentState: State { state }

    // MARK: - Events

    /// A stream of unsolicited frames from the host.
    ///
    /// Each call gets its own stream. The stream finishes when the connection
    /// closes, so a consumer loop ends rather than waiting forever on a socket
    /// that is gone.
    ///
    /// - Returns: the stream.
    public func events() -> AsyncStream<ServerFrame> {
        let id = UUID()
        return AsyncStream { continuation in
            subscribers[id] = continuation
            continuation.onTermination = { [weak self] _ in
                Task { await self?.removeSubscriber(id) }
            }
        }
    }

    private func removeSubscriber(_ id: UUID) {
        subscribers.removeValue(forKey: id)
    }

    // MARK: - Lifecycle

    /// Open the socket and complete the handshake.
    ///
    /// - Returns: the host's welcome frame.
    /// - Throws: when the socket, the handshake or the version check fails.
    @discardableResult
    public func connect() async throws -> WelcomeFrame {
        if let welcome = state.welcome { return welcome }
        state = .connecting

        guard let url = PairingURI.webSocketURL(authority: configuration.authority, secure: configuration.secure) else {
            let error = MizarError(code: "BAD_AUTHORITY", message: "cannot dial \(configuration.authority)")
            state = .failed(error.message)
            throw error
        }

        let socket = makeTransport()
        transport = socket

        do {
            try await socket.connect(url: url)
        } catch {
            state = .failed(String(describing: error))
            throw error
        }

        // Start reading before sending `hello`: the welcome can arrive before
        // the send call returns, and a socket with no reader loses it.
        receiveTask = Task { [weak self] in
            await self?.receiveLoop(socket)
        }

        let hello = ClientFrame.hello(
            id: nil,
            token: configuration.token,
            appVersion: configuration.appVersion,
            deviceModel: configuration.deviceModel,
        )
        do {
            try await socket.send(text: try Self.encode(hello))
        } catch {
            state = .failed(String(describing: error))
            await closeSocket()
            throw error
        }

        return try await awaitHandshake()
    }

    /// Wait for the welcome, tolerating one that already arrived.
    ///
    /// This is a race, not a formality. The read loop starts before `hello` is
    /// sent, so a fast host can deliver the welcome before `connect()` reaches
    /// its suspension point — and resuming a continuation that has not been
    /// stored yet is a silent no-op that hangs the caller forever. Equally, the
    /// socket can close in that window, which would leave the caller suspended
    /// on a connection that is already gone.
    ///
    /// The check-and-store inside the continuation body is atomic because the
    /// body runs synchronously on this actor, with no suspension point between
    /// reading the state and storing the continuation.
    ///
    /// - Returns: the host's welcome.
    private func awaitHandshake() async throws -> WelcomeFrame {
        func settled() -> Result<WelcomeFrame, any Error>? {
            if let welcome = state.welcome { return .success(welcome) }
            if case .failed(let reason) = state {
                return .failure(
                    MizarError(code: "CONNECTION_CLOSED", message: reason, retryable: true),
                )
            }
            return nil
        }

        if let outcome = settled() { return try outcome.get() }

        return try await withCheckedThrowingContinuation { continuation in
            if let outcome = settled() {
                continuation.resume(with: outcome)
            } else {
                handshake = continuation
            }
        }
    }

    /// Close the socket and fail anything still in flight.
    public func disconnect() async {
        await closeSocket()
    }

    /// Retry a failed connection until it succeeds or the task is cancelled.
    ///
    /// - Parameter backoff: the schedule to follow. Reset after each success.
    /// - Throws: `CancellationError` when the surrounding task is cancelled.
    public func connectWithRetry(backoff: Backoff = .standard) async throws {
        var schedule = backoff
        while !Task.isCancelled {
            do {
                try await connect()
                return
            } catch {
                let delay = schedule.nextDelay()
                try await Task.sleep(for: .seconds(delay))
            }
        }
        throw CancellationError()
    }

    // MARK: - Calls

    /// Send one request and await its answer.
    ///
    /// - Parameters:
    ///   - type: the wire method name.
    ///   - payload: the method's arguments, when it takes any.
    /// - Returns: the `result` of the `ok` frame, or `nil` when it carried none.
    /// - Throws: ``MizarError`` for a host-reported failure, or a timeout.
    public func request(_ type: String, payload: JSONValue? = nil) async throws -> JSONValue? {
        let id = UUID().uuidString
        let text = try Self.encode(ClientFrame.request(id: id, type: type, payload: payload))

        return try await withThrowingTaskGroup(of: JSONValue?.self) { group in
            group.addTask { try await self.sendAndAwait(id: id, text: text) }
            group.addTask {
                try await Task.sleep(for: self.configuration.requestTimeout)
                throw MizarError(
                    code: "REQUEST_TIMEOUT",
                    message: "\(type) did not answer in time",
                    retryable: true,
                )
            }

            do {
                let first = try await group.next() ?? nil
                group.cancelAll()
                self.abandon(id, reason: "call settled")
                return first
            } catch {
                group.cancelAll()
                // The waiting branch may still be suspended; resuming it here is
                // what keeps a timed-out call from leaking a task.
                self.abandon(id, reason: String(describing: error))
                throw error
            }
        }
    }

    /// A typed convenience over ``request(_:payload:)``.
    ///
    /// - Parameters:
    ///   - method: the wire method name.
    ///   - payload: the method's arguments.
    ///   - as: the model to decode the result into.
    /// - Returns: the decoded result.
    /// - Throws: ``MizarError`` when the host reported a failure, or a
    ///   `DecodingError` when the shape does not match.
    public func call<Result: Decodable & Sendable>(
        _ method: String,
        payload: JSONValue? = nil,
        as type: Result.Type,
    ) async throws -> Result {
        let value = try await request(method, payload: payload)
        guard let value, value != .null else {
            throw MizarError(
                code: "EMPTY_RESULT",
                message: "\(method) answered without a result",
            )
        }
        return try value.decoded(as: Result.self)
    }

    // MARK: - Internals

    private func sendAndAwait(id: String, text: String) async throws -> JSONValue? {
        try await withCheckedThrowingContinuation { continuation in
            pending[id] = continuation
            Task { [weak self] in
                guard let self else { return }
                do {
                    guard let socket = await self.transport else {
                        throw MizarError(code: "SOCKET_CLOSED", message: "the socket is not open")
                    }
                    try await socket.send(text: text)
                } catch {
                    await self.failPending(id: id, error: error)
                }
            }
        }
    }

    /// Resume a waiting call with a failure, once.
    private func failPending(id: String, error: any Error) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        continuation.resume(throwing: error)
    }

    /// Resume a waiting call with an abandonment error, once.
    private func abandon(_ id: String, reason: String) {
        guard let continuation = pending.removeValue(forKey: id) else { return }
        continuation.resume(
            throwing: MizarError(code: "REQUEST_ABANDONED", message: reason, retryable: true),
        )
    }

    /// Read frames until the socket closes, then tear down.
    private func receiveLoop(_ socket: WebSocketTransport) async {
        var failure: String?
        while !Task.isCancelled {
            do {
                guard let text = try await socket.receive() else { break }
                guard await route(text) else { return }
            } catch {
                if !Task.isCancelled { failure = String(describing: error) }
                break
            }
        }
        guard !Task.isCancelled else { return }
        await handleClosed(reason: failure)
    }

    /// Dispatch one decoded frame.
    ///
    /// - Parameter text: the raw frame body.
    /// - Returns: whether the read loop should continue.
    private func route(_ text: String) async -> Bool {
        let frame: ServerFrame
        do {
            frame = try JSONDecoder().decode(ServerFrame.self, from: Data(text.utf8))
        } catch let error as MizarError {
            // A version mismatch is fatal for this socket: continuing would mean
            // reading fields this build misinterprets. Returning false stops the
            // read loop rather than leaving it reading an abandoned socket.
            await handleClosed(reason: error.message)
            return false
        } catch {
            // A frame that will not decode is not fatal. Dropping one is better
            // than tearing down a working connection over it.
            return true
        }

        switch frame {
        case .welcome(let welcome):
            state = .ready(welcome)
            handshake?.resume(returning: welcome)
            handshake = nil

        case .ok(let id, let result):
            // An answer nobody is waiting for is dropped, not fatal.
            pending.removeValue(forKey: id)?.resume(returning: result)

        case .failure(let error, let id):
            if let id, let continuation = pending.removeValue(forKey: id) {
                continuation.resume(throwing: error)
            } else {
                // An uncorrelated failure — the host refused something the
                // client did not ask for, or a socket-level complaint. Telling
                // subscribers is the only way an operator ever sees it.
                for continuation in subscribers.values {
                    continuation.yield(frame)
                }
            }

        case .event, .unknown:
            for continuation in subscribers.values {
                continuation.yield(frame)
            }
        }
        return true
    }

    /// Fail everything in flight and tell subscribers the stream ended.
    private func handleClosed(reason: String?) async {
        let message = reason ?? "the host closed the connection"
        state = .failed(message)

        if let continuation = handshake {
            handshake = nil
            continuation.resume(
                throwing: MizarError(code: "CONNECTION_CLOSED", message: message, retryable: true),
            )
        }

        for (id, continuation) in pending {
            pending.removeValue(forKey: id)
            continuation.resume(
                throwing: MizarError(code: "CONNECTION_CLOSED", message: message, retryable: true),
            )
        }

        for continuation in subscribers.values {
            continuation.finish()
        }
        subscribers.removeAll()

        transport = nil
    }

    /// Close the socket and fail anything in flight.
    private func closeSocket() async {
        receiveTask?.cancel()
        receiveTask = nil
        let socket = transport
        transport = nil
        await socket?.close()
        await handleClosed(reason: "disconnected")
    }

    private static func encode(_ frame: ClientFrame) throws -> String {
        let data = try JSONEncoder().encode(frame)
        guard let text = String(data: data, encoding: .utf8) else {
            throw MizarError(code: "ENCODE_FAILED", message: "frame was not valid UTF-8")
        }
        return text
    }
}
