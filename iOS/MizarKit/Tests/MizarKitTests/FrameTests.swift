//
//  FrameTests.swift
//  MizarKitTests
//
//  The wire contract. The cases that matter most are the tolerant ones: a host
//  newer than this build must not be able to break the socket, and a failure the
//  app does not recognise must still be classifiable.
//

import Foundation
import Testing
@testable import MizarKit

@Suite("Server frames")
struct ServerFrameTests {
    private func decode(_ text: String) throws -> ServerFrame {
        try JSONDecoder().decode(ServerFrame.self, from: Data(text.utf8))
    }

    @Test("decodes a welcome")
    func welcome() throws {
        guard case .welcome(let frame) = try decode(welcomeFrame(hostId: "h1", hostName: "studio")) else {
            Issue.record("expected a welcome")
            return
        }
        #expect(frame.hostId == "h1")
        #expect(frame.hostName == "studio")
        #expect(frame.protocolVersion == mizarProtocolVersion)
        #expect(frame.deviceId == "device-1")
    }

    @Test("decodes an ok frame with and without a result")
    func okFrames() throws {
        guard case .ok(let id, let result) = try decode(okFrame(id: "r1", result: json(["a": .number(1)]))) else {
            Issue.record("expected an ok")
            return
        }
        #expect(id == "r1")
        #expect(result?["a"]?.intValue == 1)

        guard case .ok(let bareId, let absent) = try decode(okFrame(id: "r2")) else {
            Issue.record("expected an ok")
            return
        }
        #expect(bareId == "r2")
        #expect(absent == nil)
    }

    @Test("decodes an error with and without a correlation id")
    func errorFrames() throws {
        guard case .failure(let error, let id) = try decode(errorFrame(code: "WRITER_HELD", id: "r1")) else {
            Issue.record("expected a failure")
            return
        }
        #expect(error.code == "WRITER_HELD")
        #expect(error.known == .writerHeld)
        #expect(id == "r1")

        guard case .failure(_, let unsolicitedId) = try decode(errorFrame(code: "INTERNAL")) else {
            Issue.record("expected a failure")
            return
        }
        #expect(unsolicitedId == nil)
    }

    @Test("decodes an event")
    func event() throws {
        guard case .event(let name, let data) = try decode(
            eventFrame(name: "approval.request", data: json(["requestId": .string("ap-1")])),
        ) else {
            Issue.record("expected an event")
            return
        }
        #expect(name == "approval.request")
        #expect(data["requestId"]?.stringValue == "ap-1")
    }

    @Test("preserves a frame type it does not know instead of failing")
    func unknownFrameType() throws {
        // A host newer than this build must not make the socket unparseable.
        let text = serverFrame([
            "v": .number(Double(mizarProtocolVersion)),
            "type": .string("something.new"),
            "payload": .string("kept"),
        ])
        guard case .unknown(let type, let payload) = try decode(text) else {
            Issue.record("expected an unknown frame")
            return
        }
        #expect(type == "something.new")
        #expect(payload["payload"]?.stringValue == "kept")
    }

    @Test("rejects a frame from an incompatible protocol version")
    func versionMismatch() {
        let text = serverFrame([
            "v": .number(2),
            "type": .string("ok"),
            "id": .string("r1"),
        ])
        #expect(throws: MizarError.self) { try decode(text) }
    }

    @Test("reports the correlation id only where one exists")
    func correlationIds() throws {
        #expect(try decode(okFrame(id: "r1")).correlationId == "r1")
        #expect(try decode(errorFrame(code: "INTERNAL", id: "r2")).correlationId == "r2")
        #expect(try decode(welcomeFrame()).correlationId == nil)
        #expect(try decode(eventFrame(name: "x")).correlationId == nil)
    }
}

@Suite("Client frames")
struct ClientFrameTests {
    private func encode(_ frame: ClientFrame) throws -> [String: JSONValue] {
        let data = try JSONEncoder().encode(frame)
        return try #require(try JSONDecoder().decode(JSONValue.self, from: data).objectValue)
    }

