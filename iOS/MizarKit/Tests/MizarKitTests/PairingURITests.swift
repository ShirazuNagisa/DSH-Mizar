//
//  PairingURITests.swift
//  MizarKitTests
//
//  The pairing URI is shared with the TypeScript side, so these tests mirror
//  `dsh/test/panel.test.ts` case for case. A disagreement between the two
//  implementations does not surface as an error — it silently dials the wrong
//  host — so both sides are pinned to the same expectations.
//

import Foundation
import Testing
@testable import MizarKit

@Suite("Pairing URI")
struct PairingURITests {
    @Test("round-trips every field")
    func roundTrip() throws {
        let uri = PairingURI.build(
            authority: "100.64.0.1:19390",
            code: "AB2C-D3EF",
            hostName: "shirazu-mac",
            protocolVersion: 1,
        )
        let target = try #require(PairingURI.parse(uri))
        #expect(target.authority == "100.64.0.1:19390")
        #expect(target.code == "AB2C-D3EF")
        #expect(target.hostName == "shirazu-mac")
        #expect(target.protocolVersion == 1)
    }

    @Test("survives an IPv6 authority")
    func ipv6Authority() throws {
        let uri = PairingURI.build(
            authority: "[fd7a:115c:a1e0::1]:19390",
            code: "AB2C-D3EF",
            hostName: "mac",
            protocolVersion: 1,
        )
        let target = try #require(PairingURI.parse(uri))
        #expect(target.authority == "[fd7a:115c:a1e0::1]:19390")
    }

    @Test("survives a host name needing escaping")
    func escapedHostName() throws {
        let uri = PairingURI.build(
            authority: "10.0.0.1:19390",
            code: "AB2C-D3EF",
            hostName: "Shirazu's MacBook Pro",
            protocolVersion: 1,
        )
        let target = try #require(PairingURI.parse(uri))
        #expect(target.hostName == "Shirazu's MacBook Pro")
    }

    @Test("tolerates whitespace from a scanner")
    func scannerWhitespace() throws {
        let uri = PairingURI.build(
            authority: "10.0.0.1:19390",
            code: "AB2C-D3EF",
            hostName: "mac",
            protocolVersion: 1,
        )
        let target = try #require(PairingURI.parse("  \(uri)\n"))
        #expect(target.authority == "10.0.0.1:19390")
    }

    @Test("rejects anything that is not a pairing URI")
    func rejectsForeignInput() {
        // A camera pointed at the wrong QR is a normal event, not an error.
        #expect(PairingURI.parse("https://example.com") == nil)
        #expect(PairingURI.parse("mizar://other?h=x&c=y") == nil)
        #expect(PairingURI.parse("") == nil)
    }

    @Test("rejects a URI missing the host or the code")
    func rejectsIncomplete() {
        #expect(PairingURI.parse("mizar://pair?c=AB2C") == nil)
        #expect(PairingURI.parse("mizar://pair?h=10.0.0.1:19390") == nil)
    }

    @Test("reports a missing or unparsable version as nil rather than a guess")
    func versionTolerance() {
        #expect(PairingURI.parse("mizar://pair?h=h&c=c")?.protocolVersion == nil)
        #expect(PairingURI.parse("mizar://pair?h=h&c=c&v=two")?.protocolVersion == nil)
    }

    @Test("builds the WebSocket URL from the authority")
    func webSocketURL() throws {
        let url = try #require(PairingURI.webSocketURL(authority: "100.64.0.1:19390"))
        #expect(url.absoluteString == "ws://100.64.0.1:19390/mizar/v1/ws")

        let secure = try #require(PairingURI.webSocketURL(authority: "100.64.0.1:19390", secure: true))
        #expect(secure.absoluteString == "wss://100.64.0.1:19390/mizar/v1/ws")
    }

    @Test("builds the HTTP URL from the authority")
    func httpURL() throws {
        let url = try #require(PairingURI.httpURL(authority: "10.0.0.1:19390", path: "/mizar/v1/pair"))
        #expect(url.absoluteString == "http://10.0.0.1:19390/mizar/v1/pair")
    }

    @Test("refuses an authority it cannot dial")
    func refusesBadAuthority() {
        #expect(PairingURI.webSocketURL(authority: "") == nil)
        #expect(PairingURI.webSocketURL(authority: "has spaces") == nil)
    }
}
