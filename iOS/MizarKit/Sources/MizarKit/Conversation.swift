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
            guard Self.isUserAuthored(event) else { return [] }
            guard let text = Self.messageText(in: event) else { return [] }
            return [.message(id: id, role: .user, text: text, at: at)]

        case "system/message":
            // Dropped. This is not a message between anyone -- it is the prompt
            // DSH hands the model: "You are an AI agent powered by DeepSeek
            // Harness. You are a coding agent powered by the deepseek-flash
            // model..." followed by the whole instruction set. Measured on a
            // real session it is several thousand characters at the top of every
            // conversation, and it is not something either party said.
            return []

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
    /// Whether a `user/message` was written by the operator.
    ///
    /// An allowlist, and the census that justifies it. Every `user/message` in a
    /// real session log, by `source.kind`:
    ///
    ///     13  user                the operator, typing
    ///      7  tool-jobs           a background job finished
    ///      6  runtime-context     injected context
    ///      4  subagent-settled    a subagent stopped
    ///      3  skill-catalog       injected skill list
    ///      3  goal                a goal round
    ///      2  user-approval       a notice *about* a user action
    ///      2  agent-message       another agent talking
    ///      2  compact-checkpoint  the conversation was compacted
    ///      1  model-selection     the model was changed
    ///      1  plan-mode           the mode was changed
    ///
    /// Nine of those eleven arrived as ordinary user messages, and a blocklist
    /// that named two of them let the other seven through -- which is the pile
    /// of things the operator never typed.
    ///
    /// A blocklist was chosen first, on the reasoning that an unrecognised
    /// injection is noise while a hidden message is data loss. The census says
    /// otherwise: an unrecognised kind is not a message, and the only kind that
    /// is one is `user`. A message typed in the Mac's own DSH window carries it
    /// too, so nothing a person wrote is lost by asking for it by name.
    ///
    /// A missing `kind` is not treated as `user`. Guessing in that direction is
    /// how the pile got here.
    ///
    /// - Parameter event: the event payload.
    /// - Returns: whether the operator wrote it.
    private static func isUserAuthored(_ event: JSONValue?) -> Bool {
        let kind = event?["data"]?["source"]?["kind"]?.stringValue
            ?? event?["data"]?["message"]?["source"]?["kind"]?.stringValue
        return kind == "user"
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

/// One turn of the conversation: what the agent did in response to one prompt.
///
/// DSH groups by turn and this did not, so a single prompt that took eleven
/// steps arrived as eleven separate messages and read as the model talking to
/// itself. The grain is in the log -- every record from `turn/start` to
/// `turn/end` carries `data.turn`, and `step/start` and `step/end` bracket the
/// parts within it -- so the grouping is a reading of what is already there
/// rather than a guess at it.
public struct ConversationTurn: Sendable, Equatable, Identifiable, Codable {
    /// Which turn, or `nil` for anything outside one.
    public let turn: Int?
    /// What the operator said, oldest first. Always shown.
    public let prompts: [ConversationItem]
    /// What the agent produced, oldest first. Collapsed behind the summary.
    public let steps: [ConversationItem]
    /// When the turn began.
    public let startedAt: Date?
    /// When it ended.
    public let endedAt: Date?
    /// How it ended, when the host said.
    public let endedReason: String?

    public var id: String { turn.map(String.init) ?? "unopened" }

    public init(
        turn: Int?,
        prompts: [ConversationItem],
        steps: [ConversationItem],
        startedAt: Date?,
        endedAt: Date?,
        endedReason: String?,
    ) {
        self.turn = turn
        self.prompts = prompts
        self.steps = steps
        self.startedAt = startedAt
        self.endedAt = endedAt
        self.endedReason = endedReason
    }

    /// How long the turn took, when both ends are known.
    public var duration: TimeInterval? {
        guard let startedAt, let endedAt else { return nil }
        return max(0, endedAt.timeIntervalSince(startedAt))
    }

    /// Whether the turn ended without finishing.
    public var failed: Bool { endedReason == "error" }

    /// Everything in the turn, for a caller that wants a flat list.
    public var items: [ConversationItem] { prompts + steps }

    /// Whether there is anything to collapse.
    ///
    /// One step is not a crowd: collapsing a turn that produced a single reply
    /// hides the answer behind a tap for no gain, and the answer is the whole
    /// point.
    ///
    /// A turn that failed is never folded either. Failure is the one thing that
    /// has to be visible without a tap -- an operator who has to open a turn to
    /// discover it went wrong will not open it.
    public var isCollapsible: Bool { steps.count > 1 && !failed }
}

extension SessionMessagesResult {
    /// Read the page as turns, in order.
    ///
    /// Grouping rules, each from the log rather than from taste:
    ///
    /// - `data.turn` on a record says which turn it belongs to.
    /// - **A prompt has no turn of its own.** Measured on a real log, the
    ///   `user/message` that starts a turn carries no `data.turn` -- it is
    ///   written before `turn/start`. So a prompt is held and attached to the
    ///   turn that follows it, which is the turn it caused. A prompt with no
    ///   turn after it keeps its own unopened group rather than being dropped.
    /// - Within a turn, the prompt is what the operator typed and stays visible;
    ///   the steps are the agent working, and they are what reads as noise.
    /// - `turn/end.reason.kind` distinguishes a turn that finished from one that
    ///   ran into something.
    ///
    /// - Returns: the turns, oldest first.
    public func conversationTurns() -> [ConversationTurn] {
        var order: [Int?] = []
        var prompts: [Int?: [ConversationItem]] = [:]
        var steps: [Int?: [ConversationItem]] = [:]
        var started: [Int?: Date] = [:]
        var ended: [Int?: Date] = [:]
        var reason: [Int?: String] = [:]
        /// Prompts seen before the turn they started.
        var pending: [ConversationItem] = []

        for record in records {
            let payload = record.payload
            let name = payload["type"]?.stringValue ?? record.type
            let turn = payload["data"]?["turn"]?.intValue
            let at = payload["time"]?.numberValue.map { Date(timeIntervalSince1970: $0 / 1000) }

            switch name {
            case "turn/start":
                if !order.contains(turn) { order.append(turn) }
                started[turn] = at
                if !pending.isEmpty {
                    prompts[turn, default: []].append(contentsOf: pending)
                    pending.removeAll()
                }
            case "turn/end":
                ended[turn] = at
                reason[turn] = payload["data"]?["reason"]?["kind"]?.stringValue
            case "user/message", "assistant/message", "assistant/attempt", "system/message":
                let items = record.conversationItems()
                guard !items.isEmpty else { continue }
                if name == "user/message" {
                    // A prompt belongs to the turn it starts, and it is written
                    // before that turn exists.
                    if let turn, order.contains(turn) {
                        prompts[turn, default: []].append(contentsOf: items)
                    } else {
                        pending.append(contentsOf: items)
                    }
                    continue
                }
                if !order.contains(turn) { order.append(turn) }
                // A prompt can also arrive after its `turn/start` -- the log
                // holds both orders -- so it is claimed by whichever of the two
                // comes first.
                if !pending.isEmpty {
                    prompts[turn, default: []].append(contentsOf: pending)
                    pending.removeAll()
                }
                steps[turn, default: []].append(contentsOf: items)
            default:
                continue
            }
        }

        // A prompt with nothing after it still has to be on screen.
        if !pending.isEmpty {
            order.append(nil)
            prompts[nil, default: []].append(contentsOf: pending)
        }

        return order.map { turn in
            ConversationTurn(
                turn: turn,
                prompts: prompts[turn] ?? [],
                steps: steps[turn] ?? [],
                startedAt: started[turn],
                endedAt: ended[turn] ?? (steps[turn] ?? []).last.map(Self.time(of:)),
                endedReason: reason[turn],
            )
        }
    }

    /// The oldest log position among these records, or `nil` when there are none.
    ///
    /// `session.messages` pages by `beforeSeq`, so this is what a caller asks
    /// for next when it wants what came before the page it holds.
    public var oldestSeq: Int? {
        records.compactMap { $0.payload["seq"]?.intValue }.min()
    }

    /// When an item happened.
    /// - Parameter item: the item.
    /// - Returns: its time.
    private static func time(of item: ConversationItem) -> Date {
        switch item {
        case .message(_, _, _, let at): at
        case .activity(_, _, let at): at
        case .failure(_, _, let at): at
        }
    }
}
