//
//  PairingURI.swift
//  MizarKit
//
//  The pairing URI the QR code carries.
//
//  Mirrors `dsh/src/protocol/pairing-uri.ts`. The two must agree byte for byte:
//  the panel renders this string and the app parses it, and any disagreement
//  silently produces a wrong host rather than an error.
//
//  `h` is an authority, not a URL — it carries no scheme, so the app decides
//  whether to speak `ws://` or `wss://`. An IPv6 literal is bracketed.
//

import Foundation

/// A decoded pairing URI.
public struct PairingTarget: Sendable, Equatable {
    /// `host:port` the app should dial.
    public let authority: String
    /// The pairing code, in display form.
    public let code: String
    /// The host's display name, when it was included.
    public let hostName: String?
    /// The protocol version the host speaks, when it was included.
    public let protocolVersion: Int?

    public init(authority: String, code: String, hostName: String? = nil, protocolVersion: Int? = nil) {
        self.authority = authority
        self.code = code
        self.hostName = hostName
        self.protocolVersion = protocolVersion
    }
}

/// Parsing and building for the `mizar://` pairing URI.
public enum PairingURI {
    /// The custom scheme.
    public static let scheme = "mizar"

    /// The full prefix, scheme and host part.
    public static let prefix = "mizar://pair"

    /// Build the URI a QR code carries.
    ///
    /// - Parameters:
    ///   - authority: `host:port`, already bracketed for IPv6.
    ///   - code: the pairing code.
    ///   - hostName: the host's display name.
    ///   - protocolVersion: the protocol version the host speaks.
    /// - Returns: the URI.
    public static func build(
        authority: String,
        code: String,
        hostName: String,
        protocolVersion: Int,
    ) -> String {
        var components = URLComponents()
        components.queryItems = [
            URLQueryItem(name: "h", value: authority),
            URLQueryItem(name: "c", value: code),
            URLQueryItem(name: "n", value: hostName),
            URLQueryItem(name: "v", value: String(protocolVersion)),
        ]
        return "\(prefix)?\(components.percentEncodedQuery ?? "")"
    }

    /// Parse a pairing URI.
    ///
    /// Returns `nil` rather than throwing for anything unrecognised. A scanned
    /// code is untrusted input from a camera, and a different QR in front of the
    /// lens is a normal thing to encounter, not an error worth surfacing.
    ///
    /// - Parameter input: the scanned text.
    /// - Returns: the target, or `nil`.
    public static func parse(_ input: String) -> PairingTarget? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("\(prefix)?") else { return nil }

        let query = String(trimmed.dropFirst(prefix.count + 1))
        guard let components = URLComponents(string: "?\(query)") else { return nil }

        func value(_ name: String) -> String? {
            components.queryItems?
                .first { $0.name == name }?
                .value?
                .trimmingCharacters(in: .whitespaces)
        }

        guard let authority = value("h"), !authority.isEmpty,
              let code = value("c"), !code.isEmpty
        else { return nil }

        return PairingTarget(
            authority: authority,
            code: code,
            hostName: value("n"),
            protocolVersion: value("v").flatMap(Int.init),
        )
    }

    /// Build a URL for one authority.
    ///
    /// `URL(string:)` accepts far more than it should here: `ws:///path` is a
    /// perfectly valid URL with an *empty* host, so a blank or malformed
    /// authority would produce something that looks dialable and fails later
    /// with a confusing transport error. The host is checked explicitly.
    ///
    /// - Parameters:
    ///   - authority: `host:port`.
    ///   - path: the path to append.
    ///   - scheme: the scheme to use.
    /// - Returns: the URL, or `nil` when the authority is unusable.
    public static func url(authority: String, path: String, scheme: String) -> URL? {
        let trimmed = authority.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty,
              let url = URL(string: "\(scheme)://\(trimmed)\(path)"),
              let host = url.host(), !host.isEmpty
        else { return nil }
        return url
    }

    /// Build the WebSocket URL for a target.
    ///
    /// - Parameters:
    ///   - authority: `host:port`.
    ///   - secure: whether to use `wss`.
    /// - Returns: the URL, or `nil` when the authority is unusable.
    public static func webSocketURL(authority: String, secure: Bool = false) -> URL? {
        url(authority: authority, path: mizarWebSocketPath, scheme: secure ? "wss" : "ws")
    }

    /// Build the HTTP URL for a target.
    ///
    /// - Parameters:
    ///   - authority: `host:port`.
    ///   - path: the path to append.
    ///   - secure: whether to use `https`.
    /// - Returns: the URL, or `nil` when the authority is unusable.
    public static func httpURL(authority: String, path: String, secure: Bool = false) -> URL? {
        url(authority: authority, path: path, scheme: secure ? "https" : "http")
    }
}
