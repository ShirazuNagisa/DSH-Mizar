//
//  ConversationTests.swift
//  MizarKitTests
//
//  The fixtures here are trimmed copies of records a live host actually returned,
//  including the failure that every turn on this machine ends with. Guessing at
//  the shapes would have produced a green suite that rendered nothing.
//

import Foundation
import Testing
@testable import MizarKit

/// Decode a page from JSON text.
private func page(_ json: String) throws -> SessionMessagesResult {
    try JSONDecoder().decode(SessionMessagesResult.self, from: Data(json.utf8))
}

@Suite("Conversation")
struct ConversationTests {
    @Test("a user message becomes a bubble")
    func userMessage() throws {
        let result = try page("""
        {"sessionId":"s1","asOfSeq":17,"hasMore":false,"records":[
          {"type":"event","event":{"type":"user/message","seq":8,"time":1791984791224,
            "data":{"content":[{"type":"text","text":"Reply with exactly: hello"}],
                      "source":{"kind":"user"},"role":"user","id":"abc"},"surfaceOp":"append"}}
        ]}
        """)

        let items = result.conversationItems()
        #expect(items.count == 1)
        guard case .message(_, let role, let text, _) = items[0] else {
            Issue.record("expected a message, got \(items[0])")
            return
        }
        #expect(role == .user)
        #expect(text == "Reply with exactly: hello")
    }

    @Test("several text parts are joined")
    func multipartMessage() throws {
        let result = try page("""
        {"sessionId":"s1","asOfSeq":1,"hasMore":false,"records":[
          {"type":"event","event":{"type":"user/message","seq":1,"time":1,
            "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"one"},{"type":"image","url":"x"},
                               {"type":"text","text":"two"}]}}}
        ]}
        """)
        guard case .message(_, _, let text, _) = result.conversationItems()[0] else {
            Issue.record("expected a message")
            return
        }
        #expect(text == "one\ntwo")
    }

    @Test("a failed turn is shown as a failure, not as an empty answer")
    func failedAttempt() throws {
        // This is the real shape: every turn on a host without a provider
        // credential ends here, and showing nothing would look like a hang.
        let result = try page("""
        {"sessionId":"s1","asOfSeq":15,"hasMore":false,"records":[
          {"type":"event","event":{"type":"assistant/attempt","seq":15,"time":1791984791236,
            "data":{"turn":1,"step":1,"stream":[
              {"type":"chunk","time":1,"chunk":{"type":"finish","reason":{"kind":"error",
                "failure":{"message":"no API key for provider route deepseek-official",
                           "code":"MISSING_CREDENTIAL"}}}}]}}}
        ]}
        """)
        guard case .failure(_, let message, _) = result.conversationItems()[0] else {
            Issue.record("expected a failure")
            return
        }
        #expect(message.contains("no API key"))
    }

    @Test("an attempt that streamed text becomes an assistant message")
    func streamedAttempt() throws {
        let result = try page("""
        {"sessionId":"s1","asOfSeq":2,"hasMore":false,"records":[
          {"type":"event","event":{"type":"assistant/attempt","seq":2,"time":1,
            "data":{"stream":[{"type":"chunk","chunk":{"type":"delta","text":"Hel"}},
                              {"type":"chunk","chunk":{"type":"delta","text":"lo"}}]}}}
        ]}
        """)
        guard case .message(_, let role, let text, _) = result.conversationItems()[0] else {
            Issue.record("expected a message")
            return
        }
        #expect(role == .assistant)
        #expect(text == "Hello")
    }

