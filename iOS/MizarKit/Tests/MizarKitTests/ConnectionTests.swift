//
//  ConnectionTests.swift
//  MizarKitTests
//
//  The client's behaviour against a scripted socket.
//
//  These cover the paths that only appear when something goes wrong: a host that
//  answers with a failure, a host that stops answering, a frame from a future
//  version, and a socket that closes mid-call. Those are the paths a phone on a
//  mobile network actually spends its time in, and the ones least likely to be
//  noticed by hand.
//

import Foundation
import Testing
@testable import MizarKit

/// Build a responder that answers by frame type.
private func responder(
    onRequest: @escaping @Sendable (String) -> String? = { _ in nil },
) -> StubTransport.Responder {
    { text in
        guard let type = frameType(of: text) else { return [] }
        if type == "hello" { return [welcomeFrame()] }
        let id = correlationId(of: text) ?? ""
        if let answer = onRequest(id) { return [answer] }
        return [okFrame(id: id, result: json(["echo": .string(type)]))]
    }
}

/// Drive a responder that answers only the request types it is told about.
///
/// Anything else is left unanswered on purpose: "the host never replies" is a
/// state several tests need to reach, and a catch-all reply here would make
/// those tests pass for the wrong reason — which is exactly what happened the
/// first time this helper was written.
private func responderAnswering(_ answer: @escaping @Sendable (String) -> String?) -> StubTransport.Responder {
    { text in
        guard let type = frameType(of: text) else { return [] }
        if type == "hello" { return [welcomeFrame()] }
        guard let frame = answer(type) else { return [] }
        let id = correlationId(of: text) ?? ""
        return [frame.replacingOccurrences(of: "$ID", with: id)]
    }
}

@Suite("MizarConnection")
struct ConnectionTests {
    private func makeConnection(
        transport: StubTransport,
        timeout: Duration = .seconds(5),
    ) -> MizarConnection {
        MizarConnection(
            configuration: .init(authority: "127.0.0.1:19390", token: "mz_test", requestTimeout: timeout),
            makeTransport: { transport },
        )
    }

    @Test("completes the handshake and reports the welcome")
    func handshake() async throws {
        let transport = StubTransport(responder: responder())
        let connection = makeConnection(transport: transport)

        let welcome = try await connection.connect()
        #expect(welcome.hostId == "host-1")
        #expect(welcome.hostName == "mac")
        #expect(await connection.currentState.welcome != nil)

        let dialed = await transport.dialed
        #expect(dialed.first?.absoluteString == "ws://127.0.0.1:19390/mizar/v1/ws")
    }

    @Test("sends hello with the token before anything else")
    func sendsHelloFirst() async throws {
        let transport = StubTransport(responder: responder())
        let connection = makeConnection(transport: transport)
        _ = try await connection.connect()

        let sent = await transport.sent
        #expect(frameType(of: sent[0]) == "hello")
        let hello = try #require(try JSONDecoder().decode(JSONValue.self, from: Data(sent[0].utf8)))
        #expect(hello["token"]?.stringValue == "mz_test")
        #expect(hello["protocolVersion"]?.intValue == mizarProtocolVersion)
    }

    @Test("correlates a response to its request")
    func requestCorrelation() async throws {
        let transport = StubTransport(responder: responderAnswering { type in
            type == "host.info" ? okFrame(id: "$ID", result: json(["hostId": .string("h1")])) : nil
        })
        let connection = makeConnection(transport: transport)
        _ = try await connection.connect()

        let result = try await connection.request("host.info")
        #expect(result?["hostId"]?.stringValue == "h1")
    }

    @Test("decodes a typed result")
    func typedCall() async throws {
        let transport = StubTransport(responder: responderAnswering { type in
            type == "host.info"
                ? okFrame(id: "$ID", result: json([
                    "hostId": .string("h1"),
                    "hostName": .string("studio"),
                    "home": .string("/home/dsh"),
                    "protocolVersion": .number(1),
                ]))
                : nil
        })
        let connection = makeConnection(transport: transport)
        _ = try await connection.connect()

        let info = try await connection.call("host.info", as: HostInfo.self)
        #expect(info.hostId == "h1")
        #expect(info.hostName == "studio")
    }