    @Test("encodes hello with its optional metadata")
    func hello() throws {
        let members = try encode(
            .hello(id: nil, token: "mz_x", appVersion: "0.1.0", deviceModel: "iPhone 18 Pro"),
        )
        #expect(members["v"]?.intValue == mizarProtocolVersion)
        #expect(members["type"]?.stringValue == "hello")
        #expect(members["token"]?.stringValue == "mz_x")
        #expect(members["appVersion"]?.stringValue == "0.1.0")
        #expect(members["deviceModel"]?.stringValue == "iPhone 18 Pro")
        #expect(members["protocolVersion"]?.intValue == mizarProtocolVersion)
    }

    @Test("omits absent hello metadata rather than sending null")
    func helloWithoutMetadata() throws {
        let members = try encode(.hello(id: nil, token: "mz_x", appVersion: nil, deviceModel: nil))
        #expect(members["appVersion"] == nil)
        #expect(members["deviceModel"] == nil)
        #expect(members["id"] == nil)
    }

    @Test("encodes a request with and without a payload")
    func request() throws {
        let withPayload = try encode(
            .request(id: "r1", type: "session.stats", payload: json(["sessionId": .string("s1")])),
        )
        #expect(withPayload["id"]?.stringValue == "r1")
        #expect(withPayload["type"]?.stringValue == "session.stats")
        #expect(withPayload["payload"]?["sessionId"]?.stringValue == "s1")

        let bare = try encode(.request(id: "r2", type: "ping", payload: nil))
        #expect(bare["id"]?.stringValue == "r2")
        #expect(bare["payload"] == nil)
    }
}

@Suite("MizarError")
struct MizarErrorTests {
    @Test("recognises the codes this build knows")
    func knownCodes() {
        #expect(MizarError(code: "WRITER_HELD", message: "").known == .writerHeld)
        #expect(MizarError(code: "MODEL_UNAVAILABLE", message: "").known == .modelUnavailable)
        #expect(MizarError(code: "INTERNAL", message: "").known == .internalError)
    }

    @Test("keeps a code from a newer host without claiming to know it")
    func unknownCode() {
        // Classifying an unknown code as a decoding failure would make a newer
        // host unusable rather than merely less helpful.
        let error = MizarError(code: "SOMETHING_NEW", message: "from the future")
        #expect(error.known == nil)
        #expect(error.code == "SOMETHING_NEW")
        #expect(error.message == "from the future")
    }

    @Test("tells the app when repairing is the only way forward")
    func repairingIsRequired() {
        #expect(MizarError(code: "UNAUTHENTICATED", message: "").requiresRepairing)
        #expect(MizarError(code: "DEVICE_REVOKED", message: "").requiresRepairing)
        // A busy session is retryable and must not send the operator back to pairing.
        #expect(!MizarError(code: "WRITER_HELD", message: "").requiresRepairing)
        #expect(!MizarError(code: "REQUEST_TIMEOUT", message: "").requiresRepairing)
    }
}

@Suite("JSONValue")
struct JSONValueTests {
    @Test("chained reads are safe at every step")
    func chainedReads() throws {
        let value = json(["a": json(["b": json(["c": .string("found")])])])
        #expect(value["a"]?["b"]?["c"]?.stringValue == "found")
        // Any missing link yields nil instead of trapping.
        #expect(value["a"]?["missing"]?["c"] == nil)
        #expect(value["nope"]?["b"] == nil)
        // Indexing a non-object is nil, not a crash.
        #expect(JSONValue.string("x")["a"] == nil)
    }

    @Test("round-trips into a typed model")
    func typedDecoding() throws {
        struct Row: Decodable { let sessionId: String; let running: Bool }
        let value = json(["sessionId": .string("s1"), "running": .bool(true)])
        let row = try value.decoded(as: Row.self)
        #expect(row.sessionId == "s1")
        #expect(row.running)
    }

    @Test("distinguishes an integral number from a fractional one")
    func numberNarrowing() {
        #expect(JSONValue.number(3).intValue == 3)
        #expect(JSONValue.number(3.5).intValue == nil)
        #expect(JSONValue.string("3").intValue == nil)
    }
}
