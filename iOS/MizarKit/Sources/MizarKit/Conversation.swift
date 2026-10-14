//
//  Conversation.swift
//  MizarKit
//
//  Turning a session log into something a person can read.
//
//  The host hands back raw records, and that is deliberate on its side: event
//  names are merge-extensible, so the set of shapes is open and a bridge that
//  reshaped them would need redeploying whenever DSH added one. The consequence
//  lands here -- this file is where an open schema meets a closed UI, and its
//  whole job is to make an unrecognised record *visible* rather than dropped.
//
//  What each record means was read off a real session:
//
//    user/message        data.content[] of typed parts, data.role
//    assistant/attempt   data.stream[] of chunks, plus turn and step
//    everything else     turn/start, step/start, permission/preset, ...
//
//  Text extraction from assistant chunks is the one part not confirmed against a
//  live response -- this host has no provider credential, so every attempt ends
//  in a failure chunk rather than text. The failure path *is* confirmed, and is
//  surfaced as an error item, because "the model never ran" is the single most
//  important thing a monitoring app can tell you.
//

import Foundation

/// One page of a session's log.
public struct SessionMessagesResult: Decodable, Sendable, Equatable {
    public let sessionId: String
    /// The log cut the page was taken at; `nil` when the session is unknown.
    public let asOfSeq: Int?
    public let records: [SessionRecord]
    public let hasMore: Bool
}

/// One record in the log.
///
/// `type` is `event` for a single event or `chunks` for a packed run of
/// assistant deltas. The payload is kept as ``JSONValue`` rather than decoded
/// into a fixed shape, for the same reason the host does not normalise it.
public struct SessionRecord: Decodable, Sendable, Equatable {
    public let type: String
    public let event: JSONValue?
}

/// Something worth showing in the conversation.
public enum ConversationItem: Sendable, Equatable, Identifiable {
    /// A message from the operator or the agent.
    case message(id: String, role: Role, text: String, at: Date)
    /// Something the agent did that is not a message.
    case activity(id: String, label: String, at: Date)
    /// A turn that ended without producing a response.
    case failure(id: String, message: String, at: Date)

    /// Who a message came from.
    public enum Role: Sendable, Equatable {
        case user
        case assistant
        case system
    }

    public var id: String {
        switch self {
        case .message(let id, _, _, _): id
        case .activity(let id, _, _): id
        case .failure(let id, _, _): id
        }
    }
}

extension SessionRecord {
    /// The event's name, or `nil` when this record carries none.
    public var eventName: String? {
        event?["type"]?.stringValue
    }

    /// When the event happened.
    public var timestamp: Date? {
        guard let millis = event?["time"]?.numberValue else { return nil }
        return Date(timeIntervalSince1970: millis / 1000)
    }

    /// A stable identity for the record.
    public var recordId: String {
        if let seq = event?["seq"]?.intValue { return "seq-\(seq)" }
        return "unknown-\(eventName ?? type)"
    }
}

extension SessionMessagesResult {
    /// Flatten the log into something the conversation view can draw.
    ///
    /// Activity events are kept rather than filtered out: "turn started, step
    /// started, permission changed" is the shape of a working agent, and a
    /// conversation that shows only messages cannot be told apart from one that
    /// is stuck.
    ///
    /// - Returns: the items, oldest first.
    public func conversationItems() -> [ConversationItem] {
        records.compactMap { $0.conversationItems() }.flatMap { $0 }
    }
}

extension SessionRecord {
    /// The items this record contributes, if any.
    /// - Returns: zero or more items.
    func conversationItems() -> [ConversationItem] {
        let at = timestamp ?? Date(timeIntervalSince1970: 0)
        let id = recordId
        let name = eventName ?? type

        switch name {
        case "user/message":
            guard let text = Self.messageText(in: event) else { return [] }
            return [.message(id: id, role: .user, text: text, at: at)]

        case "system/message":
            guard let text = Self.messageText(in: event) else { return [] }
            return [.message(id: id, role: .system, text: text, at: at)]

        case "assistant/attempt":
            return Self.attemptItems(event: event, id: id, at: at)

        default:
            return [.activity(id: id, label: Self.label(for: name), at: at)]
        }
    }

    /// Pull text out of a message event's typed content parts.
    /// - Parameter event: the event payload.
    /// - Returns: the joined text, or `nil` when there is none.
    private static func messageText(in event: JSONValue?) -> String? {
        guard let parts = event?["data"]?["content"]?.arrayValue else { return nil }
        let text = parts.compactMap { part -> String? in
            guard part["type"]?.stringValue == "text" else { return nil }
            return part["text"]?.stringValue
        }
        return text.isEmpty ? nil : text.joined(separator: "\n")
    }

    /// Turn an assistant attempt into text, or into a failure.
    ///
    /// A failure chunk is checked first and wins outright: an attempt that ends
    /// with an error produced no answer, and rendering the partial text of a
    /// failed turn as if it were the response would be the most misleading thing
    /// this view could do.
    private static func attemptItems(event: JSONValue?, id: String, at: Date) -> [ConversationItem] {
        guard let stream = event?["data"]?["stream"]?.arrayValue else { return [] }

        for entry in stream {
            guard let chunk = entry["chunk"], chunk["type"]?.stringValue == "finish" else { continue }
            guard let reason = chunk["reason"], reason["kind"]?.stringValue == "error" else { continue }
            let message = reason["failure"]?["message"]?.stringValue ?? "the turn ended without a response"
            return [.failure(id: id, message: message, at: at)]
        }

        var text = ""
        for entry in stream {
            guard let chunk = entry["chunk"] else { continue }
            // The text-bearing key is not confirmed against a live response;
            // every plausible spelling is tried so an unrecognised one degrades
            // to missing text rather than a wrong rendering.
            for key in ["text", "delta", "content"] {
                if let piece = chunk[key]?.stringValue { text += piece }
            }
        }
        guard !text.isEmpty else { return [] }
        return [.message(id: id, role: .assistant, text: text, at: at)]
    }

    /// A short human label for an event name.
    /// - Parameter name: the event name, like `turn/start`.
    /// - Returns: a readable label.
    private static func label(for name: String) -> String {
        switch name {
        case "turn/start": return "Turn started"
        case "turn/end": return "Turn finished"
        case "step/start": return "Step started"
        case "step/end": return "Step finished"
        case "session/title": return "Session titled"
        case "session/title-llm-request": return "Naming the session"
        case "request/header": return "Preparing the request"
        case "request/context": return "Assembling context"
        case "permission/preset": return "Permission preset"
        case "sandbox/mode": return "Sandbox mode"
        case "approval/policy": return "Approval policy"
        case "agent/inbox/spliced": return "Message queued"
        default: return name
        }
    }
}
