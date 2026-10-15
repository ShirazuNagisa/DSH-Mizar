//
//  ConversationCache.swift
//  MizarKit
//
//  Conversations kept on the phone.
//
//  Two problems, one answer. A page can only be so large -- iOS refuses a
//  WebSocket frame over a mebibyte and closes the connection when one arrives --
//  so the host trims what it sends. And a phone loses its network constantly,
//  which used to mean losing the screen with it.
//
//  Caching locally means the conversation is there before the network answers,
//  survives the network not answering, and grows by paging backwards rather than
//  by asking for everything at once.
//
//  Stored as one JSON file per session under Application Support. Not a database:
//  the shape is a list of items with stable ids, the volume is a few hundred
//  kilobytes per session, and a file that can be read with `cat` is worth more
//  during a bug report than an index that cannot.
//

import Foundation

/// A conversation kept on disk.
public struct CachedConversation: Codable, Sendable, Equatable {
    /// The session it belongs to.
    public let sessionId: String
    /// Items, oldest first.
    public let items: [ConversationItem]
    /// The log cut this cache is complete through, or `nil` when unknown.
    public let throughSeq: Int?
    /// When it was last written.
    public let syncedAt: Date
    /// Whether the host said there was more history before this.
    public let hasMore: Bool
    /// The same conversation grouped into turns.
    ///
    /// Optional so a cache written before grouping existed still decodes -- a
    /// cache that fails to read is a conversation that looks lost, which is the
    /// thing this file exists to prevent.
    public let turns: [ConversationTurn]?
    /// The oldest log position this cache holds.
    ///
    /// Paging backwards needs it: `session.messages` takes a `beforeSeq`, and
    /// the newest position the page was taken at says nothing about where its
    /// first record sits. Without it there is no way to ask for what came
    /// before, which is why scrolling up did nothing.
    public let oldestSeq: Int?

    public init(
        sessionId: String,
        items: [ConversationItem],
        throughSeq: Int?,
        syncedAt: Date = Date(),
        hasMore: Bool = false,
        turns: [ConversationTurn]? = nil,
        oldestSeq: Int? = nil,
    ) {
        self.turns = turns
        self.oldestSeq = oldestSeq
        self.sessionId = sessionId
        self.items = items
        self.throughSeq = throughSeq
        self.syncedAt = syncedAt
        self.hasMore = hasMore
    }
}

/// Storage for cached conversations.
public protocol ConversationCache: Sendable {
    /// Read a cached conversation.
    /// - Parameter sessionId: the session.
    /// - Returns: the cache, or `nil` when nothing is stored.
    func load(sessionId: String) async -> CachedConversation?

    /// Replace a cached conversation.
    /// - Parameter conversation: what to store.
    func save(_ conversation: CachedConversation) async

    /// Forget one session.
    /// - Parameter sessionId: the session to forget.
    func remove(sessionId: String) async

    /// Forget everything.
    func clear() async

    /// How many sessions are cached.
    func count() async -> Int
}

extension ConversationItem: Codable {
    private enum CodingKeys: String, CodingKey {
        case kind, id, role, text, label, message, at
    }

    /// A flat shape, because the enum's associated values do not encode usefully
    /// through the synthesised conformance and a cache is a file format -- it has
    /// to keep working when the enum gains a case.
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let id = try container.decode(String.self, forKey: .id)
        let at = try container.decode(Date.self, forKey: .at)
        switch try container.decode(String.self, forKey: .kind) {
        case "assistant":
            self = .message(
                id: id,
                role: .assistant,
                text: try container.decode(String.self, forKey: .text),
                at: at,
            )
        case "system":
            self = .message(
                id: id,
                role: .system,
                text: try container.decode(String.self, forKey: .text),
                at: at,
            )
        case "activity":
            self = .activity(
                id: id,
                label: try container.decode(String.self, forKey: .label),
                at: at,
            )
        case "failure":
            self = .failure(
                id: id,
                message: try container.decode(String.self, forKey: .message),
                at: at,
            )
        default:
            self = .message(
                id: id,
                role: .user,
                text: try container.decode(String.self, forKey: .text),
                at: at,
            )
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(id, forKey: .id)
        switch self {
        case .message(let id, let role, let text, let at):
            try container.encode(id, forKey: .id)
            try container.encode(text, forKey: .text)
            try container.encode(at, forKey: .at)
            switch role {
            case .user: try container.encode("user", forKey: .kind)
            case .assistant: try container.encode("assistant", forKey: .kind)
            case .system: try container.encode("system", forKey: .kind)
            }
        case .activity(let id, let label, let at):
            try container.encode(id, forKey: .id)
            try container.encode("activity", forKey: .kind)
            try container.encode(label, forKey: .label)
            try container.encode(at, forKey: .at)
        case .failure(let id, let message, let at):
            try container.encode(id, forKey: .id)
            try container.encode("failure", forKey: .kind)
            try container.encode(message, forKey: .message)
            try container.encode(at, forKey: .at)
        }
    }
}

