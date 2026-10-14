//
//  JSONValue.swift
//  MizarKit
//
//  A `Codable` representation of arbitrary JSON.
//
//  The Mizar protocol is deliberately open in one direction: a server frame's
//  payload depends on its method, and a client must be able to receive a frame
//  it does not yet understand (a newer host, a method added after this build)
//  without failing to decode the envelope. So the envelope decodes into typed
//  fields plus `JSONValue` payloads, and only the methods that know their own
//  shape decode further.
//

import Foundation

/// Any JSON value.
public enum JSONValue: Codable, Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else if let value = try? container.decode([String: JSONValue].self) {
            self = .object(value)
        } else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "not a JSON value",
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }
}

// MARK: - Reading

extension JSONValue {
    /// The value as a string, or `nil` when it is another type.
    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    /// The value as a number, or `nil` when it is another type.
    public var numberValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    /// The value as an integer, or `nil` when it is not an integral number.
    public var intValue: Int? {
        guard case .number(let value) = self, value.isFinite else { return nil }
        let rounded = value.rounded()
        guard rounded == value else { return nil }
        return Int(rounded)
    }

    /// The value as a boolean, or `nil` when it is another type.
    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    /// The value as an array, or `nil` when it is another type.
    public var arrayValue: [JSONValue]? {
        if case .array(let value) = self { return value }
        return nil
    }

    /// The value as an object, or `nil` when it is another type.
    public var objectValue: [String: JSONValue]? {
        if case .object(let value) = self { return value }
        return nil
    }

    /// A member of an object value.
    ///
    /// Returns `nil` for anything that is not an object, which makes chained
    /// reads safe: `frame.result?["stats"]?["cacheHit"]?["displayPercent"]`
    /// yields `nil` at any point rather than trapping.
    ///
    /// - Parameter key: the member name.
    /// - Returns: the member, or `nil`.
    public subscript(key: String) -> JSONValue? {
        guard case .object(let members) = self else { return nil }
        return members[key]
    }

    /// The value re-encoded as JSON data.
    ///
    /// Used to decode a payload into a typed model without a second wire trip:
    /// the envelope already holds the exact bytes' worth of structure.
    ///
    /// - Returns: the encoded data.
    /// - Throws: when the value cannot be encoded, which for a decoded
    ///   `JSONValue` cannot happen.
    public func encoded() throws -> Data {
        try JSONEncoder().encode(self)
    }

    /// Decode this value into a typed model.
    ///
    /// - Parameter type: the model to decode.
    /// - Returns: the decoded model.
    /// - Throws: `DecodingError` when the shape does not match.
    public func decoded<T: Decodable>(as type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: try encoded())
    }
}
