//
//  SessionIndexTests.swift
//  MizarKitTests
//
//  The store that decides whether the app has a session list before the network
//  does anything. Its failure modes are the interesting part: a file written for
//  one Mac drawn under another's name, a session id that escapes the directory,
//  and a cache that will not write taking the app down with it.
//

import Foundation
import Testing
@testable import MizarKit

@Suite("Session index")
struct SessionIndexTests {
    private func directory() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mizar-index-\(UUID().uuidString)")
    }

    private func row(_ id: String) -> SessionRow {
        SessionRow(
            sessionId: id,
            updatedAt: 1_700_000_000_000,
            running: false,
            blank: false,
            agentAvailable: true,
            cwd: "/Users/you/projects/demo",
            parentSessionId: nil,
            origin: nil,
        )
    }

    @Test("the list, the titles and the workspaces survive a restart")
    func roundTrip() async throws {
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileSessionIndexStore(directory: dir)

        await store.save(
            SessionIndex(
                hostId: "host-1",
                sessions: [row("s1"), row("s2")],
                titles: ["s1": "Refactor the parser"],
                workspacePaths: ["/Users/you/projects/demo"],
            ),
        )

        let read = try #require(await store.load(hostId: "host-1"))
        #expect(read.sessions.map(\.sessionId) == ["s1", "s2"])
        #expect(read.titles["s1"] == "Refactor the parser")
        #expect(read.workspacePaths == ["/Users/you/projects/demo"])
        // `SessionRow` had to become `Codable` for this: a row is more than the
        // id, and a list that lost `running` would show every session as idle.
        #expect(read.sessions[0].cwd == "/Users/you/projects/demo")
    }

    @Test("a file written for another host is not this host's list")
    func refusesAnotherHost() async {
        // A phone with two Macs. Drawing one machine's sessions under the
        // other's name is worse than drawing none, and the two files are one
        // escaping bug apart.
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileSessionIndexStore(directory: dir)
        await store.save(SessionIndex(hostId: "host-2", sessions: [row("s1")]))
        #expect(await store.load(hostId: "host-1") == nil)
    }

    @Test("a host id that could escape the directory does not")
    func safeFileNames() async {
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileSessionIndexStore(directory: dir)
        await store.save(SessionIndex(hostId: "../../etc/passwd", sessions: [row("s1")]))
        let files = (try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? []
        #expect(files.count == 1)
        #expect(!files[0].contains("/"))
        // And it is still readable back, which is what makes the escaping a
        // rename rather than a loss.
        #expect(await store.load(hostId: "../../etc/passwd")?.sessions.count == 1)
    }

    @Test("nothing stored reads as nothing, not as an empty list")
    func missingIsNil() async {
        // The distinction the app depends on: `nil` means "ask the host", an
        // empty list means "the host said there is nothing".
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        #expect(await FileSessionIndexStore(directory: dir).load(hostId: "host-1") == nil)
    }

    @Test("an unreadable file does not take the app down")
    func corruptFileIsAbsent() async throws {
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: dir.appendingPathComponent("host-1.json"))
        #expect(await FileSessionIndexStore(directory: dir).load(hostId: "host-1") == nil)
    }

    @Test("removing a host removes its file")
    func remove() async {
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileSessionIndexStore(directory: dir)
        await store.save(SessionIndex(hostId: "host-1", sessions: [row("s1")]))
        await store.remove(hostId: "host-1")
        #expect(await store.load(hostId: "host-1") == nil)
    }

    @Test("every key survives a hostile round trip")
    func hostileFields() async throws {
        // Worst case rather than a realistic one: an emoji workspace name, a
        // session with no working directory, and a title that is only spaces.
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let store = FileSessionIndexStore(directory: dir)
        let odd = SessionRow(
            sessionId: "session-😀-with-a-very-long-identifier-\(String(repeating: "x", count: 200))",
            updatedAt: 0,
            running: true,
            blank: true,
            agentAvailable: false,
            cwd: nil,
            parentSessionId: "parent",
            origin: "subagent",
        )
        await store.save(
            SessionIndex(
                hostId: "host-1",
                sessions: [odd],
                titles: [odd.sessionId: "   "],
                workspacePaths: ["/Users/you/项目/emoji 😀"],
            ),
        )
        let read = try #require(await store.load(hostId: "host-1"))
        #expect(read.sessions.first?.sessionId == odd.sessionId)
        #expect(read.sessions.first?.cwd == nil)
        #expect(read.sessions.first?.isSubagent == true)
        #expect(read.workspacePaths.first == "/Users/you/项目/emoji 😀")
    }
}

@Suite("Conversation cache updates")
struct ConversationCacheUpdateTests {
    private func directory() -> URL {
        URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mizar-update-\(UUID().uuidString)")
    }

    private func item(_ id: String, _ at: Double) -> ConversationItem {
        .message(id: id, role: .assistant, text: id, at: Date(timeIntervalSince1970: at))
    }

    @Test("an update reads what is there, not what was there before the request")
    func updateSeesTheLatest() async throws {
        // The race the method exists to close: two readers of one session load
        // the file, both change it, and the second write wins with a snapshot
        // that predates the first. What is lost is a page somebody asked for.
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = FileConversationCache(directory: dir)
        await cache.save(CachedConversation(sessionId: "s1", items: [item("a", 1)], throughSeq: 1))

        // Both land while a stale copy is in hand, which is what the old
        // load-then-save shape did.
        await cache.update(sessionId: "s1") { current in
            CachedConversation(
                sessionId: "s1",
                items: mergeConversations(cached: current?.items ?? [], fresh: [item("b", 2)]),
                throughSeq: current?.throughSeq,
            )
        }
        let stored = await cache.update(sessionId: "s1") { current in
            CachedConversation(
                sessionId: "s1",
                items: mergeConversations(cached: current?.items ?? [], fresh: [item("c", 3)]),
                throughSeq: current?.throughSeq,
            )
        }

        #expect(stored.items.map(\.id) == ["a", "b", "c"])
    }

    @Test("an update on a session with nothing stored starts from nothing")
    func updateOnAMissingSession() async {
        let dir = directory()
        defer { try? FileManager.default.removeItem(at: dir) }
        let cache = FileConversationCache(directory: dir)
        let stored = await cache.update(sessionId: "s1") { current in
            #expect(current == nil)
            return CachedConversation(sessionId: "s1", items: [self.item("a", 1)], throughSeq: 1)
        }
        #expect(await cache.load(sessionId: "s1")?.items.count == 1)
        #expect(stored.throughSeq == 1)
    }
}
