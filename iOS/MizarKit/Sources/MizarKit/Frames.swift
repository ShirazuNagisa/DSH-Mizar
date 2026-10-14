//
//  Frames.swift
//  MizarKit
//
//  The Mizar wire protocol, version 1.
//
//  Every frame carries `v`. A peer that does not understand the version is told
//  so explicitly rather than being fed fields it will misread. Requests carry an
//  `id` and responses echo it, so the direction of a frame is unambiguous.
//
//  Decoding is deliberately tolerant in one direction: an unrecognised frame
//  type or an unknown error code decodes successfully into a case that preserves
//  it. A host newer than the app must not make the app's socket fail to parse;
//  an old app should degrade, not break.
//

import Foundation

/// The protocol version this build speaks.
public let mizarProtocolVersion = 1

/// Path of the authenticated WebSocket endpoint.
public let mizarWebSocketPath = "/mizar/v1/ws"

/// Path prefix of the plain-HTTP endpoints.
public let mizarHTTPPrefix = "/mizar/v1"

// MARK: - Errors

/// Failure codes the app branches on.
///
/// Codes outside this set are still received and preserved — see
/// ``MizarError/known``. Treating an unknown code as a decoding failure would
/// make a newer host unusable rather than merely less helpful.
public enum MizarErrorCode: String, Sendable, CaseIterable {
    case protocolVersionMismatch = "PROTOCOL_VERSION_MISMATCH"
    case malformedFrame = "MALFORMED_FRAME"
    case unauthenticated = "UNAUTHENTICATED"
    case pairingRequired = "PAIRING_REQUIRED"
    case pairingCodeInvalid = "PAIRING_CODE_INVALID"
    case pairingCodeExpired = "PAIRING_CODE_EXPIRED"
    case pairingCodeUnknown = "PAIRING_CODE_UNKNOWN"
    case rateLimited = "RATE_LIMITED"
    case deviceRevoked = "DEVICE_REVOKED"
    /// The session is held by another writer, normally the desktop UI.
    case writerHeld = "WRITER_HELD"
    /// The requested provider/model pair is not in the available catalog.
    case modelUnavailable = "MODEL_UNAVAILABLE"
    /// An upstream DSH call failed for an unclassified reason.
    case remoteError = "REMOTE_ERROR"
    case notImplemented = "NOT_IMPLEMENTED"
    case internalError = "INTERNAL"
}

/// A failure reported by the host.
public struct MizarError: Error, Sendable, Equatable {
    /// The raw code, exactly as the host sent it.
    public let code: String
    /// A log-oriented description; not intended for display.
    public let message: String
    /// Whether retrying the same request could succeed.
    public let retryable: Bool

    public init(code: String, message: String, retryable: Bool = false) {
        self.code = code
        self.message = message
        self.retryable = retryable
    }

    /// The code as a known case, or `nil` when this build predates it.
    public var known: MizarErrorCode? {
        MizarErrorCode(rawValue: code)
    }

    /// Whether reconnecting with a fresh pairing is the only way forward.
    public var requiresRepairing: Bool {
        known == .unauthenticated || known == .deviceRevoked
    }
}

extension MizarError: LocalizedError {
    public var errorDescription: String? { message }
}

// MARK: - Server frames

/// The host's answer to an accepted `hello`.
public struct WelcomeFrame: Sendable, Equatable {
    public let hostId: String
    public let hostName: String
    public let protocolVersion: Int
    /// The host's DSH home directory, shown in host details.
    public let home: String
    /// The device id the presented token belongs to.
    public let deviceId: String
}

/// A frame sent by the host.
public enum ServerFrame: Sendable, Equatable {
    case welcome(WelcomeFrame)
    case ok(id: String, result: JSONValue?)
    case failure(MizarError, id: String?)
    case event(name: String, data: JSONValue)
    /// A frame type this build does not know. Preserved rather than dropped.
    case unknown(type: String, payload: JSONValue)
}

extension ServerFrame: Decodable {
    private enum CodingKeys: String, CodingKey {
        case v, type, id, result, code, message, retryable, event, data
        // Welcome-only fields.
        case hostId, hostName, protocolVersion, home, deviceId
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        let version = try container.decode(Int.self, forKey: .v)
        guard version == mizarProtocolVersion else {
            throw MizarError(
                code: MizarErrorCode.protocolVersionMismatch.rawValue,
                message: "host speaks protocol version \(version), this build speaks \(mizarProtocolVersion)",
            )
        }

