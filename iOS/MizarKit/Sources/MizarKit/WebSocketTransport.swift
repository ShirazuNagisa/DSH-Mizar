//
//  WebSocketTransport.swift
//  MizarKit
//
//  The socket, behind a protocol.
//
//  `URLSessionWebSocketTask` cannot be used in a unit test — there is no host to
//  connect to — so the connection logic is written against this protocol and the
//  tests drive it with a scripted stub. That keeps reconnection, correlation and
//  frame routing under test without a network.
//

import Foundation

/// A minimal text WebSocket.
public protocol WebSocketTransport: Sendable {
    /// Open the socket.
    /// - Parameter url: the endpoint to dial.
    /// - Throws: when the handshake fails.
    func connect(url: URL) async throws

    /// Send one text frame.
    /// - Parameter text: the frame body.
    /// - Throws: when the socket is not open.
    func send(text: String) async throws

    /// Await the next text frame.
    /// - Returns: the frame body, or `nil` when the peer closed the socket.
    /// - Throws: on a transport failure.
    func receive() async throws -> String?

    /// Close the socket.
    func close() async
}

/// The real transport.
public actor URLSessionWebSocketTransport: WebSocketTransport {
    private let session: URLSession
    private var task: URLSessionWebSocketTask?

    /// The host owns the heartbeat: it pings on an interval and terminates a
    /// peer that misses one, and `URLSessionWebSocketTask` answers at the
    /// protocol layer without any code here. So there is nothing to send.
    ///
    /// - Parameter timeout: how long the handshake may take.
    public init(timeout: TimeInterval = 20) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        self.session = URLSession(configuration: configuration)
    }

    public func connect(url: URL) async throws {
        let task = session.webSocketTask(with: url)
        self.task = task
        task.resume()
    }

    public func send(text: String) async throws {
        guard let task else {
            throw MizarError(code: "SOCKET_CLOSED", message: "the socket is not open")
        }
        try await task.send(.string(text))
    }

    public func receive() async throws -> String? {
        guard let task else { return nil }
        let message = try await task.receive()
        switch message {
        case .string(let text):
            return text
        case .data(let data):
            return String(data: data, encoding: .utf8)
        @unknown default:
            return nil
        }
    }

    public func close() async {
        task?.cancel(with: .normalClosure, reason: nil)
        task = nil
    }
}
