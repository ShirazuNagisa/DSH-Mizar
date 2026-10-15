//
//  Diagnosis.swift
//  MizarKit
//
//  Turning a networking failure into something a person can act on.
//
//  The first version of the app showed `String(describing: error)`, which for a
//  URL failure is a page of `Error Domain=NSURLErrorDomain Code=-1001
//  "请求超时。" UserInfo={_kCFStreamErrorCodeKey=-2102, …}`. That is the whole
//  error, faithfully reproduced, and it tells the reader nothing they can do.
//
//  The distinction that matters here is between "there is no route to that
//  address" and "something is there but not answering", because they have
//  completely different fixes and the failure looks the same on screen. A
//  timeout against a tailnet address is almost always the first one: a Mac on a
//  Tailscale network is unreachable from a phone that is not on that same
//  network, and no amount of retrying changes it.
//

import Foundation

/// What a connection failure most likely means.
public enum ConnectionDiagnosis: Sendable, Equatable {
    /// The address is on a tailnet and the peer appears not to be.
    case outsideTailnet(authority: String)
    /// The address is on a tailnet, the peer is on it, but nothing answered.
    case tailnetPeerSilent(authority: String)
    /// Nothing answered and the address is not a tailnet one.
    case silent(authority: String)
    /// No network at all.
    case offline
    /// A name that could not be resolved.
    case unknownHost(authority: String)
    /// Anything else, with whatever the system said.
    case other(detail: String)

    /// A sentence to show the operator.
    ///
    /// Written to name the next action rather than the symptom, because the
    /// symptom is already visible — the screen says it failed.
    public var message: String {
        switch self {
        case .outsideTailnet(let authority):
            return """
            Could not reach \(authority).

            That address is on a Tailscale private network, and this device does \
            not appear to be on it. Open Tailscale on this phone and sign in \
            with the same account as the Mac, then try again.
            """
        case .tailnetPeerSilent(let authority):
            return """
            \(authority) is on your tailnet but did not answer.

            Check that DSH is running on the Mac and that the Mizar panel shows \
            a listening address.
            """
        case .silent(let authority):
            return """
            Nothing answered at \(authority).

            Check that the address is right and that this phone is on the same \
            network as the Mac.
            """
        case .offline:
            return "This device has no network connection."
        case .unknownHost(let authority):
            return """
            Could not find \(authority).

            If you entered it by hand, check it against the pairing code shown \
            on the Mac.
            """
        case .other(let detail):
            return detail
        }
    }
}

extension ConnectionDiagnosis {
    /// Whether an address is in the ranges a tailnet uses.
    ///
    /// Tailscale hands out addresses from the carrier-grade NAT block
    /// `100.64.0.0/10`, and its IPv6 prefix is `fd7a:115c:a1e0::/48`. Both are
    /// constants from Tailscale's own documentation, so recognising them is
    /// reading a spec rather than guessing.
    ///
    /// - Parameter authority: `host:port`, or just a host.
    /// - Returns: whether the host is a tailnet address.
    public static func isTailnet(_ authority: String) -> Bool {
        // An IPv6 literal contains colons of its own, so the prefix is matched
        // before anything tries to strip a port -- otherwise `fd7a:115c:a1e0::1`
        // splits down to `fd7a` and matches nothing. Both the bare and the
        // bracketed forms are accepted, since an authority may be either.
        let raw = authority.lowercased()
        if raw.hasPrefix("fd7a:115c:a1e0:") || raw.hasPrefix("[fd7a:115c:a1e0:") { return true }

        let host = authority.split(separator: ":").first.map(String.init) ?? authority
        let parts = host.split(separator: ".").compactMap { Int($0) }
        guard parts.count == 4, let second = parts.dropFirst().first else { return false }
        // 100.64.0.0/10 means the second octet runs from 64 through 127.
        return parts[0] == 100 && (64...127).contains(second)
    }

    /// Decide what a failure means.
    ///
    /// `URLError.timedOut` is the interesting case and the one that produced
    /// this file: a timeout against a tailnet address means the packets went
    /// nowhere, which is a different problem from a host that is present and not
    /// answering — and only one of the two is fixed by opening an app.
    ///
    /// - Parameters:
    ///   - error: the error the transport threw.
    ///   - authority: the address that was being reached.
    /// - Returns: the diagnosis.
    public static func of(_ error: any Error, authority: String) -> ConnectionDiagnosis {
        guard let urlError = error as? URLError else {
            return .other(detail: error.localizedDescription)
        }
        switch urlError.code {
        case .timedOut:
            // A tailnet address that does not answer is nearly always a peer that
            // is not on the tailnet, because there is no router that knows where
            // to send the packet.
            return isTailnet(authority) ? .outsideTailnet(authority: authority) : .silent(authority: authority)
        case .cannotConnectToHost, .networkConnectionLost:
            return isTailnet(authority)
                ? .tailnetPeerSilent(authority: authority)
                : .silent(authority: authority)
        case .cannotFindHost, .dnsLookupFailed:
            return .unknownHost(authority: authority)
        case .notConnectedToInternet, .dataNotAllowed:
            return .offline
        default:
            return .other(detail: urlError.localizedDescription)
        }
    }
}
