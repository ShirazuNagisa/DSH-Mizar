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
//  What each record means was read off a real session. One prompt produces
//  eighteen records, and only two of them are the conversation:
//
//    user/message        data.content[] of typed parts, data.role
//    system/message      the same shape
//    assistant/attempt   data.stream[] of chunks
//    everything else     permission/preset, sandbox/mode, approval/policy,
//                        agent/inbox/spliced, turn/start, step/start, ...
//
//  The eighteen were dumped from a live session rather than guessed, and the
//  ratio is why the other sixteen are dropped rather than rendered. This is a
//  conversation view, and a screen where two lines of dialogue sit in a list of
//  sixteen bookkeeping rows is a screen nobody can read. DSH's own desktop
//  transcript makes the same call.
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
///
/// The whole record is kept, not just the `event` key, because the two places
/// these records come from disagree about shape. The gateway wraps them as
/// `{"type":"event","event":{…}}`; the same record written to a session log has
/// `type`, `seq`, `time` and `data` at the top level with no wrapper at all.
/// Decoding only `event` means a log-shaped record arrives with no payload and
/// renders as nothing, silently.
public struct SessionRecord: Decodable, Sendable, Equatable {
    /// The record type: `event`, `chunks`, or -- unwrapped -- the event's own
    /// name such as `assistant/message`.
    public let type: String
    /// The gateway's wrapper, when there is one.
    public let event: JSONValue?
    /// Everything the record held.
    private let raw: JSONValue

    private enum CodingKeys: String, CodingKey {
        case type
        case event
    }

    public init(from decoder: any Decoder) throws {
        let single = try decoder.singleValueContainer()
        self.raw = try single.decode(JSONValue.self)
        self.type = raw["type"]?.stringValue ?? ""
        self.event = raw["event"]
    }
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
    /// The payload, whether or not it arrived wrapped.
    ///
    /// The gateway hands back `{"type":"event","event":{…}}`. The same records
    /// written to a session log on disk have no wrapper -- `type`, `seq`, `time`
    /// and `data` sit at the top level. Reading both means a change on either
    /// side degrades to nothing rendered rather than to a parser crash or, worse,
    /// to a record that looks like it has no name.
    var payload: JSONValue {
        event ?? raw
    }

    /// The event's name, or `nil` when this record carries none.
    public var eventName: String? {
        payload["type"]?.stringValue ?? type
    }

    /// When the event happened.
    public var timestamp: Date? {
        guard let millis = payload["time"]?.numberValue else { return nil }
        return Date(timeIntervalSince1970: millis / 1000)
    }

    /// A stable identity for the record.
    public var recordId: String {
        if let seq = payload["seq"]?.intValue { return "seq-\(seq)" }
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
    /// Consecutive duplicates are collapsed. A single prompt arrives as *two*
    /// `user/message` events -- one carrying the RPC source and one from the
    /// inbox splice -- with identical text, and rendering both puts the same
    /// bubble on screen twice.
    ///
    /// - Returns: the items, oldest first.
    public func conversationItems() -> [ConversationItem] {
        var out: [ConversationItem] = []
        for item in records.compactMap({ $0.conversationItems() }).flatMap({ $0 }) {
            if case .message(_, let role, let text, _) = item,
               case .message(_, let priorRole, let priorText, _) = out.last,
               role == priorRole, text == priorText {
                continue
            }
            out.append(item)
        }
        return out
    }
}

extension SessionRecord {
    /// The items this record contributes, if any.
    /// - Returns: zero or more items.
    func conversationItems() -> [ConversationItem] {
        // The payload, whether the gateway wrapped it or not.
        let event = payload
        let at = timestamp ?? Date(timeIntervalSince1970: 0)
        let id = recordId
        let name = eventName ?? type

        switch name {
        case "user/message":
            // Only what the operator actually typed. DSH sends its own context
            // through this same event, and `data.source.kind` is what tells them
            // apart. Measured on a live session with an eleven-character prompt:
            //
            //   source.kind = "user"             11 characters   <- the prompt
            //   source.kind = "runtime-context" 483 characters
            //   source.kind = "skill-catalog"  5921 characters
            //
            // 6393 characters of injected context for 11 characters of
            // conversation. Rendering them as user bubbles buries the
            // conversation completely, which is exactly what it did: the screen
            // looked like it had lost its history, and it had -- under text
            // nobody wrote.
            //
            // Blocklist, not allowlist. The first version kept only
            // `source.kind == "user"` and that turned out to hide anything typed
            // on the Mac's own DSH window, which is half the history somebody
            // opens this app to read. Hiding the two known injections and
            // showing everything else is the right way round: an unrecognised
            // injection is noise, a hidden message is data loss.
            guard !Self.isInjectedContext(event) else { return [] }
            guard let text = Self.messageText(in: event) else { return [] }
            return [.message(id: id, role: .user, text: text, at: at)]

        case "system/message":
            guard let text = Self.messageText(in: event) else { return [] }
            return [.message(id: id, role: .system, text: text, at: at)]

        case "assistant/message":
            // The committed reply. `assistant/attempt` is the streaming attempt
            // that produced it, and this was the one event type the parser did
            // not know -- so a model that answered perfectly produced nothing on
            // the phone while the Mac showed the whole exchange.
            guard let text = Self.messageText(in: event) else {
                return Self.attemptItems(event: event, id: id, at: at)
            }
            return [.message(id: id, role: .assistant, text: text, at: at)]

        case "assistant/attempt":
            return Self.attemptItems(event: event, id: id, at: at)

        default:
            // Dropped on purpose, not by omission. See the note at the top of
            // this file: sixteen of every eighteen records are bookkeeping, and
            // a conversation that lists them is not a conversation.
            return []
        }
    }

    /// Whether a `user/message` is context DSH assembled rather than words a
    /// person wrote.
    ///
    /// Measured on a live session with an eleven-character prompt:
    ///
    ///   source.kind = "user"             11 characters   <- the prompt
    ///   source.kind = "runtime-context" 483 characters
    ///   source.kind = "skill-catalog"  5921 characters
    ///
    /// 6393 characters of injected context for 11 characters of conversation,
    /// all arriving as `user/message`. Those two kinds are listed here; anything
    /// else is shown, because a source this build has not seen is far more
    /// likely to be a message from the Mac's own window than a new injection.
    ///
    /// - Parameter event: the event payload.
    /// - Returns: whether to hide it.
    private static func isInjectedContext(_ event: JSONValue?) -> Bool {
        let kind = event?["data"]?["source"]?["kind"]?.stringValue
            ?? event?["data"]?["message"]?["source"]?["kind"]?.stringValue
        guard let kind else { return false }
        return kind == "runtime-context" || kind == "skill-catalog"
    }

    /// Pull text out of a message event's typed content parts.
    ///
    /// There are two placements and both are real, read off a session log:
    ///
    ///   user/message       data.content[]
    ///   assistant/message  data.message.content[]
    ///   system/message     data.message.content[]
    ///
    /// Reading only the first is why the model's replies never appeared on the
    /// phone while the Mac showed the whole exchange. The text was there, one
    /// key deeper, and the parser looked in the wrong one.
    ///
    /// - Parameter event: the event payload.
    /// - Returns: the joined text, or `nil` when there is none.
    private static func messageText(in event: JSONValue?) -> String? {
        let parts = event?["data"]?["message"]?["content"]?.arrayValue
            ?? event?["data"]?["content"]?.arrayValue
        guard let parts else { return nil }
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