        let type = try container.decode(String.self, forKey: .type)
        switch type {
        case "welcome":
            self = .welcome(
                WelcomeFrame(
                    hostId: try container.decode(String.self, forKey: .hostId),
                    hostName: try container.decode(String.self, forKey: .hostName),
                    protocolVersion: try container.decode(Int.self, forKey: .protocolVersion),
                    home: try container.decode(String.self, forKey: .home),
                    deviceId: try container.decode(String.self, forKey: .deviceId),
                ),
            )
        case "ok":
            self = .ok(
                id: try container.decode(String.self, forKey: .id),
                result: try container.decodeIfPresent(JSONValue.self, forKey: .result),
            )
        case "error":
            self = .failure(
                MizarError(
                    code: try container.decode(String.self, forKey: .code),
                    message: try container.decode(String.self, forKey: .message),
                    retryable: try container.decodeIfPresent(Bool.self, forKey: .retryable) ?? false,
                ),
                id: try container.decodeIfPresent(String.self, forKey: .id),
            )
        case "event":
            self = .event(
                name: try container.decode(String.self, forKey: .event),
                data: try container.decode(JSONValue.self, forKey: .data),
            )
        default:
            // Preserve the whole frame rather than dropping it: a host newer
            // than this build must not make the socket unparseable.
            self = .unknown(
                type: type,
                payload: try decoder.singleValueContainer().decode(JSONValue.self),
            )
        }
    }
}

extension ServerFrame {
    /// The correlation id, when the frame answers a request.
    public var correlationId: String? {
        switch self {
        case .ok(let id, _): id
        case .failure(_, let id): id
        case .welcome, .event, .unknown: nil
        }
    }
}

// MARK: - Client frames

/// A frame sent by the app.
public enum ClientFrame: Sendable, Equatable {
    case hello(id: String?, token: String, appVersion: String?, deviceModel: String?)
    case request(id: String, type: String, payload: JSONValue?)
}

extension ClientFrame: Encodable {
    private enum CodingKeys: String, CodingKey {
        case v, type, id, token, appVersion, deviceModel, protocolVersion, payload
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(mizarProtocolVersion, forKey: .v)

        switch self {
        case .hello(let id, let token, let appVersion, let deviceModel):
            try container.encode("hello", forKey: .type)
            try container.encodeIfPresent(id, forKey: .id)
            try container.encode(token, forKey: .token)
            try container.encodeIfPresent(appVersion, forKey: .appVersion)
            try container.encodeIfPresent(deviceModel, forKey: .deviceModel)
            try container.encode(mizarProtocolVersion, forKey: .protocolVersion)

        case .request(let id, let type, let payload):
            try container.encode(type, forKey: .type)
            try container.encode(id, forKey: .id)
            try container.encodeIfPresent(payload, forKey: .payload)
        }
    }
}

// MARK: - HTTP bodies

/// The body of the unauthenticated identity probe.
public struct HelloResponse: Decodable, Sendable, Equatable {
    public let hostId: String
    public let hostName: String
    public let protocolVersion: Int
    /// Whether a pairing code is currently outstanding.
    public let pairingOpen: Bool
    /// Whether at least one live device is paired.
    public let paired: Bool
}

/// The body of a pairing request.
public struct PairRequest: Encodable, Sendable {
    public let code: String
    public let deviceName: String?
    public let deviceModel: String?
    public let appVersion: String?
    public let protocolVersion: Int

    public init(
        code: String,
        deviceName: String? = nil,
        deviceModel: String? = nil,
        appVersion: String? = nil,
    ) {
        self.code = code
        self.deviceName = deviceName
        self.deviceModel = deviceModel
        self.appVersion = appVersion
        self.protocolVersion = mizarProtocolVersion
    }
}

/// The body of a successful pairing response.
public struct PairResponse: Decodable, Sendable, Equatable {
    public let deviceToken: String
    public let deviceId: String
    public let hostId: String
    public let hostName: String
    public let protocolVersion: Int
}
