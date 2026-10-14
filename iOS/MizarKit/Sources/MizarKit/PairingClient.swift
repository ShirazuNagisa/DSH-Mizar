//
//  PairingClient.swift
//  MizarKit
//
//  The one unauthenticated exchange.
//
//  Pairing is the only moment the app talks to the host without a credential,
//  so it is also the only place a failure message reaches the operator before
//  they have any context. The errors below therefore carry what the code means,
//  not just the code: "the code has expired" is actionable, `410` is not.
//
//  The host answers a pairing attempt with a specific code rather than a bare
//  status — `PAIRING_CODE_INVALID`, `PAIRING_CODE_EXPIRED`, `PAIRING_CODE_UNKNOWN`,
//  `RATE_LIMITED` — and each maps to different advice, so they are preserved
//  rather than collapsed into "pairing failed".
//

import Foundation

/// The HTTP surface pairing needs.
public protocol HTTPTransport: Sendable {
    /// Perform one request.
    /// - Parameter request: the request to send.
    /// - Returns: the body and the response.
    func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse)
}

/// The real transport.
public struct URLSessionHTTPTransport: HTTPTransport {
    private let session: URLSession

    public init(timeout: TimeInterval = 30) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = timeout
        self.session = URLSession(configuration: configuration)
    }

    public func data(for request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw MizarError(code: "NOT_HTTP", message: "the host did not answer over HTTP")
        }
        return (data, http)
    }
}

/// The pairing conversation.
public struct PairingClient: Sendable {
    private let transport: any HTTPTransport

    /// - Parameter transport: how to reach the host; injectable for tests.
    public init(transport: any HTTPTransport = URLSessionHTTPTransport()) {
        self.transport = transport
    }

    /// Ask an unauthenticated host who it is.
    ///
    /// Used before pairing to confirm something is listening and to check
    /// whether a code is outstanding, so a wrong address fails with "nothing is
    /// listening there" rather than a confusing pairing error.
    ///
    /// - Parameter authority: `host:port`.
    /// - Returns: the host's identity.
    public func hello(authority: String) async throws -> HelloResponse {
        let url = try requireURL(authority: authority, path: "\(mizarHTTPPrefix)/hello")
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("application/json", forHTTPHeaderField: "accept")

        let (data, response) = try await transport.data(for: request)
        guard response.statusCode == 200 else {
            throw MizarError(
                code: "HELLO_FAILED",
                message: describeStatus(response.statusCode),
                retryable: response.statusCode >= 500,
            )
        }
        return try decode(data, as: HelloResponse.self)
    }

    /// Redeem a pairing code for a device token.
    ///
    /// - Parameters:
    ///   - authority: `host:port`.
    ///   - code: the code from the QR or typed by hand.
    ///   - deviceName: what to call this device in the host's roster.
    ///   - deviceModel: the hardware model.
    /// - Returns: the pairing, ready to store.
    public func pair(
        authority: String,
        code: String,
        deviceName: String,
        deviceModel: String,
    ) async throws -> PairedHost {
        let url = try requireURL(authority: authority, path: "\(mizarHTTPPrefix)/pair")
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.httpBody = try JSONEncoder().encode(
            PairRequest(
                code: code,
                deviceName: deviceName,
                deviceModel: deviceModel,
                appVersion: Self.appVersion,
            ),
        )

        let (data, response) = try await transport.data(for: request)
        guard response.statusCode == 200 else {
            throw pairFailure(status: response.statusCode, body: data)
        }

        let body = try decode(data, as: PairResponse.self)
        return PairedHost(
            hostId: body.hostId,
            hostName: body.hostName,
            authority: authority,
            deviceId: body.deviceId,
            deviceToken: body.deviceToken,
        )
    }

    // MARK: - Internals

    /// The app's marketing version, sent for the host's roster.
    static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
    }

    private func requireURL(authority: String, path: String) throws -> URL {
        guard let url = PairingURI.httpURL(authority: authority, path: path) else {
            throw MizarError(
                code: "BAD_AUTHORITY",
                message: "\"\(authority)\" is not an address this app can dial",
            )
        }
        return url
    }

    private func decode<T: Decodable>(_ data: Data, as type: T.Type) throws -> T {
        do {
            return try JSONDecoder().decode(type, from: data)
        } catch {
            throw MizarError(
                code: "MALFORMED_RESPONSE",
                message: "the host answered something this app could not read",
            )
        }
    }

    /// Turn a refused pairing into an error the operator can act on.
    ///
    /// The host reports a specific code per reason, and each implies different
    /// advice — a wrong code means retype it, an expired or already-used one
    /// means ask the host for a fresh one, and being rate limited means wait.
    private func pairFailure(status: Int, body: Data) -> MizarError {
        let reported = (try? JSONDecoder().decode([String: String].self, from: body))?["error"]
        let code = reported ?? "PAIRING_FAILED"

        let message: String
        switch code {
        case "PAIRING_CODE_INVALID":
            message = "That pairing code is not right. Check the code shown on the host."
        case "PAIRING_CODE_EXPIRED":
            message = "That pairing code has expired. Generate a new one on the host."
        case "PAIRING_CODE_UNKNOWN":
            // The host also answers this for a code that was already used —
            // deliberately, so the endpoint is not an oracle — which is why the
            // wording covers both.
            message = "That pairing code is no longer valid. Generate a new one on the host."
        case "RATE_LIMITED":
            message = "Too many attempts. Wait a moment and try again."
        case "MALFORMED_FRAME":
            message = "The host could not read the request. Check that the app is up to date."
        default:
            message = describeStatus(status)
        }

        return MizarError(
            code: code,
            message: message,
            // A rate limit is worth retrying; a wrong code is not.
            retryable: code == "RATE_LIMITED" || status >= 500,
        )
    }

    private func describeStatus(_ status: Int) -> String {
        switch status {
        case 401: "The host refused the request."
        case 403: "The host refused the request because it did not come from a trusted address."
        case 404: "Nothing is listening at that address."
        case 405: "The host does not accept that request."
        case 410: "That pairing code is no longer valid. Generate a new one on the host."
        case 413: "The request was too large."
        case 429: "Too many attempts. Wait a moment and try again."
        default: "The host answered with status \(status)."
        }
    }
}
