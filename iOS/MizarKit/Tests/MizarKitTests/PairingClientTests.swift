//
//  PairingClientTests.swift
//  MizarKitTests
//
//  Pairing is the only exchange that happens before the operator has any
//  context, so its failures carry the advice, not just the code. These tests pin
//  that: each refusal the host can produce must map to something a person can
//  act on, and the retryable flag must match whether retrying could help.
//

import Foundation
import Testing
@testable import MizarKit

/// An HTTP transport that answers from a script.
struct StubHTTPTransport: HTTPTransport {
    var status: Int = 200
    var body: Data = Data()
    var failure: (any Error)?

    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        if let failure { throw failure }
        let response = HTTPURLResponse(
            url: request.url ?? URL(string: "http://localhost")!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: nil,
        )!
        return (body, response)
    }
}

@Suite("PairingClient")
struct PairingClientTests {
    private func client(status: Int, body: String, failure: (any Error)? = nil) -> PairingClient {
        PairingClient(
            transport: StubHTTPTransport(
                status: status,
                body: Data(body.utf8),
                failure: failure,
            ),
        )
    }

    @Test("reports a listening host")
    func hello() async throws {
        let client = client(
            status: 200,
            body: #"{"hostId":"h1","hostName":"mac","protocolVersion":1,"pairingOpen":true,"paired":false}"#,
        )
        let hello = try await client.hello(authority: "10.0.0.1:19390")
        #expect(hello.hostId == "h1")
        #expect(hello.pairingOpen)
        #expect(!hello.paired)
    }

    @Test("returns a stored-ready pairing")
    func pair() async throws {
        let client = client(
            status: 200,
            body: #"{"deviceToken":"mz_abc","deviceId":"d1","hostId":"h1","hostName":"mac","protocolVersion":1}"#,
        )
        let host = try await client.pair(
            authority: "10.0.0.1:19390",
            code: "AB2C-D3EF",
            deviceName: "iPhone",
            deviceModel: "iPhone 18 Pro",
        )
        #expect(host.deviceToken == "mz_abc")
        #expect(host.hostId == "h1")
        #expect(host.authority == "10.0.0.1:19390")
        #expect(host.deviceId == "d1")
    }

    @Test("turns a wrong code into advice, and does not mark it retryable")
    func wrongCode() async throws {
        let client = client(status: 401, body: #"{"error":"PAIRING_CODE_INVALID"}"#)
        do {
            _ = try await client.pair(authority: "10.0.0.1:19390", code: "0000-0000", deviceName: "x", deviceModel: "y")
            Issue.record("expected a failure")
        } catch let error as MizarError {
            #expect(error.code == "PAIRING_CODE_INVALID")
            #expect(error.message.contains("not right"))
            // Retyping the same wrong code cannot help.
            #expect(!error.retryable)
        }
    }

    @Test("tells the operator to generate a new code when it expired")
    func expiredCode() async throws {
        let client = client(status: 410, body: #"{"error":"PAIRING_CODE_EXPIRED"}"#)
        do {
            _ = try await client.pair(authority: "10.0.0.1:19390", code: "AB2C-D3EF", deviceName: "x", deviceModel: "y")
            Issue.record("expected a failure")
        } catch let error as MizarError {
            #expect(error.code == "PAIRING_CODE_EXPIRED")
            #expect(error.message.contains("expired"))
        }
    }

    @Test("covers an already-used code without revealing which it was")
    func consumedCode() async throws {
        // The host answers PAIRING_CODE_UNKNOWN for both an unknown code and a
        // spent one, on purpose, so the wording has to suit both.
        let client = client(status: 410, body: #"{"error":"PAIRING_CODE_UNKNOWN"}"#)
        do {
            _ = try await client.pair(authority: "10.0.0.1:19390", code: "AB2C-D3EF", deviceName: "x", deviceModel: "y")
            Issue.record("expected a failure")
        } catch let error as MizarError {
            #expect(error.code == "PAIRING_CODE_UNKNOWN")
            #expect(error.message.contains("no longer valid"))
        }
    }

    @Test("marks a rate limit retryable")
    func rateLimited() async throws {
        let client = client(status: 429, body: #"{"error":"RATE_LIMITED"}"#)
        do {
            _ = try await client.pair(authority: "10.0.0.1:19390", code: "AB2C-D3EF", deviceName: "x", deviceModel: "y")
            Issue.record("expected a failure")
        } catch let error as MizarError {
            #expect(error.code == "RATE_LIMITED")
            #expect(error.retryable)
        }
    }

    @Test("explains a refusal that carries no code")
    func unlabelledRefusal() async throws {
        let client = client(status: 404, body: "not found")
        do {
            _ = try await client.hello(authority: "10.0.0.1:19390")
            Issue.record("expected a failure")
        } catch let error as MizarError {
            #expect(error.message.contains("Nothing is listening"))
        }
    }

    @Test("refuses an address it cannot dial before making a request")
    func badAuthority() async throws {
        let client = client(status: 200, body: "{}")
        do {
            _ = try await client.hello(authority: "not a host")
            Issue.record("expected a failure")
        } catch let error as MizarError {
            #expect(error.code == "BAD_AUTHORITY")
        }
    }

    @Test("reports an unreadable response rather than surfacing a decoding error")
    func malformedResponse() async throws {
        let client = client(status: 200, body: "{ not json")
        do {
            _ = try await client.hello(authority: "10.0.0.1:19390")
            Issue.record("expected a failure")
        } catch let error as MizarError {
            #expect(error.code == "MALFORMED_RESPONSE")
            #expect(!error.retryable)
        }
    }

    @Test("propagates a transport failure unchanged")
    func transportFailure() async throws {
        let client = client(
            status: 200,
            body: "{}",
            failure: MizarError(code: "SOCKET_CLOSED", message: "no route"),
        )
        await #expect(throws: MizarError.self) {
            _ = try await client.hello(authority: "10.0.0.1:19390")
        }
    }

    @Test("sends the pairing request as JSON with the code")
    func requestShape() async throws {
        // Captured so the wire shape is asserted somewhere: the host answers 400
        // for a body it cannot parse, which would look like a wrong code.
        final class Capturing: HTTPTransport, @unchecked Sendable {
            var captured: URLRequest?
            func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
                captured = request
                let response = HTTPURLResponse(
                    url: request.url!,
                    statusCode: 200,
                    httpVersion: nil,
                    headerFields: nil,
                )!
                return (
                    Data(#"{"deviceToken":"mz_1","deviceId":"d1","hostId":"h1","hostName":"mac","protocolVersion":1}"#.utf8),
                    response,
                )
            }
        }

        let transport = Capturing()
        let client = PairingClient(transport: transport)
        _ = try await client.pair(
            authority: "10.0.0.1:19390",
            code: "AB2C-D3EF",
            deviceName: "iPhone",
            deviceModel: "iPhone 18 Pro",
        )

        let request = try #require(transport.captured)
        #expect(request.httpMethod == "POST")
        #expect(request.url?.absoluteString == "http://10.0.0.1:19390/mizar/v1/pair")
        #expect(request.value(forHTTPHeaderField: "content-type") == "application/json")

        let body = try #require(request.httpBody)
        let json = try #require(try JSONDecoder().decode(JSONValue.self, from: body))
        #expect(json["code"]?.stringValue == "AB2C-D3EF")
        #expect(json["deviceName"]?.stringValue == "iPhone")
        #expect(json["protocolVersion"]?.intValue == mizarProtocolVersion)
    }
}