    @Test("bookkeeping events are dropped rather than rendered")
    func bookkeepingIsDropped() throws {
        // One prompt emits roughly sixteen of these for every two messages --
        // measured on a live session, not estimated. A conversation view that
        // lists them is a list of bookkeeping rows with two lines of dialogue
        // somewhere inside it.
        let result = try page("""
        {"sessionId":"s1","asOfSeq":6,"hasMore":false,"records":[
          {"type":"event","event":{"type":"permission/preset","seq":0,"time":1,"data":{}}},
          {"type":"event","event":{"type":"sandbox/mode","seq":1,"time":1,"data":{}}},
          {"type":"event","event":{"type":"approval/policy","seq":2,"time":1,"data":{}}},
          {"type":"event","event":{"type":"agent/inbox/spliced","seq":3,"time":1,"data":{}}},
          {"type":"event","event":{"type":"turn/start","seq":4,"time":1,"data":{}}},
          {"type":"event","event":{"type":"step/start","seq":5,"time":1,"data":{}}},
          {"type":"event","event":{"type":"something/entirely-new","seq":6,"time":1,"data":{}}}
        ]}
        """)
        #expect(result.conversationItems().isEmpty)
    }

    @Test("a packed chunk run is not mistaken for a message")
    func chunkRun() throws {
        let result = try page("""
        {"sessionId":"s1","asOfSeq":1,"hasMore":false,"records":[
          {"type":"chunks","event":{"type":"assistant/delta","seq":1,"time":1,"data":{}}}
        ]}
        """)
        #expect(result.conversationItems().isEmpty)
    }

    @Test("injected context is not shown as something the operator said")
    func injectedContextIsHidden() throws {
        // The bug this pins, measured on a live session: an eleven-character
        // prompt arrived alongside 483 characters of runtime context and 5921
        // characters of skill catalogue, all as `user/message`. Rendered as
        // bubbles, they buried the conversation -- which read as the app having
        // lost its history, and it had.
        let result = try page("""
        {"sessionId":"s1","asOfSeq":10,"hasMore":false,"records":[
          {"type":"event","event":{"type":"user/message","seq":8,"time":1,
            "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"hello world"}]}}},
          {"type":"event","event":{"type":"user/message","seq":9,"time":1,
            "data":{"source":{"kind":"runtime-context"},"content":[{"type":"text","text":"Current runtime context. This snapshot supersedes"}]}}},
          {"type":"event","event":{"type":"user/message","seq":10,"time":1,
            "data":{"source":{"kind":"skill-catalog"},"content":[{"type":"text","text":"<system-reminder>A skill is a reusable set"}]}}}
        ]}
        """)
        let items = result.conversationItems()
        #expect(items.count == 1)
        guard case .message(_, let role, let text, _) = items[0] else {
            Issue.record("expected one message, got \(items)")
            return
        }
        #expect(role == .user)
        #expect(text == "hello world")
    }

    @Test("a message with no source is shown, not guessed away")
    func missingSourceIsShown() throws {
        // The first version required `source.kind == "user"` and that hid
        // anything typed in the Mac's own DSH window -- half the history
        // somebody opens this app to read. Absent is shown; only the two known
        // injections are hidden.
        let result = try page("""
        {"sessionId":"s1","asOfSeq":1,"hasMore":false,"records":[
          {"type":"event","event":{"type":"user/message","seq":1,"time":1,
            "data":{"content":[{"type":"text","text":"typed on the Mac"}]}}}
        ]}
        """)
        #expect(result.conversationItems().count == 1)
    }

    @Test("a message sent from the Mac is shown")
    func desktopMessageIsShown() throws {
        // Whatever the desktop's source kind is called, it is not one of the two
        // injections, so it survives.
        let result = try page("""
        {"sessionId":"s1","asOfSeq":2,"hasMore":false,"records":[
          {"type":"event","event":{"type":"user/message","seq":1,"time":1,
            "data":{"source":{"kind":"desktop"},"content":[{"type":"text","text":"from the Mac"}]}}},
          {"type":"event","event":{"type":"user/message","seq":2,"time":2,
            "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"from the phone"}]}}}
        ]}
        """)
        #expect(result.conversationItems().count == 2)
    }