/// The real cache: one JSON file per session.
public actor FileConversationCache: ConversationCache {
    private let directory: URL

    /// - Parameter directory: where to keep the files. Defaults to Application
    ///   Support, which is backed up and not visible to the Files app -- a
    ///   conversation is the operator's data but not a document they manage.
    public init(directory: URL? = nil) {
        if let directory {
            self.directory = directory
        } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSTemporaryDirectory())
            self.directory = base.appendingPathComponent("MizarConversations", isDirectory: true)
        }
    }

    private func url(for sessionId: String) -> URL {
        // The session id is a UUID from the host, but it arrives over the wire
        // and a path built from unvalidated input is how a cache becomes a
        // directory traversal. Anything outside a conservative set is escaped.
        let safe = sessionId.replacingOccurrences(
            of: "[^A-Za-z0-9._-]",
            with: "_",
            options: .regularExpression,
        )
        return directory.appendingPathComponent("\(safe).json")
    }

    public func load(sessionId: String) async -> CachedConversation? {
        guard let data = try? Data(contentsOf: url(for: sessionId)) else { return nil }
        return try? JSONDecoder().decode(CachedConversation.self, from: data)
    }

    public func save(_ conversation: CachedConversation) async {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(conversation)
            // Written atomically: a cache that is half-written reads as absent,
            // and absent means the conversation looks lost, which is the thing
            // this file exists to prevent.
            try data.write(to: url(for: conversation.sessionId), options: .atomic)
        } catch {
            // A cache that cannot be written is a cache that does not exist, not
            // a failure the operator should see. The conversation still works.
        }
    }

    public func remove(sessionId: String) async {
        try? FileManager.default.removeItem(at: url(for: sessionId))
    }

    public func clear() async {
        try? FileManager.default.removeItem(at: directory)
    }

    public func count() async -> Int {
        (try? FileManager.default.contentsOfDirectory(atPath: directory.path).count) ?? 0
    }
}

/// Fold a freshly fetched page into what is already known.
///
/// By id, not by concatenation: the page and the cache overlap on every refresh,
/// and appending one to the other duplicates every message they share. Sorting
/// by time keeps a page that arrives out of order readable.
///
/// Here rather than in the app because it is the rule that decides what a
/// conversation *is*, and a rule that decides is worth being able to test
/// without a screen.
///
/// - Parameters:
///   - cached: what the phone already had.
///   - fresh: what the host just sent.
/// - Returns: the union, oldest first.
public func mergeConversations(
    cached: [ConversationItem],
    fresh: [ConversationItem],
) -> [ConversationItem] {
    var byId: [String: ConversationItem] = [:]
    for item in cached { byId[item.id] = item }
    // Fresh wins on a collision: it is the host's current answer.
    for item in fresh { byId[item.id] = item }
    return byId.values.sorted { left, right in
        (time(of: left) ?? .distantPast) < (time(of: right) ?? .distantPast)
    }
}

/// Fold a fresh page of turns into what is already stored.
///
/// By turn number, newest winning, the same way items are merged and for the
/// same reason: consecutive pages overlap, and appending one to the other
/// duplicates the turns they share.
///
/// - Parameters:
///   - cached: turns the phone already had.
///   - fresh: turns the host just sent.
/// - Returns: the union, oldest first.
public func mergeTurns(
    cached: [ConversationTurn],
    fresh: [ConversationTurn],
) -> [ConversationTurn] {
    var byId: [String: ConversationTurn] = [:]
    for turn in cached { byId[turn.id] = turn }
    for turn in fresh { byId[turn.id] = turn }
    // A turn with no number is one the log did not place; it sorts last rather
    // than first, because "unknown" is not "earliest".
    return byId.values.sorted { left, right in
        (left.turn ?? Int.max) < (right.turn ?? Int.max)
    }
}

/// When an item happened.
/// - Parameter item: the item.
/// - Returns: its time.
private func time(of item: ConversationItem) -> Date? {
    switch item {
    case .message(_, _, _, let at): at
    case .activity(_, _, let at): at
    case .failure(_, _, let at): at
    }
}

/// A cache that keeps nothing.
///
/// For tests and previews. Explicitly not a fallback: silently keeping
/// conversations in memory would look like caching worked and lose them on the
/// next launch.
public actor InMemoryConversationCache: ConversationCache {
    private var store: [String: CachedConversation] = [:]

    public init() {}

    public func load(sessionId: String) async -> CachedConversation? { store[sessionId] }
    public func save(_ conversation: CachedConversation) async { store[conversation.sessionId] = conversation }
    public func remove(sessionId: String) async { store[sessionId] = nil }
    public func clear() async { store.removeAll() }
    public func count() async -> Int { store.count }
}
