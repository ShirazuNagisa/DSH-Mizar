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

    @Test("a message with no source at all is hidden rather than guessed at")
    func missingSourceIsHidden() throws {
        // Absent means "not from the operator", which is the safe reading: a
        // missed real message costs a line of dialogue, and a shown injection
        // costs the screen.
        let result = try page("""
        {"sessionId":"s1","asOfSeq":1,"hasMore":false,"records":[
          {"type":"event","event":{"type":"user/message","seq":1,"time":1,
            "data":{"content":[{"type":"text","text":"no source field"}]}}}
        ]}
        """)
        #expect(result.conversationItems().isEmpty)
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
}