    @Test("the model's reply is shown")
    func assistantMessageIsShown() throws {
        // `assistant/message` is the committed reply and was the one event type
        // the parser did not know. A model that answered perfectly produced
        // nothing on the phone while the Mac showed the whole exchange.
        let result = try page("""
        {"sessionId":"s1","asOfSeq":3,"hasMore":false,"records":[
          {"type":"event","event":{"type":"user/message","seq":1,"time":1,
            "data":{"content":[{"type":"text","text":"what is 2+2"}]}}},
          {"type":"event","event":{"type":"assistant/message","seq":2,"time":2,
            "data":{"content":[{"type":"text","text":"4"}]}}}
        ]}
        """)
        let items = result.conversationItems()
        #expect(items.count == 2)
        guard case .message(_, let role, let text, _) = items[1] else {
            Issue.record("expected the reply, got \(items[1])")
            return
        }
        #expect(role == .assistant)
        #expect(text == "4")
    }

    @Test("a reply with no readable content falls back to its attempt chunks")
    func assistantMessageFallsBackToAttempt() throws {
        // Whichever of the two carries the text, the reply has to appear.
        let result = try page("""
        {"sessionId":"s1","asOfSeq":2,"hasMore":false,"records":[
          {"type":"event","event":{"type":"assistant/message","seq":2,"time":2,
            "data":{"stream":[{"chunk":{"type":"text","text":"from chunks"}}]}}}
        ]}
        """)
        guard case .message(_, _, let text, _) = result.conversationItems().first else {
            Issue.record("expected a message")
            return
        }
        #expect(text == "from chunks")
    }

    @Test("the same prompt arriving twice is shown once")
    func duplicatePrompt() throws {
        // A prompt arrives as two user/message events with identical text -- one
        // carrying the RPC source, one from the inbox splice.
        let result = try page("""
        {"sessionId":"s1","asOfSeq":9,"hasMore":false,"records":[
          {"type":"event","event":{"type":"user/message","seq":8,"time":1,
            "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"hello"}]}}},
          {"type":"event","event":{"type":"user/message","seq":9,"time":1,
            "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"hello"}]}}}
        ]}
        """)
        #expect(result.conversationItems().count == 1)
    }

    @Test("an empty page produces nothing rather than a placeholder")
    func emptyPage() throws {
        let result = try page("""
        {"sessionId":"s1","asOfSeq":null,"hasMore":false,"records":[]}
        """)
        #expect(result.conversationItems().isEmpty)
    }

    // MARK: - Shapes taken from a real session log

    @Test("the model's reply is found where a real log puts it")
    func assistantMessageRealShape() throws {
        // Copied from a live session log, trimmed. The text is at
        // `data.message.content`, one key deeper than a user message's
        // `data.content` -- and reading only the latter is why every reply was
        // missing from the phone while the Mac showed the whole exchange.
        let result = try page("""
        {"sessionId":"s1","asOfSeq":29,"hasMore":false,"records":[
          {"type":"event","event":{"type":"assistant/message","seq":29,"time":1791089307181,
            "data":{"turn":2,"step":1,"message":{"role":"assistant","content":[
              {"type":"reasoning","text":""},
              {"type":"text","text":"I will start by exploring the workspace."},
              {"type":"tool-call","id":"call_1","name":"bash","arguments":"{}"}
            ],"source":{"kind":"model","provider":"deepseek-account","model":"deepseek-flash"}},
            "surfaceOp":"append"}}}
        ]}
        """)
        let items = result.conversationItems()
        #expect(items.count == 1)
        guard case .message(_, let role, let text, _) = items[0] else {
            Issue.record("expected the reply, got \(items)")
            return
        }
        #expect(role == .assistant)
        #expect(text == "I will start by exploring the workspace.")
    }

