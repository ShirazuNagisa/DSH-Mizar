//
//  TestSupport.swift
//  MizarKitTests
//
//  A scripted socket.
//
//  `URLSessionWebSocketTask` cannot be exercised in a unit test, so reconnection,
//  correlation and frame routing would otherwise be untested. The stub answers
//  each outgoing frame with whatever the test's responder returns, which is
//  enough to drive every path through the client including failures.
//

import Foundation
@testable import MizarKit

/// A WebSocket that answers from a script instead of a network.
actor StubTransport: WebSocketTransport {
    /// Produces the frames to enqueue in response to one outgoing frame.
    typealias Responder = @Sendable (String) -> [String]

    private let responder: Responder
    private var queued: [String?] = []
    private var waiting: [CheckedContinuation<String?, any Error>] = []
    private var closed = false
    private var connectFailure: (any Error)?

    /// Every frame this socket was asked to send.
    private(set) var sent: [String] = []
    /// URLs this socket was asked to dial.
    private(set) var dialed: [URL] = []
    /// Whether ``close()`` was called.
    private(set) var didClose = false

    init(responder: @escaping Responder = { _ in [] }) {
        self.responder = responder
    }

    /// Make the next ``connect(url:)`` fail.
    func failConnect(with error: any Error) {
        connectFailure = error
    }

    /// Push a frame as if the host sent it.
    func push(_ text: String?) {
        if let waiter = waiting.first {
            waiting.removeFirst()
            waiter.resume(returning: text)
        } else {
            queued.append(text)
        }
    }

    /// End the stream as if the host closed the socket.
    func pushClose() {
        push(nil)
    }

    func connect(url: URL) async throws {
        dialed.append(url)
        if let connectFailure { throw connectFailure }
    }

    func send(text: String) async throws {
        sent.append(text)
        for frame in responder(text) {
            push(frame)
        }
    }

    func receive() async throws -> String? {
        if !queued.isEmpty {
            return queued.removeFirst()
        }
        if closed {
            return nil
        }
        return try await withCheckedThrowingContinuation { continuation in
            waiting.append(continuation)
        }
    }

    func close() async {
        didClose = true
        closed = true
        for waiter in waiting {
            waiter.resume(returning: nil)
        }
        waiting.removeAll()
    }
}

// MARK: - Frame builders

/// A JSON object literal as a `JSONValue`, for readability in tests.
func json(_ members: [String: JSONValue]) -> JSONValue {
    .object(members)
}

/// Serialise a server frame to wire text.
func serverFrame(_ members: [String: JSONValue]) -> String {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    // `JSONValue` is `Encodable`, so the whole object round-trips.
    let data = try! encoder.encode(JSONValue.object(members))
    return String(data: data, encoding: .utf8)!
}

/// A `welcome` frame.
func welcomeFrame(hostId: String = "host-1", hostName: String = "mac", version: Int = 1) -> String {
    serverFrame([
        "v": .number(Double(version)),
        "type": .string("welcome"),
        "hostId": .string(hostId),
        "hostName": .string(hostName),
        "protocolVersion": .number(Double(version)),
        "home": .string("/home/dsh"),
        "deviceId": .string("device-1"),
    ])
}

/// An `ok` frame carrying a result.
func okFrame(id: String, result: JSONValue? = nil) -> String {
    var members: [String: JSONValue] = [
        "v": .number(Double(mizarProtocolVersion)),
        "type": .string("ok"),
        "id": .string(id),
    ]
    if let result { members["result"] = result }
    return serverFrame(members)
}

/// An `error` frame.
func errorFrame(code: String, message: String = "nope", id: String? = nil) -> String {
    var members: [String: JSONValue] = [
        "v": .number(Double(mizarProtocolVersion)),
        "type": .string("error"),
        "code": .string(code),
        "message": .string(message),
        "retryable": .bool(false),
    ]
    if let id { members["id"] = .string(id) }
    return serverFrame(members)
}

/// An unsolicited `event` frame.
func eventFrame(name: String, data: JSONValue = .null) -> String {
    serverFrame([
        "v": .number(Double(mizarProtocolVersion)),
        "type": .string("event"),
        "event": .string(name),
        "data": data,
    ])
}

/// Extract the correlation id from an outgoing request frame.
func correlationId(of sentFrame: String) -> String? {
    guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(sentFrame.utf8)) else {
        return nil
    }
    return value["id"]?.stringValue
}

/// Extract the `type` from an outgoing frame.
func frameType(of sentFrame: String) -> String? {
    guard let value = try? JSONDecoder().decode(JSONValue.self, from: Data(sentFrame.utf8)) else {
        return nil
    }
    return value["type"]?.stringValue
}

/// Wait for a condition, polling briefly.
///
/// Used where a test needs to observe an effect that lands on another actor
/// rather than awaiting a specific value.
///
/// - Parameters:
///   - timeout: how long to keep trying, in seconds.
///   - condition: the predicate to satisfy.
/// - Returns: whether the condition became true.
@discardableResult
func eventually(
    timeout: Double = 2,
    _ condition: @Sendable () async -> Bool,
) async -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return true }
        try? await Task.sleep(for: .milliseconds(5))
    }
    return await condition()
}
