//
//  SessionIndex.swift
//  MizarKit
//
//  What DSH last said about its sessions, kept on the phone.
//
//  The conversation cache answers "what was said"; this answers "what exists".
//  They are different failures. A conversation that will not load is a screen
//  with no messages on it; an index that will not load is a session *list* with
//  no rows in it -- and the operator is left looking at an empty app while their
//  agent is seventeen turns into a refactor.
//
//  That was the reported shape of it: "刚刚点进会话，因为网络不佳，会话标题和模型、
//  上下文用量都加载不出来". The usage frame was already stored per session. The
//  titles were not, and neither was the list they are titles *of*: both were
//  built by a request each, in memory, and gone the moment the process was.
//
//  So this file holds exactly the three things a list is drawn from, and every
//  refresh writes over it. Nothing reads the network directly to draw a row.
//

import Foundation

/// What DSH last reported, for one host.
public struct SessionIndex: Codable, Sendable, Equatable {
    /// The machine this belongs to. A phone may have several, and a list from
    /// one of them drawn under another's name would be worse than an empty list.
    public var hostId: String
    /// The sessions DSH listed, newest activity first.
    public var sessions: [SessionRow]
    /// DSH's own title for a session, by id.
    public var titles: [String: String]
    /// The workspaces DSH still has, by path.
    public var workspacePaths: [String]
    /// When this was last written.
    public var updatedAt: Date

    public init(
        hostId: String,
        sessions: [SessionRow] = [],
        titles: [String: String] = [:],
        workspacePaths: [String] = [],
        updatedAt: Date = Date(),
    ) {
        self.hostId = hostId
        self.sessions = sessions
        self.titles = titles
        self.workspacePaths = workspacePaths
        self.updatedAt = updatedAt
    }
}

/// Storage for the session index.
public protocol SessionIndexStore: Sendable {
    /// Read what is stored for a host.
    /// - Parameter hostId: the machine.
    /// - Returns: the index, or `nil` when nothing is stored.
    func load(hostId: String) async -> SessionIndex?
    /// Replace what is stored for a host.
    /// - Parameter index: what to store.
    func save(_ index: SessionIndex) async
    /// Forget a host, when the operator unpairs from it.
    /// - Parameter hostId: the machine.
    func remove(hostId: String) async
    /// Forget everything, for a launch that has to start from nothing.
    func clear() async
}

/// The index, on disk, one file per host.
///
/// `Application Support` rather than Documents: this is the operator's data but
/// not a document they manage, and it is backed up while staying out of the
/// Files app.
public actor FileSessionIndexStore: SessionIndexStore {
    private let directory: URL

    /// - Parameter directory: where to keep it, or `nil` for Application Support.
    public init(directory: URL? = nil) {
        if let directory {
            self.directory = directory
        } else {
            let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
                ?? URL(fileURLWithPath: NSTemporaryDirectory())
            self.directory = base.appendingPathComponent("MizarIndex", isDirectory: true)
        }
    }

    /// The file for one host.
    ///
    /// The host id arrives over the wire, so it is escaped before it becomes a
    /// path -- the same rule the conversation cache follows, for the same reason.
    private func url(for hostId: String) -> URL {
        let safe = hostId.replacingOccurrences(
            of: "[^A-Za-z0-9._-]",
            with: "_",
            options: .regularExpression,
        )
        return directory.appendingPathComponent("\(safe).json")
    }

    public func load(hostId: String) async -> SessionIndex? {
        guard let data = try? Data(contentsOf: url(for: hostId)) else { return nil }
        guard let index = try? JSONDecoder().decode(SessionIndex.self, from: data) else { return nil }
        // A file written for a different host is not this host's index. It
        // cannot normally happen, and a list drawn under the wrong machine's
        // name is bad enough to check for.
        return index.hostId == hostId ? index : nil
    }

    public func save(_ index: SessionIndex) async {
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let data = try JSONEncoder().encode(index)
            // Atomic: a half-written index reads as absent, and absent means an
            // empty session list.
            try data.write(to: url(for: index.hostId), options: .atomic)
        } catch {
            // A cache that cannot be written is a cache that does not exist,
            // not a failure the operator should see. The network still works.
        }
    }

    public func remove(hostId: String) async {
        try? FileManager.default.removeItem(at: url(for: hostId))
    }

    public func clear() async {
        try? FileManager.default.removeItem(at: directory)
    }
}

/// A store that keeps nothing. For tests and previews.
public actor InMemorySessionIndexStore: SessionIndexStore {
    private var store: [String: SessionIndex] = [:]

    public init() {}

    public func load(hostId: String) async -> SessionIndex? { store[hostId] }
    public func save(_ index: SessionIndex) async { store[index.hostId] = index }
    public func remove(hostId: String) async { store[hostId] = nil }
    public func clear() async { store.removeAll() }
}