    @Test("a tool-call-only reply produces no bubble")
    func assistantMessageWithoutText() throws {
        // A step that only calls tools has no text to show, and an empty bubble
        // per tool call would be worse than nothing.
        let result = try page("""
        {"sessionId":"s1","asOfSeq":30,"hasMore":false,"records":[
          {"type":"event","event":{"type":"assistant/message","seq":30,"time":1,
            "data":{"message":{"role":"assistant","content":[
              {"type":"tool-call","id":"c","name":"bash","arguments":"{}"}
            ]}}}}
        ]}
        """)
        #expect(result.conversationItems().isEmpty)
    }

    @Test("a system message is read from the same deeper placement")
    func systemMessageRealShape() throws {
        let result = try page("""
        {"sessionId":"s1","asOfSeq":7,"hasMore":false,"records":[
          {"type":"event","event":{"type":"system/message","seq":7,"time":1,
            "data":{"turn":1,"step":1,"message":{"role":"system","content":[
              {"type":"text","text":"You are an AI agent powered by DeepSeek Harness."}
            ]}}}}
        ]}
        """)
        guard case .message(_, let role, let text, _) = result.conversationItems().first else {
            Issue.record("expected a system message")
            return
        }
        #expect(role == .system)
        #expect(text.hasPrefix("You are an AI agent"))
    }

    @Test("a whole exchange renders in order")
    func fullExchange() throws {
        // The end-to-end shape of what the user reported: several prompts and
        // the replies to them, in the order a log holds them.
        let result = try page("""
        {"sessionId":"s1","asOfSeq":32,"hasMore":false,"records":[
          {"type":"event","event":{"type":"user/message","seq":8,"time":1,
            "data":{"content":[{"type":"text","text":"你好"}],"source":{"kind":"user"}}}},
          {"type":"event","event":{"type":"assistant/message","seq":9,"time":2,
            "data":{"message":{"role":"assistant","content":[{"type":"text","text":"你好！有什么可以帮你的？"}]}}}},
          {"type":"event","event":{"type":"user/message","seq":10,"time":3,
            "data":{"content":[{"type":"text","text":"你是谁"}],"source":{"kind":"user"}}}},
          {"type":"event","event":{"type":"assistant/message","seq":11,"time":4,
            "data":{"message":{"role":"assistant","content":[{"type":"text","text":"我是一个编码 agent。"}]}}}}
        ]}
        """)
        let items = result.conversationItems()
        #expect(items.count == 4)
        let rendered = items.compactMap { item -> String? in
            if case .message(_, let role, let text, _) = item {
                return "\(role):\(text)"
            }
            return nil
        }
        #expect(rendered == [
            "user:你好",
            "assistant:你好！有什么可以帮你的？",
            "user:你是谁",
            "assistant:我是一个编码 agent。",
        ])
    }

    @Test("a real exchange renders in full")
    func realExchange() throws {
        // The prompts and replies below are copied verbatim out of a session log
        // on this machine, trimmed only of tool-call arguments. The key placement
        // is theirs, not mine: a user message keeps its parts at `data.content`,
        // and a message the model produced keeps them at `data.message.content`.
        //
        // That placement is what was wrong. Every reply was missing from the
        // phone while the Mac showed the whole exchange, and no test caught it
        // because every fixture had been written to match the parser rather than
        // the host.
        let result = try page("""
        {"sessionId":"s1","asOfSeq":660,"hasMore":false,"records":[
          {"type":"event","event":{"type":"user/message","seq":336,"time":1791089283671,"data":{"content":[{"type":"text","text":"请开始修复。注意仍然保持目前良好的GUI与内核解耦状态"}],"source":{"kind":"user"},"role":"user"}}},
          {"type":"event","event":{"type":"assistant/message","seq":338,"time":1791089283672,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"reasoning","text":""},{"type":"text","text":"I'll fix the four issues while preserving the C-ABI-only decoupling."}],"source":{"kind":"model","provider":"deepseek-account","model":"deepseek-flash"}}}}},
          {"type":"event","event":{"type":"user/message","seq":340,"time":1791089283673,"data":{"content":[{"type":"text","text":"允许你写入ISC-Core了"}],"source":{"kind":"user"},"role":"user"}}},
          {"type":"event","event":{"type":"assistant/message","seq":342,"time":1791089283674,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"reasoning","text":""},{"type":"text","text":"Write access to ISC-Core is now available."}],"source":{"kind":"model","provider":"deepseek-account","model":"deepseek-flash"}}}}}
        ]}
        """)
        let rendered = result.conversationItems().compactMap { item -> String? in
            if case .message(_, let role, let text, _) = item { return "\(role):\(text)" }
            return nil
        }
        #expect(rendered == [
            "user:请开始修复。注意仍然保持目前良好的GUI与内核解耦状态",
            "assistant:I'll fix the four issues while preserving the C-ABI-only decoupling.",
            "user:允许你写入ISC-Core了",
            "assistant:Write access to ISC-Core is now available.",
        ])
    }

    @Test("a record written without the gateway wrapper is read the same way")
    func unwrappedRecord() throws {
        let result = try page("""
        {"sessionId":"s1","asOfSeq":30,"hasMore":false,"records":[
          {"type":"assistant/message","seq":29,"time":1791089307181,
           "data":{"message":{"role":"assistant","content":[{"type":"text","text":"unwrapped reply"}]}}}
        ]}
        """)
        guard case .message(_, let role, let text, _) = result.conversationItems().first else {
            Issue.record("expected a message from an unwrapped record")
            return
        }
        #expect(role == .assistant)
        #expect(text == "unwrapped reply")
    }
}

