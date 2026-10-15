//
//  DiagnosisTests.swift
//  MizarKitTests
//
//  The failure this exists for: a phone on cellular timing out against a
//  tailnet address, and the app answering with a page of NSError.
//

import Foundation
import Testing
@testable import MizarKit

@Suite("Connection diagnosis")
struct DiagnosisTests {
    @Test("recognises the tailnet IPv4 block")
    func tailnetIPv4() {
        // 100.64.0.0/10, so the second octet runs 64 through 127.
        #expect(ConnectionDiagnosis.isTailnet("100.64.0.1:19390"))
        #expect(ConnectionDiagnosis.isTailnet("100.100.172.14:19390"))
        #expect(ConnectionDiagnosis.isTailnet("100.127.255.254"))
        #expect(!ConnectionDiagnosis.isTailnet("100.63.0.1"))
        #expect(!ConnectionDiagnosis.isTailnet("100.128.0.1"))
        #expect(!ConnectionDiagnosis.isTailnet("192.168.1.5"))
    }

    @Test("recognises the tailnet IPv6 prefix")
    func tailnetIPv6() {
        #expect(ConnectionDiagnosis.isTailnet("fd7a:115c:a1e0::7401:acde"))
        #expect(ConnectionDiagnosis.isTailnet("[fd7a:115c:a1e0::1]:19390"))
        #expect(!ConnectionDiagnosis.isTailnet("fd00::1"))
    }

    @Test("a timeout against a tailnet address means the phone is not on it")
    func timeoutOnTailnet() {
        let error = URLError(.timedOut)
        let diagnosis = ConnectionDiagnosis.of(error, authority: "100.100.172.14:19390")
        #expect(diagnosis == .outsideTailnet(authority: "100.100.172.14:19390"))
        // The message has to name the action, not the symptom.
        #expect(diagnosis.message.contains("Tailscale"))
        #expect(diagnosis.message.contains("100.100.172.14:19390"))
    }

    @Test("a timeout on a LAN address is a different problem with a different fix")
    func timeoutOnLAN() {
        let diagnosis = ConnectionDiagnosis.of(URLError(.timedOut), authority: "192.168.1.5:19390")
        #expect(diagnosis == .silent(authority: "192.168.1.5:19390"))
        // Opening Tailscale would not help here, so it must not be suggested.
        #expect(!diagnosis.message.contains("Tailscale"))
    }

    @Test("a refused connection means the tailnet is fine and the host is not")
    func refusedOnTailnet() {
        let diagnosis = ConnectionDiagnosis.of(
            URLError(.cannotConnectToHost),
            authority: "100.100.172.14:19390",
        )
        #expect(diagnosis == .tailnetPeerSilent(authority: "100.100.172.14:19390"))
        #expect(diagnosis.message.contains("DSH is running"))
    }

    @Test("no network is reported as no network")
    func offline() {
        #expect(ConnectionDiagnosis.of(URLError(.notConnectedToInternet), authority: "x") == .offline)
        #expect(ConnectionDiagnosis.of(URLError(.dataNotAllowed), authority: "x") == .offline)
    }

    @Test("an unresolvable name is reported as one")
    func unknownHost() {
        let diagnosis = ConnectionDiagnosis.of(URLError(.cannotFindHost), authority: "nope.local:1")
        #expect(diagnosis == .unknownHost(authority: "nope.local:1"))
        #expect(diagnosis.message.contains("nope.local:1"))
    }

    @Test("an unrelated error keeps the system's own words")
    func other() {
        struct Boom: LocalizedError { var errorDescription: String? { "something specific" } }
        #expect(ConnectionDiagnosis.of(Boom(), authority: "x") == .other(detail: "something specific"))
    }

    @Test("never shows a raw NSError dump")
    func noRawDump() {
        // The original bug: the screen showed the whole UserInfo dictionary.
        for authority in ["100.100.172.14:19390", "192.168.1.5:19390", "nope.local:1"] {
            let message = ConnectionDiagnosis.of(URLError(.timedOut), authority: authority).message
            #expect(!message.contains("UserInfo"))
            #expect(!message.contains("_kCFStreamErrorCodeKey"))
            #expect(!message.contains("NSURLErrorDomain"))
        }
    }
}
