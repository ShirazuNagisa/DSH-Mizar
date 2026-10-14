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
                      "role":"user","id":"abc"},"surfaceOp":"append"}}
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
            "data":{"content":[{"type":"text","text":"one"},{"type":"image","url":"x"},
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

    @Test("an unknown event stays visible as activity")
    func unknownEvent() throws {
        // The schema is open by design, so an unrecognised name must not vanish.
        let result = try page("""
        {"sessionId":"s1","asOfSeq":1,"hasMore":false,"records":[
          {"type":"event","event":{"type":"something/entirely-new","seq":1,"time":1,"data":{}}}
        ]}
        """)
        guard case .activity(_, let label, _) = result.conversationItems()[0] else {
            Issue.record("expected activity")
            return
        }
        #expect(label == "something/entirely-new")
    }

    @Test("known activity events get readable labels")
    func knownActivity() throws {
        let result = try page("""
        {"sessionId":"s1","asOfSeq":2,"hasMore":false,"records":[
          {"type":"event","event":{"type":"turn/start","seq":1,"time":1,"data":{}}},
          {"type":"event","event":{"type":"step/end","seq":2,"time":1,"data":{}}}
        ]}
        """)
        let labels = result.conversationItems().compactMap { item -> String? in
            if case .activity(_, let label, _) = item { return label }
            return nil
        }
        #expect(labels == ["Turn started", "Step finished"])
    }

    @Test("a packed chunk run is not mistaken for a message")
    func chunkRun() throws {
        let result = try page("""
        {"sessionId":"s1","asOfSeq":1,"hasMore":false,"records":[
          {"type":"chunks","event":{"type":"assistant/delta","seq":1,"time":1,"data":{}}}
        ]}
        """)
        let items = result.conversationItems()
        #expect(items.count == 1)
        if case .activity = items[0] {} else { Issue.record("expected activity") }
    }

    @Test("an empty page produces nothing rather than a placeholder")
    func emptyPage() throws {
        let result = try page("""
        {"sessionId":"s1","asOfSeq":null,"hasMore":false,"records":[]}
        """)
        #expect(result.conversationItems().isEmpty)
    }
}