    @Test("surfaces a host failure as a coded error")
    func hostFailure() async throws {
        let transport = StubTransport(responder: responderAnswering { type in
            type == "session.create" ? errorFrame(code: "WRITER_HELD", message: "busy", id: "$ID") : nil
        })
        let connection = makeConnection(transport: transport)
        _ = try await connection.connect()

        await #expect(throws: MizarError.self) {
            _ = try await connection.request("session.create")
        }
        do {
            _ = try await connection.request("session.create")
            Issue.record("expected a failure")
        } catch let error as MizarError {
            #expect(error.known == .writerHeld)
            #expect(!error.requiresRepairing)
        }
    }

    @Test("delivers unsolicited events to subscribers")
    func events() async throws {
        let transport = StubTransport(responder: responder())
        let connection = makeConnection(transport: transport)
        _ = try await connection.connect()

        let stream = await connection.events()
        await transport.push(eventFrame(name: "approval.request", data: json(["requestId": .string("ap-1")])))

        var iterator = stream.makeAsyncIterator()
        let frame = try #require(await iterator.next())
        guard case .event(let name, let data) = frame else {
            Issue.record("expected an event")
            return
        }
        #expect(name == "approval.request")
        #expect(data["requestId"]?.stringValue == "ap-1")
    }

    @Test("keeps the connection alive across a frame type it does not know")
    func unknownFramesAreNotFatal() async throws {
        let transport = StubTransport(responder: responderAnswering { type in
            type == "host.info" ? okFrame(id: "$ID", result: json(["hostId": .string("h1")])) : nil
        })
        let connection = makeConnection(transport: transport)
        _ = try await connection.connect()

        // A frame from a newer host, then a normal call.
        await transport.push(serverFrame([
            "v": .number(Double(mizarProtocolVersion)),
            "type": .string("brand.new.frame"),
            "anything": .string("preserved"),
        ]))

        let result = try await connection.request("host.info")
        #expect(result?["hostId"]?.stringValue == "h1")
    }

    @Test("ignores a frame that will not decode instead of dropping the socket")
    func undecodableFramesAreNotFatal() async throws {
        let transport = StubTransport(responder: responderAnswering { type in
            type == "host.info" ? okFrame(id: "$ID", result: json(["hostId": .string("h1")])) : nil
        })
        let connection = makeConnection(transport: transport)
        _ = try await connection.connect()

        await transport.push("{ not json at all")
        let result = try await connection.request("host.info")
        #expect(result?["hostId"]?.stringValue == "h1")
    }

    @Test("fails in-flight calls when the socket closes")
    func closeFailsInFlight() async throws {
        let transport = StubTransport(responder: responderAnswering { _ in nil })
        let connection = makeConnection(transport: transport)
        _ = try await connection.connect()

        let call = Task { try await connection.request("never.answers") }
        // Let the call reach its suspension point before closing.
        _ = await eventually { await transport.sent.count >= 2 }
        await transport.pushClose()

        do {
            _ = try await call.value
            Issue.record("expected the call to fail")
        } catch let error as MizarError {
            #expect(error.retryable)
        } catch {
            Issue.record("expected a MizarError, got \(error)")
        }
    }

    @Test("finishes event streams when the socket closes")
    func closeFinishesStreams() async throws {
        let transport = StubTransport(responder: responder())
        let connection = makeConnection(transport: transport)
        _ = try await connection.connect()

        let stream = await connection.events()
        await transport.pushClose()

        var iterator = stream.makeAsyncIterator()
        // The stream ends rather than waiting forever on a socket that is gone.
        let value = await iterator.next()
        #expect(value == nil)
    }

    @Test("times a request out rather than waiting forever")
    func requestTimeout() async throws {
        let transport = StubTransport(responder: responderAnswering { _ in nil })
        let connection = makeConnection(transport: transport, timeout: .milliseconds(120))
        _ = try await connection.connect()

        do {
            _ = try await connection.request("never.answers")
            Issue.record("expected a timeout")
        } catch let error as MizarError {
            #expect(error.code == "REQUEST_TIMEOUT")
            #expect(error.retryable)
        }
    }

    @Test("fails a connect whose socket closes before the welcome")
    func closeBeforeWelcome() async throws {
        // The race this guards: the read loop starts before `hello` is sent, so
        // the socket can close before `connect()` reaches its suspension point.
        // Handling only the post-suspension case would leave the caller waiting
        // on a connection that is already gone.
        let transport = StubTransport(responder: { _ in [] })
        let connection = makeConnection(transport: transport, timeout: .milliseconds(200))

        let task = Task { try await connection.connect() }
        _ = await eventually { await transport.sent.count >= 1 }
        await transport.pushClose()

        do {
            _ = try await task.value
            Issue.record("expected the handshake to fail")
        } catch let error as MizarError {
            #expect(error.code == "CONNECTION_CLOSED" || error.code == "REQUEST_TIMEOUT")
            #expect(error.retryable)
        }
    }

    @Test("propagates a dial failure")
    func dialFailure() async throws {
        let transport = StubTransport(responder: responder())
        await transport.failConnect(with: MizarError(code: "SOCKET_CLOSED", message: "refused"))
        let connection = makeConnection(transport: transport)

        await #expect(throws: MizarError.self) {
            _ = try await connection.connect()
        }
    }

    @Test("refuses to dial an authority it cannot parse")
    func badAuthority() async throws {
        let transport = StubTransport(responder: responder())
        let connection = MizarConnection(
            configuration: .init(authority: "not a host", token: "mz_test"),
            makeTransport: { transport },
        )
        do {
            _ = try await connection.connect()
            Issue.record("expected a failure")
        } catch let error as MizarError {
            #expect(error.code == "BAD_AUTHORITY")
        }
        #expect(await transport.dialed.isEmpty)
    }

    @Test("retry reconnects until the host answers")
    func retrySucceeds() async throws {
        // Fail the first dial, then let the second succeed.
        let flaky = FlakyTransport(failuresBeforeSuccess: 1)
        let connection = MizarConnection(
            configuration: .init(authority: "127.0.0.1:19390", token: "mz_test"),
            makeTransport: { flaky },
        )
        try await connection.connectWithRetry(backoff: Backoff(steps: [0.01], jitter: 0))
        #expect(await connection.currentState.welcome != nil)
        #expect(await flaky.attempts == 2)
    }
}

/// A transport that refuses its first dials, for the retry test.
actor FlakyTransport: WebSocketTransport {
    private let failuresBeforeSuccess: Int
    private(set) var attempts = 0
    private var queue: [String?] = []
    private var waiting: [CheckedContinuation<String?, any Error>] = []

    init(failuresBeforeSuccess: Int) {
        self.failuresBeforeSuccess = failuresBeforeSuccess
    }

    func connect(url: URL) async throws {
        attempts += 1
        if attempts <= failuresBeforeSuccess {
            throw MizarError(code: "SOCKET_CLOSED", message: "refused", retryable: true)
        }
    }

    func send(text: String) async throws {
        guard frameType(of: text) == "hello" else { return }
        queue.append(welcomeFrame())
        while let waiter = waiting.first, let next = queue.first {
            waiting.removeFirst()
            queue.removeFirst()
            waiter.resume(returning: next)
        }
    }

    func receive() async throws -> String? {
        if !queue.isEmpty { return queue.removeFirst() }
        return try await withCheckedThrowingContinuation { continuation in
            waiting.append(continuation)
        }
    }

    func close() async {
        for waiter in waiting { waiter.resume(returning: nil) }
        waiting.removeAll()
    }
}