@Suite("Conversation cache")
struct ConversationCacheTests {
    private func item(_ id: String, _ text: String, at: Double) -> ConversationItem {
        .message(id: id, role: .user, text: text, at: Date(timeIntervalSince1970: at))
    }

    @Test("round-trips through a file, keeping order and roles")
    func roundTrip() async throws {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mizar-cache-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }

        let cache = FileConversationCache(directory: directory)
        let conversation = CachedConversation(
            sessionId: "session-1",
            items: [
                .message(id: "a", role: .user, text: "你好", at: Date(timeIntervalSince1970: 1)),
                .message(id: "b", role: .assistant, text: "reply", at: Date(timeIntervalSince1970: 2)),
                .failure(id: "c", message: "the turn ended", at: Date(timeIntervalSince1970: 3)),
            ],
            throughSeq: 42,
            hasMore: true,
        )
        await cache.save(conversation)

        let loaded = try #require(await cache.load(sessionId: "session-1"))
        #expect(loaded.items == conversation.items)
        #expect(loaded.throughSeq == 42)
        #expect(loaded.hasMore)
    }

    @Test("merges by id rather than appending")
    func mergeById() {
        // The page and the cache overlap on every refresh, and concatenating
        // them duplicates everything they share.
        let cached = [item("a", "one", at: 1), item("b", "two", at: 2)]
        let fresh = [item("b", "two", at: 2), item("c", "three", at: 3)]
        let merged = mergeConversations(cached: cached, fresh: fresh)
        #expect(merged.count == 3)
        #expect(merged.map(\.id) == ["a", "b", "c"])
    }

    @Test("fresh wins when the same id changed")
    func freshWins() {
        let cached = [item("a", "old text", at: 1)]
        let fresh = [item("a", "new text", at: 1)]
        let merged = mergeConversations(cached: cached, fresh: fresh)
        guard case .message(_, _, let text, _) = merged.first else {
            Issue.record("expected a message")
            return
        }
        #expect(text == "new text")
    }

    @Test("a session id that could escape the directory does not")
    func safeFileNames() async {
        let directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mizar-cache-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = FileConversationCache(directory: directory)
        // Session ids come over the wire; a path built from unvalidated input is
        // how a cache becomes a directory traversal.
        await cache.save(CachedConversation(sessionId: "../../etc/passwd", items: [], throughSeq: nil))
        let files = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        #expect(files.count == 1)
        #expect(!files[0].contains("/"))
    }
}
