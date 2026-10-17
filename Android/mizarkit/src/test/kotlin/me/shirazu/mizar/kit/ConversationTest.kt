package me.shirazu.mizar.kit

import kotlinx.serialization.json.decodeFromJsonElement
import org.junit.jupiter.api.Test
import kotlin.test.*

/**
 * The conversation projection and the merge pipeline.
 *
 * Ported from `ConversationTests.swift`, which is the authority: the fixtures there
 * are trimmed copies of records a live host actually returned, including the failure
 * every turn on that machine ends with. The shapes are kept verbatim — a test that
 * "simplified" `data.message.content` into `data.content` would pin the parser rather
 * than the host, which is exactly how every reply went missing on the phone for a
 * while.
 *
 * The cache half of the Swift file (`FileConversationCache`) has no JVM twin in this
 * module, so what survives of it here is the pure merge functions it called:
 * `mergeConversations`, `mergeTurns` and the two passes `mergeTurns` runs.
 */
class ConversationTest {

    /** Decode a page from JSON text, the way the client decodes a `session.messages` result. */
    private fun page(json: String): SessionMessagesResult =
        WIRE_JSON.decodeFromJsonElement(WIRE_JSON.parseToJsonElement(json))

    /** The items a page draws. */
    private fun itemsOf(json: String): List<ConversationItem> = Conversation.items(page(json))

    /** The turns a page forms. */
    private fun turnsOf(json: String): List<ConversationTurn> = Conversation.turns(page(json))

    private fun message(
        id: String,
        text: String,
        atMillis: Long? = null,
        role: ConversationItem.Role = ConversationItem.Role.USER,
    ): ConversationItem.Message = ConversationItem.Message(id, role, text, atMillis)

    private fun step(id: String, text: String, atMillis: Long? = null): ConversationItem.Message =
        message(id, text, atMillis, ConversationItem.Role.ASSISTANT)

    /** A turn built from seq numbers, which is all the ordering reads. */
    private fun turn(
        number: Int?,
        promptSeqs: List<Int> = emptyList(),
        stepSeqs: List<Int> = emptyList(),
        ended: String? = null,
        startedAtMillis: Long? = null,
        endedAtMillis: Long? = null,
    ): ConversationTurn = ConversationTurn(
        turn = number,
        prompts = promptSeqs.map { message("seq-$it", "prompt $it", it.toLong()) },
        steps = stepSeqs.map { step("seq-$it", "step $it", it.toLong()) },
        startedAtMillis = startedAtMillis,
        endedAtMillis = endedAtMillis,
        endedReason = ended,
    )

    /** The `(role, text)` of every message in a page, which is what several tests assert on. */
    private fun rendered(items: List<ConversationItem>): List<String> = items.mapNotNull { item ->
        (item as? ConversationItem.Message)?.let { "${roleName(it.role)}:${it.text}" }
    }

    /** The lowercase spelling the assertions read better with. */
    private fun roleName(role: ConversationItem.Role): String = when (role) {
        ConversationItem.Role.USER -> "user"
        ConversationItem.Role.ASSISTANT -> "assistant"
        ConversationItem.Role.SYSTEM -> "system"
    }

    // MARK: - The projection

    @Test
    fun `a user message becomes a bubble`() {
        val result = page(
            """
            {"sessionId":"s1","asOfSeq":17,"hasMore":false,"records":[
              {"type":"event","event":{"type":"user/message","seq":8,"time":1791984791224,
                "data":{"content":[{"type":"text","text":"Reply with exactly: hello"}],
                          "source":{"kind":"user"},"role":"user","id":"abc"},"surfaceOp":"append"}}
            ]}
            """.trimIndent(),
        )

        val items = Conversation.items(result)
        assertEquals(1, items.size)
        val message = assertIs<ConversationItem.Message>(items[0], "expected a message, got ${items[0]}")
        assertEquals(ConversationItem.Role.USER, message.role)
        assertEquals("Reply with exactly: hello", message.text)
        assertEquals("seq-8", message.id)
        assertEquals(1791984791224L, message.atMillis)
    }

    @Test
    fun `several text parts are joined`() {
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":1,"hasMore":false,"records":[
              {"type":"event","event":{"type":"user/message","seq":1,"time":1,
                "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"one"},{"type":"image","url":"x"},
                                   {"type":"text","text":"two"}]}}}
            ]}
            """.trimIndent(),
        )
        assertEquals("one\ntwo", assertIs<ConversationItem.Message>(items[0]).text)
    }

    @Test
    fun `a failed turn is shown as a failure, not as an empty answer`() {
        // This is the real shape: every turn on a host without a provider
        // credential ends here, and showing nothing would look like a hang.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":15,"hasMore":false,"records":[
              {"type":"event","event":{"type":"assistant/attempt","seq":15,"time":1791984791236,
                "data":{"turn":1,"step":1,"stream":[
                  {"type":"chunk","time":1,"chunk":{"type":"finish","reason":{"kind":"error",
                    "failure":{"message":"no API key for provider route deepseek-official",
                               "code":"MISSING_CREDENTIAL"}}}}]}}}
            ]}
            """.trimIndent(),
        )
        val failure = assertIs<ConversationItem.Failure>(items[0], "expected a failure, got ${items[0]}")
        assertTrue(failure.message.contains("no API key"), "got ${failure.message}")
        assertEquals("seq-15", failure.id)
    }

    @Test
    fun `the error chunk wins over the text the attempt had already streamed`() {
        // A turn that ended in an error produced no answer, and drawing the partial
        // text it streamed before dying as the answer is the one thing the operator
        // must not be shown. Note `reason.failure.message`: `turn/end` uses
        // `reason.error.message`, and reading the wrong one loses the reason.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":20,"hasMore":false,"records":[
              {"type":"event","event":{"type":"assistant/attempt","seq":20,"time":5,
                "data":{"turn":1,"step":1,"stream":[
                  {"chunk":{"type":"delta","text":"half an ans"}},
                  {"chunk":{"type":"delta","text":"wer"}},
                  {"chunk":{"type":"finish","reason":{"kind":"error",
                    "failure":{"message":"the provider went away"}}}}
                ]}}}
            ]}
            """.trimIndent(),
        )
        val failure = assertIs<ConversationItem.Failure>(items[0], "expected a failure, got ${items[0]}")
        assertEquals("the provider went away", failure.message)
        assertEquals(1, items.size, "the half-streamed text was drawn beside the failure")
    }

    @Test
    fun `an error chunk with no message still says something`() {
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":1,"hasMore":false,"records":[
              {"type":"event","event":{"type":"assistant/attempt","seq":1,"time":1,
                "data":{"stream":[{"chunk":{"type":"finish","reason":{"kind":"error"}}}]}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(
            "the turn ended without a response",
            assertIs<ConversationItem.Failure>(items[0]).message,
        )
    }

    @Test
    fun `a finish chunk that is not an error does not become a failure`() {
        // Only `kind == "error"` is a failure. `completed` is a turn that answered,
        // and its text is what has to be drawn.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":3,"hasMore":false,"records":[
              {"type":"event","event":{"type":"assistant/attempt","seq":3,"time":1,
                "data":{"stream":[{"chunk":{"type":"text","text":"the answer"}},
                                  {"chunk":{"type":"finish","reason":{"kind":"completed"}}}]}}}
            ]}
            """.trimIndent(),
        )
        val message = assertIs<ConversationItem.Message>(items[0])
        assertEquals(ConversationItem.Role.ASSISTANT, message.role)
        assertEquals("the answer", message.text)
    }

    @Test
    fun `an attempt that streamed text becomes an assistant message`() {
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":2,"hasMore":false,"records":[
              {"type":"event","event":{"type":"assistant/attempt","seq":2,"time":1,
                "data":{"stream":[{"type":"chunk","chunk":{"type":"delta","text":"Hel"}},
                                  {"type":"chunk","chunk":{"type":"delta","text":"lo"}}]}}}
            ]}
            """.trimIndent(),
        )
        val message = assertIs<ConversationItem.Message>(items[0])
        assertEquals(ConversationItem.Role.ASSISTANT, message.role)
        assertEquals("Hello", message.text)
    }

    @Test
    fun `text arrives under text, delta and content, and in stream order`() {
        // The three keys the host has used for a streamed piece, and the order the
        // chunks were written in rather than any order of the keys.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":4,"hasMore":false,"records":[
              {"type":"event","event":{"type":"assistant/attempt","seq":4,"time":1,
                "data":{"stream":[
                  {"chunk":{"type":"delta","text":"a"}},
                  {"chunk":{"type":"delta","delta":"b"}},
                  {"chunk":{"type":"text","content":"c"}}
                ]}}}
            ]}
            """.trimIndent(),
        )
        assertEquals("abc", assertIs<ConversationItem.Message>(items[0]).text)
    }

    @Test
    fun `a stream with no text at all produces nothing`() {
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":5,"hasMore":false,"records":[
              {"type":"event","event":{"type":"assistant/attempt","seq":5,"time":1,
                "data":{"stream":[{"chunk":{"type":"reasoning-start"}},
                                  {"chunk":{"type":"tool-call","name":"bash"}}]}}}
            ]}
            """.trimIndent(),
        )
        assertTrue(items.isEmpty(), "an attempt with no text drew $items")
    }

    @Test
    fun `an attempt with no stream at all produces nothing`() {
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":6,"hasMore":false,"records":[
              {"type":"event","event":{"type":"assistant/attempt","seq":6,"time":1,"data":{"turn":1}}}
            ]}
            """.trimIndent(),
        )
        assertTrue(items.isEmpty())
    }

    @Test
    fun `bookkeeping events are dropped rather than rendered`() {
        // One prompt emits roughly sixteen of these for every two messages --
        // measured on a live session, not estimated. A conversation view that
        // lists them is a list of bookkeeping rows with two lines of dialogue
        // somewhere inside it.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":6,"hasMore":false,"records":[
              {"type":"event","event":{"type":"permission/preset","seq":0,"time":1,"data":{}}},
              {"type":"event","event":{"type":"sandbox/mode","seq":1,"time":1,"data":{}}},
              {"type":"event","event":{"type":"approval/policy","seq":2,"time":1,"data":{}}},
              {"type":"event","event":{"type":"agent/inbox/spliced","seq":3,"time":1,"data":{}}},
              {"type":"event","event":{"type":"turn/start","seq":4,"time":1,"data":{}}},
              {"type":"event","event":{"type":"step/start","seq":5,"time":1,"data":{}}},
              {"type":"event","event":{"type":"something/entirely-new","seq":6,"time":1,"data":{}}}
            ]}
            """.trimIndent(),
        )
        assertTrue(items.isEmpty())
    }

    @Test
    fun `a packed chunk run is not mistaken for a message`() {
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":1,"hasMore":false,"records":[
              {"type":"chunks","event":{"type":"assistant/delta","seq":1,"time":1,"data":{}}}
            ]}
            """.trimIndent(),
        )
        assertTrue(items.isEmpty())
    }

    @Test
    fun `a record with no event name at all is dropped`() {
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":1,"hasMore":false,"records":[
              {"seq":1,"time":1,"data":{"content":[{"type":"text","text":"nameless"}]}}
            ]}
            """.trimIndent(),
        )
        assertTrue(items.isEmpty())
    }

    @Test
    fun `injected context is not shown as something the operator said`() {
        // The bug this pins, measured on a live session: an eleven-character
        // prompt arrived alongside 483 characters of runtime context and 5921
        // characters of skill catalogue, all as `user/message`. Rendered as
        // bubbles, they buried the conversation -- which read as the app having
        // lost its history, and it had.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":10,"hasMore":false,"records":[
              {"type":"event","event":{"type":"user/message","seq":8,"time":1,
                "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"hello world"}]}}},
              {"type":"event","event":{"type":"user/message","seq":9,"time":1,
                "data":{"source":{"kind":"runtime-context"},"content":[{"type":"text","text":"Current runtime context. This snapshot supersedes"}]}}},
              {"type":"event","event":{"type":"user/message","seq":10,"time":1,
                "data":{"source":{"kind":"skill-catalog"},"content":[{"type":"text","text":"<system-reminder>A skill is a reusable set"}]}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(1, items.size, "expected one message, got $items")
        val message = assertIs<ConversationItem.Message>(items[0])
        assertEquals(ConversationItem.Role.USER, message.role)
        assertEquals("hello world", message.text)
    }

    @Test
    fun `the agent's own notices are not the operator speaking`() {
        // The census, from a real session log. Every `user/message` by
        // `source.kind`, and only `user` is a person:
        //
        //     13  user                the operator, typing
        //      7  tool-jobs           a background job finished
        //      6  runtime-context     injected context
        //      4  subagent-settled    a subagent stopped
        //      3  skill-catalog       injected skill list
        //      3  goal                a goal round
        //      2  user-approval       a notice *about* a user action
        //      2  agent-message       another agent talking
        //      2  compact-checkpoint  the conversation was compacted
        //      1  model-selection     the model was changed
        //      1  plan-mode           the mode was changed
        //
        // Nine of those eleven arrived as ordinary user messages. A blocklist
        // naming two of them let the rest through, which is the pile of things
        // the operator never typed.
        val kinds = listOf(
            "tool-jobs", "runtime-context", "subagent-settled", "skill-catalog",
            "goal", "user-approval", "agent-message", "compact-checkpoint",
            "model-selection", "plan-mode",
        )
        val records = kinds.mapIndexed { index, kind ->
            """{"type":"event","event":{"type":"user/message","seq":${index + 1},"time":${index + 1},""" +
                """"data":{"source":{"kind":"$kind"},"content":[{"type":"text","text":"not mine"}]}}}"""
        }.joinToString(",")
        val items = itemsOf("""{"sessionId":"s1","asOfSeq":20,"hasMore":false,"records":[$records]}""")
        assertTrue(items.isEmpty(), "bookkeeping was drawn as a prompt: ${rendered(items)}")
    }

    @Test
    fun `a message typed on the Mac is shown, because it carries the same kind`() {
        // There is no `desktop` kind in the log. A message typed in the Mac's
        // own DSH window carries `user` like any other, which is why asking for
        // that kind by name loses nothing a person wrote.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":2,"hasMore":false,"records":[
              {"type":"event","event":{"type":"user/message","seq":1,"time":1,
                "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"from the Mac"}]}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(1, items.size)
        assertEquals("from the Mac", assertIs<ConversationItem.Message>(items[0]).text)
    }

    @Test
    fun `a message with no source is not treated as the operator's`() {
        // Every `user/message` in the census carries a kind, so an absent one is
        // an anomaly rather than a person. Guessing in that direction is how the
        // pile got here.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":1,"hasMore":false,"records":[
              {"type":"event","event":{"type":"user/message","seq":1,"time":1,
                "data":{"content":[{"type":"text","text":"no source at all"}]}}}
            ]}
            """.trimIndent(),
        )
        assertTrue(items.isEmpty())
    }

    @Test
    fun `a source nested one level deeper is still the operator's`() {
        // The host has filed the same fact at `data.message.source.kind` too, and
        // reading only the shallow key hid those messages.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":2,"hasMore":false,"records":[
              {"type":"event","event":{"type":"user/message","seq":2,"time":1,
                "data":{"message":{"content":[{"type":"text","text":"nested source"}],
                                  "source":{"kind":"user"}}}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(1, items.size)
        assertEquals("nested source", assertIs<ConversationItem.Message>(items[0]).text)
    }

    @Test
    fun `the model's reply is shown`() {
        // `assistant/message` is the committed reply and was the one event type
        // the parser did not know. A model that answered perfectly produced
        // nothing on the phone while the Mac showed the whole exchange.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":3,"hasMore":false,"records":[
              {"type":"event","event":{"type":"user/message","seq":1,"time":1,
                "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"what is 2+2"}]}}},
              {"type":"event","event":{"type":"assistant/message","seq":2,"time":2,
                "data":{"content":[{"type":"text","text":"4"}]}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(2, items.size)
        val reply = assertIs<ConversationItem.Message>(items[1], "expected the reply, got ${items[1]}")
        assertEquals(ConversationItem.Role.ASSISTANT, reply.role)
        assertEquals("4", reply.text)
    }

    @Test
    fun `a reply with no readable content falls back to its attempt chunks`() {
        // Whichever of the two carries the text, the reply has to appear.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":2,"hasMore":false,"records":[
              {"type":"event","event":{"type":"assistant/message","seq":2,"time":2,
                "data":{"stream":[{"chunk":{"type":"text","text":"from chunks"}}]}}}
            ]}
            """.trimIndent(),
        )
        assertEquals("from chunks", assertIs<ConversationItem.Message>(items[0]).text)
    }

    @Test
    fun `an assistant message holding only a failure is drawn as that failure`() {
        // The committed record and the attempt carry the same finish chunk, so the
        // fallback has to read the error out of it rather than show nothing.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":2,"hasMore":false,"records":[
              {"type":"event","event":{"type":"assistant/message","seq":2,"time":2,
                "data":{"stream":[{"chunk":{"type":"finish","reason":{"kind":"error",
                  "failure":{"message":"MISSING_CREDENTIAL"}}}}]}}}
            ]}
            """.trimIndent(),
        )
        assertEquals("MISSING_CREDENTIAL", assertIs<ConversationItem.Failure>(items[0]).message)
    }

    @Test
    fun `the same prompt arriving twice is shown once`() {
        // A prompt arrives as two user/message events with identical text -- one
        // carrying the RPC source, one from the inbox splice.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":9,"hasMore":false,"records":[
              {"type":"event","event":{"type":"user/message","seq":8,"time":1,
                "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"hello"}]}}},
              {"type":"event","event":{"type":"user/message","seq":9,"time":1,
                "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"hello"}]}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(1, items.size)
    }

    @Test
    fun `a repeated prompt that is not consecutive survives`() {
        // Consecutive duplicates only. The operator typing the same thing twice on
        // purpose, with a reply in between, is two messages.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":9,"hasMore":false,"records":[
              {"type":"event","event":{"type":"user/message","seq":1,"time":1,
                "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"again"}]}}},
              {"type":"event","event":{"type":"assistant/message","seq":2,"time":2,
                "data":{"content":[{"type":"text","text":"done"}]}}},
              {"type":"event","event":{"type":"user/message","seq":3,"time":3,
                "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"again"}]}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(listOf("user:again", "assistant:done", "user:again"), rendered(items))
    }

    @Test
    fun `an empty page produces nothing rather than a placeholder`() {
        val items = itemsOf("""{"sessionId":"s1","asOfSeq":null,"hasMore":false,"records":[]}""")
        assertTrue(items.isEmpty())
    }

    // MARK: - Shapes taken from a real session log

    @Test
    fun `the model's reply is found where a real log puts it`() {
        // Copied from a live session log, trimmed. The text is at
        // `data.message.content`, one key deeper than a user message's
        // `data.content` -- and reading only the latter is why every reply was
        // missing from the phone while the Mac showed the whole exchange.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":29,"hasMore":false,"records":[
              {"type":"event","event":{"type":"assistant/message","seq":29,"time":1791089307181,
                "data":{"turn":2,"step":1,"message":{"role":"assistant","content":[
                  {"type":"reasoning","text":""},
                  {"type":"text","text":"I will start by exploring the workspace."},
                  {"type":"tool-call","id":"call_1","name":"bash","arguments":"{}"}
                ],"source":{"kind":"model","provider":"deepseek-account","model":"deepseek-flash"}},
                "surfaceOp":"append"}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(1, items.size, "expected one reply, got $items")
        val reply = assertIs<ConversationItem.Message>(items[0])
        assertEquals(ConversationItem.Role.ASSISTANT, reply.role)
        // Only `text` parts are kept: a reasoning part and a tool call are not the
        // answer, and drawing them is how a reply becomes a transcript of machinery.
        assertEquals("I will start by exploring the workspace.", reply.text)
    }

    @Test
    fun `a tool-call-only reply produces no bubble`() {
        // A step that only calls tools has no text to show, and an empty bubble
        // per tool call would be worse than nothing.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":30,"hasMore":false,"records":[
              {"type":"event","event":{"type":"assistant/message","seq":30,"time":1,
                "data":{"message":{"role":"assistant","content":[
                  {"type":"tool-call","id":"c","name":"bash","arguments":"{}"}
                ]}}}}
            ]}
            """.trimIndent(),
        )
        assertTrue(items.isEmpty())
    }

    @Test
    fun `the system prompt is not shown as a message`() {
        // Copied from a real session: `system/message` carries the whole prompt
        // DSH hands the model, several thousand characters of it, at the top of
        // every conversation. It is not something either party said.
        val result = page(
            """
            {"sessionId":"s1","asOfSeq":7,"hasMore":false,"records":[
              {"type":"event","event":{"type":"system/message","seq":7,"time":1,
                "data":{"turn":1,"step":1,"message":{"role":"system","content":[
                  {"type":"text","text":"You are an AI agent powered by DeepSeek Harness."}
                ]}}}}
            ]}
            """.trimIndent(),
        )
        assertTrue(Conversation.items(result).isEmpty())
        // And it does not conjure a turn out of the bookkeeping either.
        assertTrue(Conversation.turns(result).isEmpty())
    }

    @Test
    fun `a whole exchange renders in order`() {
        // The end-to-end shape of what the user reported: several prompts and
        // the replies to them, in the order a log holds them.
        val items = itemsOf(
            """
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
            """.trimIndent(),
        )
        assertEquals(
            listOf(
                "user:你好",
                "assistant:你好！有什么可以帮你的？",
                "user:你是谁",
                "assistant:我是一个编码 agent。",
            ),
            rendered(items),
        )
    }

    @Test
    fun `a real exchange renders in full`() {
        // The prompts and replies below are copied verbatim out of a session log
        // on this machine, trimmed only of tool-call arguments. The key placement
        // is theirs, not mine: a user message keeps its parts at `data.content`,
        // and a message the model produced keeps them at `data.message.content`.
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":660,"hasMore":false,"records":[
              {"type":"event","event":{"type":"user/message","seq":336,"time":1791089283671,"data":{"content":[{"type":"text","text":"请开始修复。注意仍然保持目前良好的GUI与内核解耦状态"}],"source":{"kind":"user"},"role":"user"}}},
              {"type":"event","event":{"type":"assistant/message","seq":338,"time":1791089283672,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"reasoning","text":""},{"type":"text","text":"I'll fix the four issues while preserving the C-ABI-only decoupling."}],"source":{"kind":"model","provider":"deepseek-account","model":"deepseek-flash"}}}}},
              {"type":"event","event":{"type":"user/message","seq":340,"time":1791089283673,"data":{"content":[{"type":"text","text":"允许你写入ISC-Core了"}],"source":{"kind":"user"},"role":"user"}}},
              {"type":"event","event":{"type":"assistant/message","seq":342,"time":1791089283674,"data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"reasoning","text":""},{"type":"text","text":"Write access to ISC-Core is now available."}],"source":{"kind":"model","provider":"deepseek-account","model":"deepseek-flash"}}}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(
            listOf(
                "user:请开始修复。注意仍然保持目前良好的GUI与内核解耦状态",
                "assistant:I'll fix the four issues while preserving the C-ABI-only decoupling.",
                "user:允许你写入ISC-Core了",
                "assistant:Write access to ISC-Core is now available.",
            ),
            rendered(items),
        )
    }

    @Test
    fun `a record written without the gateway wrapper is read the same way`() {
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":30,"hasMore":false,"records":[
              {"type":"assistant/message","seq":29,"time":1791089307181,
               "data":{"message":{"role":"assistant","content":[{"type":"text","text":"unwrapped reply"}]}}}
            ]}
            """.trimIndent(),
        )
        val reply = assertIs<ConversationItem.Message>(items[0], "expected a message from an unwrapped record")
        assertEquals(ConversationItem.Role.ASSISTANT, reply.role)
        assertEquals("unwrapped reply", reply.text)
        assertEquals("seq-29", reply.id)
    }

    @Test
    fun `an item remembers where it sits in the log`() {
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":2,"hasMore":false,"records":[
              {"type":"event","event":{"type":"user/message","seq":4,"time":1,
                "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"positioned"}]}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(4, items[0].seq)
    }

    // MARK: - Ordering

    @Test
    fun `records written in the same millisecond keep their log order`() {
        // The scrambling. One prompt emits about eighteen records and runs of
        // them are written inside a single millisecond -- measured on a real
        // session, the first three records all carry `time: 1791089167121`. The
        // merge collected into a dictionary and sorted on the timestamp alone,
        // so those ties came out in whatever order the hash table offered, and
        // the same conversation ordered differently between one load and the
        // next. `seq` is the log's own strictly increasing counter and is what
        // settles them.
        //
        // The page below is deliberately *not* in seq order: the projection
        // appends in record order, and it is the merge that has to put them back.
        val at = 1_791_089_167_121L
        val items = itemsOf(
            """
            {"sessionId":"s1","asOfSeq":4,"hasMore":false,"records":[
              {"type":"event","event":{"type":"user/message","seq":12,"time":$at,
                "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"third"}]}}},
              {"type":"event","event":{"type":"user/message","seq":10,"time":$at,
                "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"first"}]}}},
              {"type":"event","event":{"type":"user/message","seq":11,"time":$at,
                "data":{"source":{"kind":"user"},"content":[{"type":"text","text":"second"}]}}}
            ]}
            """.trimIndent(),
        )
        // The projection keeps the log's own order: `seq` is a tie-break for the
        // merge, and re-ordering a single page in the projection is not its job.
        assertEquals(listOf(12, 10, 11), items.map { it.seq })

        val merged = mergeConversations(cached = emptyList(), fresh = items)
        assertEquals(listOf(10, 11, 12), merged.map { it.seq })
    }

    // MARK: - The merge

    @Test
    fun `merging a page into the cache does not duplicate what they share`() {
        // The page and the cache overlap on every refresh, and concatenating
        // them duplicates everything they share.
        val cached = listOf(message("a", "one", 1), message("b", "two", 2))
        val fresh = listOf(message("b", "two", 2), message("c", "three", 3))
        val merged = mergeConversations(cached, fresh)
        assertEquals(listOf("a", "b", "c"), merged.map { it.id })
    }

    @Test
    fun `fresh wins when the same id changed`() {
        val merged = mergeConversations(
            listOf(message("a", "old text", 1)),
            listOf(message("a", "new text", 1)),
        )
        assertEquals("new text", assertIs<ConversationItem.Message>(merged.first()).text)
    }

    @Test
    fun `ties in the same millisecond break on seq`() {
        val at = 1_791_089_167_121L
        val merged = mergeConversations(
            cached = listOf(
                message("seq-12", "third", at, ConversationItem.Role.ASSISTANT),
                message("seq-10", "first", at),
            ),
            fresh = listOf(message("seq-11", "second", at, ConversationItem.Role.ASSISTANT)),
        )
        assertEquals(listOf(10, 11, 12), merged.map { it.seq })
    }

    @Test
    fun `the same merge repeated gives the same order`() {
        // Dictionary iteration order varies between runs, so a comparison with
        // ties can put the same items in a different order every time. Ten runs
        // of the same input is what catches a comparator that leaves any.
        val at = 1_791_089_167_121L
        val items = (0 until 20).map {
            message("seq-$it", "line $it", at, ConversationItem.Role.ASSISTANT)
        }
        val expected = (0 until 20).map { "seq-$it" }
        repeat(10) {
            // Shuffled on the way in: the merge is not allowed to depend on the
            // order it is handed either.
            val merged = mergeConversations(items.shuffled(), items.shuffled())
            assertEquals(expected, merged.map { it.id })
        }
    }

    @Test
    fun `an item with no log position still sorts`() {
        // Not every item carries a position -- the id shape is `seq-<n>` and
        // anything else has none. Those still have to land somewhere
        // rather than crashing or vanishing.
        val merged = mergeConversations(
            cached = listOf(message("unknown", "no position", 2)),
            fresh = listOf(message("seq-9", "positioned", 1)),
        )
        assertEquals(listOf("seq-9", "unknown"), merged.map { it.id })
    }

    @Test
    fun `an item with no timestamp at all still sorts`() {
        val merged = mergeConversations(
            cached = listOf(message("unknown-a", "no time")),
            fresh = listOf(message("seq-9", "positioned", 1)),
        )
        assertEquals(listOf("unknown-a", "seq-9"), merged.map { it.id })
    }

    // MARK: - Turn grouping

    @Test
    fun `a turn's steps are grouped, and its prompt is not`() {
        // The shape that made the model look like it was talking to itself: one
        // prompt, three steps, and a reader with no idea they belonged together.
        // Every record carries `data.turn`; that is what does the grouping.
        val turns = turnsOf(
            """
            {"sessionId":"s1","asOfSeq":20,"hasMore":false,"records":[
              {"type":"event","event":{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}},
              {"type":"event","event":{"type":"user/message","seq":2,"time":1100,
                "data":{"content":[{"type":"text","text":"fix the parser"}],"source":{"kind":"user"}}}},
              {"type":"event","event":{"type":"step/start","seq":3,"time":1200,"data":{"turn":1,"step":1}}},
              {"type":"event","event":{"type":"assistant/message","seq":4,"time":1300,
                "data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"Looking at it."}]}}}},
              {"type":"event","event":{"type":"step/end","seq":5,"time":1400,"data":{"turn":1,"step":1}}},
              {"type":"event","event":{"type":"assistant/message","seq":6,"time":1500,
                "data":{"turn":1,"step":2,"message":{"role":"assistant","content":[{"type":"text","text":"Found it."}]}}}},
              {"type":"event","event":{"type":"assistant/message","seq":7,"time":1600,
                "data":{"turn":1,"step":3,"message":{"role":"assistant","content":[{"type":"text","text":"Fixed."}]}}}},
              {"type":"event","event":{"type":"turn/end","seq":8,"time":2000,
                "data":{"turn":1,"reason":{"kind":"completed"}}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(1, turns.size)
        val turn = turns.first()
        // The prompt stays out of the collapse: it is what the operator typed.
        assertEquals(1, turn.prompts.size)
        assertEquals(3, turn.steps.size)
        assertEquals(1000L, turn.durationMillis)
        assertFalse(turn.failed)
        assertTrue(turn.isCollapsible)
        assertEquals(1, turn.turn)
        // The position is the earliest *item* the turn holds, not its `turn/start`:
        // the start record produces nothing to draw, so it has no `seq` of its own.
        assertEquals(2, turn.orderSeq)
    }

    @Test
    fun `a prompt that arrives after its turn started is claimed by that turn`() {
        // `user/message` is normally logged before the `turn/start` it begins, but
        // the other order happens, and whichever of the two comes first claims it.
        val turns = turnsOf(
            """
            {"sessionId":"s1","asOfSeq":3,"hasMore":false,"records":[
              {"type":"event","event":{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}},
              {"type":"event","event":{"type":"user/message","seq":2,"time":1100,
                "data":{"content":[{"type":"text","text":"after the start"}],"source":{"kind":"user"}}}},
              {"type":"event","event":{"type":"assistant/message","seq":3,"time":1200,
                "data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"on it"}]}}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(1, turns.size)
        assertEquals(listOf("seq-2"), turns.first().prompts.map { it.id })
        assertEquals(listOf("seq-3"), turns.first().steps.map { it.id })
    }

    @Test
    fun `a prompt that arrives before its turn started is claimed too`() {
        val turns = turnsOf(
            """
            {"sessionId":"s1","asOfSeq":3,"hasMore":false,"records":[
              {"type":"event","event":{"type":"user/message","seq":1,"time":1000,
                "data":{"content":[{"type":"text","text":"before the start"}],"source":{"kind":"user"}}}},
              {"type":"event","event":{"type":"turn/start","seq":2,"time":1100,"data":{"turn":1}}},
              {"type":"event","event":{"type":"assistant/message","seq":3,"time":1200,
                "data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"on it"}]}}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(1, turns.size)
        assertEquals(1, turns.first().turn)
        assertEquals(listOf("seq-1"), turns.first().prompts.map { it.id })
    }

    @Test
    fun `a trailing prompt with no turn of its own still gets a group`() {
        // `user/message` is logged before the `turn/start` it begins, so a page
        // cut in that gap holds a prompt with no turn number. Nothing is working
        // on it, and drawing it as "正在处理" would claim an agent was thinking
        // about a message that may be the last thing anybody ever said.
        val turns = turnsOf(
            """
            {"sessionId":"s1","asOfSeq":9,"hasMore":false,"records":[
              {"type":"event","event":{"type":"user/message","seq":1,"time":1000,
                "data":{"content":[{"type":"text","text":"anybody there?"}],"source":{"kind":"user"}}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(1, turns.size)
        val turn = turns.first()
        assertNull(turn.turn)
        assertFalse(turn.isRunning)
        assertFalse(turn.isCollapsible)
        assertEquals(listOf("seq-1"), turn.prompts.map { it.id })
        assertEquals("unopened-1", turn.id)
    }

    @Test
    fun `a prompt with nothing after it and a turn before it stay separate`() {
        val turns = turnsOf(
            """
            {"sessionId":"s1","asOfSeq":4,"hasMore":false,"records":[
              {"type":"event","event":{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}},
              {"type":"event","event":{"type":"assistant/message","seq":2,"time":1100,
                "data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"one"}]}}}},
              {"type":"event","event":{"type":"user/message","seq":3,"time":1200,
                "data":{"content":[{"type":"text","text":"and now?"}],"source":{"kind":"user"}}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(listOf(1, null), turns.map { it.turn })
    }

    @Test
    fun `a cancelled turn is not a completed one`() {
        // `turn/end.reason.kind` is `completed` only when the agent finished. A
        // cancelled turn, a blocked one and one that ran out of context all end
        // with their own kind -- and treating anything but `error` as success
        // drew "已完成" over work that stopped halfway. The vocabulary is
        // merge-extensible, so an unknown reason is unfinished too.
        for (kind in listOf("aborted", "blocked", "max-tokens", "interrupted", "forked", "something-new")) {
            val turns = turnsOf(
                """
                {"sessionId":"s1","asOfSeq":9,"hasMore":false,"records":[
                  {"type":"event","event":{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}},
                  {"type":"event","event":{"type":"assistant/message","seq":2,"time":1200,
                    "data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"one"}]}}}},
                  {"type":"event","event":{"type":"assistant/message","seq":3,"time":1300,
                    "data":{"turn":1,"step":2,"message":{"role":"assistant","content":[{"type":"text","text":"two"}]}}}},
                  {"type":"event","event":{"type":"turn/end","seq":4,"time":4000,
                    "data":{"turn":1,"reason":{"kind":"$kind"}}}}
                ]}
                """.trimIndent(),
            )
            val turn = assertNotNull(turns.firstOrNull())
            assertTrue(turn.failed, "a turn that ended '$kind' is reported as finished")
            assertFalse(turn.isRunning, "a turn with an end record is still running")
            assertEquals(kind, turn.endedReason)
            // A failed turn is never folded: the failure is the thing the operator
            // needs to see, and hiding it behind a tap is how it goes unnoticed.
            assertFalse(turn.isCollapsible, "a failed turn was folded behind the summary bar")
        }
    }

    @Test
    fun `a completed turn is not a failed one`() {
        val turns = turnsOf(
            """
            {"sessionId":"s1","asOfSeq":3,"hasMore":false,"records":[
              {"type":"event","event":{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}},
              {"type":"event","event":{"type":"assistant/message","seq":2,"time":1200,
                "data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}}},
              {"type":"event","event":{"type":"turn/end","seq":3,"time":4000,
                "data":{"turn":1,"reason":{"kind":"completed"}}}}
            ]}
            """.trimIndent(),
        )
        assertFalse(assertNotNull(turns.firstOrNull()).failed)
    }

    @Test
    fun `a turn that produced one reply is not a crowd`() {
        // Hiding a single answer behind a tap gains nothing -- the answer is the
        // whole point of the turn.
        val turns = turnsOf(
            """
            {"sessionId":"s1","asOfSeq":9,"hasMore":false,"records":[
              {"type":"event","event":{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}},
              {"type":"event","event":{"type":"user/message","seq":2,"time":1100,
                "data":{"content":[{"type":"text","text":"hello"}],"source":{"kind":"user"}}}},
              {"type":"event","event":{"type":"assistant/message","seq":3,"time":1200,
                "data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}}}
            ]}
            """.trimIndent(),
        )
        assertFalse(assertNotNull(turns.firstOrNull()).isCollapsible)
    }

    @Test
    fun `a failed turn says so`() {
        val turns = turnsOf(
            """
            {"sessionId":"s1","asOfSeq":9,"hasMore":false,"records":[
              {"type":"event","event":{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}},
              {"type":"event","event":{"type":"turn/end","seq":2,"time":5000,
                "data":{"turn":1,"reason":{"kind":"error","error":{"message":"no API key"}}}}}
            ]}
            """.trimIndent(),
        )
        val turn = assertNotNull(turns.firstOrNull())
        assertTrue(turn.failed)
        assertEquals(4000L, turn.durationMillis)
    }

    @Test
    fun `a turn that carries a failure step is failed even when its reason is completed`() {
        // On a host with no credentials every turn ends `completed` with a failed
        // attempt inside it, so the reason alone would draw those as done.
        val turns = turnsOf(
            """
            {"sessionId":"s1","asOfSeq":4,"hasMore":false,"records":[
              {"type":"event","event":{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}},
              {"type":"event","event":{"type":"assistant/attempt","seq":2,"time":1200,
                "data":{"turn":1,"step":1,"stream":[{"chunk":{"type":"finish","reason":{"kind":"error",
                  "failure":{"message":"no API key"}}}}]}}},
              {"type":"event","event":{"type":"turn/end","seq":3,"time":4000,
                "data":{"turn":1,"reason":{"kind":"completed"}}}}
            ]}
            """.trimIndent(),
        )
        val turn = assertNotNull(turns.firstOrNull())
        assertTrue(turn.failed)
        // The failure is not drawn beside the reason as an extra item.
        assertEquals(1, turn.steps.size)
        assertIs<ConversationItem.Failure>(turn.steps[0])
    }

    @Test
    fun `an error reason is not read out of the failure key`() {
        // `turn/end` uses `reason.error.message`, but only `reason.kind` decides
        // whether the turn failed -- reading the message is not this reader's job,
        // and a `failure`-shaped reason must not be mistaken for the reason.
        val turns = turnsOf(
            """
            {"sessionId":"s1","asOfSeq":3,"hasMore":false,"records":[
              {"type":"event","event":{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}},
              {"type":"event","event":{"type":"turn/end","seq":2,"time":2000,
                "data":{"turn":1,"reason":{"kind":"completed","failure":{"message":"not a reason"}}}}}
            ]}
            """.trimIndent(),
        )
        val turn = assertNotNull(turns.firstOrNull())
        assertEquals("completed", turn.endedReason)
        assertFalse(turn.failed)
        assertTrue(turn.items.isEmpty(), "an empty turn drew items: ${turn.items}")
    }

    @Test
    fun `several turns stay in order`() {
        val turns = turnsOf(
            """
            {"sessionId":"s1","asOfSeq":9,"hasMore":false,"records":[
              {"type":"event","event":{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}},
              {"type":"event","event":{"type":"assistant/message","seq":2,"time":1100,
                "data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"one"}]}}}},
              {"type":"event","event":{"type":"turn/start","seq":3,"time":2000,"data":{"turn":2}}},
              {"type":"event","event":{"type":"assistant/message","seq":4,"time":2100,
                "data":{"turn":2,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"two"}]}}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(listOf(1, 2), turns.map { it.turn })
    }

    @Test
    fun `a turn with no end is running, not finished`() {
        // The reported bug. A turn that is still working has no `turn/end`, and
        // the reader invented an end time from the last record it held -- so a
        // live turn was drawn as "已完成，用时 1 分 12 秒", with the seconds
        // measuring the age of the newest message rather than any work.
        val turns = turnsOf(
            """
            {"sessionId":"s1","asOfSeq":9,"hasMore":false,"records":[
              {"type":"event","event":{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}},
              {"type":"event","event":{"type":"user/message","seq":2,"time":1100,
                "data":{"content":[{"type":"text","text":"refactor it"}],"source":{"kind":"user"}}}},
              {"type":"event","event":{"type":"assistant/message","seq":3,"time":5000,
                "data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"Halfway"}]}}}}
            ]}
            """.trimIndent(),
        )
        val turn = assertNotNull(turns.firstOrNull())
        assertTrue(turn.isRunning)
        // No duration: there is nothing that can have taken one yet.
        assertNull(turn.durationMillis)
        assertNull(turn.endedAtMillis)
        // The elapsed time is still answerable, and it is measured from the
        // turn's own start rather than from the message that happens to be last.
        assertEquals(19000L, turn.elapsedMillis(asOf = 20000))
    }

    @Test
    fun `an ended turn is not running`() {
        val turns = turnsOf(
            """
            {"sessionId":"s1","asOfSeq":9,"hasMore":false,"records":[
              {"type":"event","event":{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}},
              {"type":"event","event":{"type":"assistant/message","seq":2,"time":1200,
                "data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"done"}]}}}},
              {"type":"event","event":{"type":"turn/end","seq":3,"time":4000,
                "data":{"turn":1,"reason":{"kind":"completed"}}}}
            ]}
            """.trimIndent(),
        )
        val turn = assertNotNull(turns.firstOrNull())
        assertFalse(turn.isRunning)
        // A clock far past the end does not extend a finished turn.
        assertEquals(3000L, turn.elapsedMillis(asOf = 9_000_000))
    }

    @Test
    fun `a turn whose start record is missing is not running either`() {
        // The end record is the only thing that ends a turn and the start record
        // is the only thing that starts one: steps on their own are not "running".
        val turns = turnsOf(
            """
            {"sessionId":"s1","asOfSeq":9,"hasMore":false,"records":[
              {"type":"event","event":{"type":"assistant/message","seq":1,"time":1200,
                "data":{"turn":7,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"orphan"}]}}}}
            ]}
            """.trimIndent(),
        )
        val turn = assertNotNull(turns.firstOrNull())
        assertNull(turn.startedAtMillis)
        assertTrue(turn.isRunning, "a numbered step group with no start is running: the number says it has one")
        // It still knows when it began, from its oldest item.
        assertEquals(1200L, turn.beganAtMillis)
    }

    @Test
    fun `a record with no turn number still becomes a step rather than a prompt`() {
        val turns = turnsOf(
            """
            {"sessionId":"s1","asOfSeq":1,"hasMore":false,"records":[
              {"type":"event","event":{"type":"assistant/message","seq":1,"time":1200,
                "data":{"message":{"role":"assistant","content":[{"type":"text","text":"unplaced"}]}}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(1, turns.size)
        assertEquals(listOf("seq-1"), turns.first().steps.map { it.id })
        assertTrue(turns.first().prompts.isEmpty())
    }

    @Test
    fun `two turns interleaved in the log keep one group each`() {
        // A continuation can start before the previous turn's last step is written;
        // the group is by turn number, not by adjacency in the log.
        val turns = turnsOf(
            """
            {"sessionId":"s1","asOfSeq":6,"hasMore":false,"records":[
              {"type":"event","event":{"type":"turn/start","seq":1,"time":1000,"data":{"turn":1}}},
              {"type":"event","event":{"type":"turn/start","seq":2,"time":1100,"data":{"turn":2}}},
              {"type":"event","event":{"type":"assistant/message","seq":3,"time":1200,
                "data":{"turn":1,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"one"}]}}}},
              {"type":"event","event":{"type":"assistant/message","seq":4,"time":1300,
                "data":{"turn":2,"step":1,"message":{"role":"assistant","content":[{"type":"text","text":"two"}]}}}}
            ]}
            """.trimIndent(),
        )
        assertEquals(listOf(1, 2), turns.map { it.turn })
        assertEquals(listOf("seq-3"), turns[0].steps.map { it.id })
        assertEquals(listOf("seq-4"), turns[1].steps.map { it.id })
    }

    // MARK: - Turn merging

    @Test
    fun `overlapping pages do not duplicate turns`() {
        // Consecutive pages overlap, and appending one to the other would double
        // every turn they share.
        val merged = mergeTurns(
            cached = listOf(turn(1, stepSeqs = listOf(10)), turn(2, stepSeqs = listOf(20))),
            fresh = listOf(turn(2, stepSeqs = listOf(20)), turn(3, stepSeqs = listOf(30))),
        )
        assertEquals(listOf(1, 2, 3), merged.map { it.turn })
    }

    @Test
    fun `the fresh page wins`() {
        val merged = mergeTurns(
            cached = listOf(
                ConversationTurn(1, emptyList(), listOf(step("t1", "stored")), null, null, null),
            ),
            fresh = listOf(
                ConversationTurn(1, emptyList(), listOf(step("t1", "rewritten")), null, null, null),
            ),
        )
        assertEquals(listOf(1), merged.map { it.turn })
        assertEquals("rewritten", assertIs<ConversationItem.Message>(merged.first().steps.first()).text)
    }

    @Test
    fun `a turn with no number sorts last, not first`() {
        // "Unknown" is not "earliest".
        val merged = mergeTurns(
            cached = listOf(turn(1, stepSeqs = listOf(10))),
            fresh = listOf(turn(null, stepSeqs = listOf(20))),
        )
        assertEquals(listOf(1, null), merged.map { it.turn })
    }

    @Test
    fun `a group with no turn number sorts by position, not to the end`() {
        // The old comparator sorted on `turn ?? Int.max`, so anything the log did
        // not place was drawn after everything else no matter how old it was.
        val early = turn(null, promptSeqs = listOf(10))
        // Given its own prompt, so it is not a candidate for reclaiming and the
        // ordering is what is under test.
        val late = turn(5, promptSeqs = listOf(50), stepSeqs = listOf(51))

        val merged = mergeTurns(cached = emptyList(), fresh = listOf(late, early))

        assertEquals(listOf("seq-10"), merged.first().prompts.map { it.id })
    }

    @Test
    fun `two unnumbered groups do not collapse into one`() {
        // Every group without a number used to be identified as "unopened", and
        // the merge is a dictionary keyed on that -- so all of them but the last
        // were overwritten and their prompts disappeared.
        val first = turn(null, promptSeqs = listOf(10))
        val second = turn(null, promptSeqs = listOf(20))

        val merged = mergeTurns(cached = emptyList(), fresh = listOf(first, second))

        assertEquals(2, merged.size)
        assertEquals(listOf(10, 20), merged.flatMap { it.prompts }.map { it.seq })
    }

    @Test
    fun `a turn that straddles the page window keeps its prompt`() {
        // The host trims a page to the newest few hundred messages, so the turn
        // crossing the window's oldest edge comes back **without the prompt that
        // began it**. Replacing the stored turn with that copy deleted the
        // operator's own message from the conversation -- and from the screen,
        // because the view draws turns and the turn no longer held it. Nothing
        // they could do on the phone brought it back.
        val stored = turn(78, promptSeqs = listOf(9628), stepSeqs = listOf(9630))
        val windowed = turn(78, stepSeqs = listOf(9700))

        val merged = mergeTurns(cached = listOf(stored), fresh = listOf(windowed))

        assertEquals(1, merged.size)
        assertEquals(listOf(9628), merged.first().prompts.map { it.seq })
        assertEquals(listOf(9630, 9700), merged.first().steps.map { it.seq })
    }

    @Test
    fun `an older page cannot un-end a turn`() {
        // `loadOlder` passes the *older* page as `fresh`. With plain
        // "fresh wins", the copy of a turn that straddled the page boundary --
        // the one without its `turn/end`, because that record is in the newer
        // page -- replaced the copy that had it. Harmless while an end time was
        // invented from the last step; a turn that flipped back to "正在处理"
        // every time the operator scrolled up once it stopped being invented.
        val ended = ConversationTurn(
            7,
            emptyList(),
            listOf(step("t7", "done", 0)),
            startedAtMillis = 0,
            endedAtMillis = 60,
            endedReason = "completed",
        )
        val merged = mergeTurns(
            cached = listOf(ended),
            fresh = listOf(turn(7, stepSeqs = listOf(30))),
        )
        assertEquals(1, merged.size)
        assertNotNull(merged.first().endedAtMillis)
        assertFalse(merged.first().isRunning)
        assertEquals("completed", merged.first().endedReason)
    }

    @Test
    fun `a page that knows the turn ended wins over one that does not`() {
        // The other direction, which is the ordinary path: the turn finished
        // between two refreshes and the newer page carries its end.
        val merged = mergeTurns(
            cached = listOf(turn(7, stepSeqs = listOf(10))),
            fresh = listOf(
                ConversationTurn(
                    7,
                    emptyList(),
                    listOf(step("t7", "done", 0)),
                    startedAtMillis = 0,
                    endedAtMillis = 60,
                    endedReason = "completed",
                ),
            ),
        )
        assertNotNull(merged.first().endedAtMillis)
        assertFalse(merged.first().isRunning)
    }

    @Test
    fun `the earliest start of two copies of a turn is the one kept`() {
        // The start is a fact about the turn, not about the page: a window that
        // lost the `turn/start` must not move the turn's beginning later.
        val cached = ConversationTurn(1, emptyList(), emptyList(), 1000, 5000, "completed")
        val fresh = ConversationTurn(1, emptyList(), emptyList(), 2000, 5000, "completed")
        val merged = mergeTurns(cached = listOf(cached), fresh = listOf(fresh))
        assertEquals(1000L, merged.first().startedAtMillis)
        assertEquals(4000L, merged.first().durationMillis)
    }

    @Test
    fun `merging the same two pages twice does not duplicate anything`() {
        // `collapseContinuations` folds a chain that the host sends unfurled
        // again on the next page, so a turn's steps arrive both inside the
        // folded turn and beside it. Concatenating showed them twice.
        val asked = turn(2, promptSeqs = listOf(100), stepSeqs = listOf(101), ended = "completed")
        val carriedOn = turn(3, stepSeqs = listOf(200), ended = "completed")
        val once = mergeTurns(cached = emptyList(), fresh = listOf(asked, carriedOn))
        val twice = mergeTurns(cached = once, fresh = listOf(asked, carriedOn))

        assertEquals(1, twice.size)
        assertEquals(once.first().steps.map { it.id }, twice.first().steps.map { it.id })
    }

    @Test
    fun `a turn the agent continued on its own is not a second turn`() {
        // Read off a real session: long runs of consecutive `turn/start` with no
        // `user/message` between them -- turn 2 into 3 into 4 into 5, later 29
        // into 30 into 31 into 32. The screen drew each as its own "已完成" bar,
        // so one instruction came back as two finished turns stacked under one
        // message.
        val asked = turn(2, promptSeqs = listOf(100), stepSeqs = listOf(101), ended = "completed")
        val carriedOn = turn(3, stepSeqs = listOf(200, 201), ended = "completed")
        val andOn = turn(4, stepSeqs = listOf(300), ended = "completed")

        val merged = mergeTurns(cached = emptyList(), fresh = listOf(asked, carriedOn, andOn))

        assertEquals(1, merged.size, "the continuation is its own turn again")
        assertEquals(listOf(100), merged.first().prompts.map { it.seq })
        assertEquals(listOf(101, 200, 201, 300), merged.first().steps.map { it.seq })
    }

    @Test
    fun `a turn with its own prompt is never absorbed`() {
        // The collapse keys on the *absence* of a prompt. Two instructions in a
        // row are two turns, however quickly they follow each other.
        val first = turn(7, promptSeqs = listOf(10), stepSeqs = listOf(11), ended = "completed")
        val second = turn(8, promptSeqs = listOf(20), stepSeqs = listOf(21), ended = "completed")

        val merged = mergeTurns(cached = emptyList(), fresh = listOf(first, second))

        assertEquals(2, merged.size)
        assertEquals(listOf(7, 8), merged.map { it.turn })
    }

    @Test
    fun `a prompt stranded at a page edge goes back to its turn`() {
        // The shape read off a real session. `turn/start` for turn 78 is at seq
        // 9625 and the prompt that began it at 9628, so a page cut at 9629 holds
        // the prompt and nothing that claims it -- the prompt became its own
        // group, which then sorted to the end of the conversation, drawing a
        // message sent at 09:57 underneath one sent at 12:01.
        val stranded = turn(null, promptSeqs = listOf(9628))
        val turn78 = turn(78, stepSeqs = listOf(9630, 9631))
        val turn79 = turn(79, promptSeqs = listOf(9800), stepSeqs = listOf(9801))

        val merged = mergeTurns(cached = listOf(stranded, turn78), fresh = listOf(turn79))

        assertEquals(listOf(78, 79), merged.map { it.turn })
        assertEquals(listOf(9628), merged.first().prompts.map { it.seq })
    }

    @Test
    fun `a prompt is not reclaimed by a turn that already has one`() {
        // The pairing rule is deliberate: a turn that arrived with a prompt of its
        // own already has the thing that began it, so the stranded group is a
        // prompt somebody sent that nothing has picked up -- and it stays visible
        // rather than being swallowed.
        val stranded = turn(null, promptSeqs = listOf(10))
        val claimed = turn(3, promptSeqs = listOf(20), stepSeqs = listOf(21))

        val merged = mergeTurns(cached = emptyList(), fresh = listOf(stranded, claimed))

        assertEquals(2, merged.size)
        assertEquals(listOf(null, 3), merged.map { it.turn })
        assertEquals(listOf(listOf(10), listOf(20)), merged.map { t -> t.prompts.map { it.seq } })
    }

    @Test
    fun `a prompt is not reclaimed by a turn that sits before it`() {
        // `before < after` is what makes the pairing an ordering claim: a prompt
        // written after the turn cannot have begun it.
        val merged = mergeTurns(
            cached = emptyList(),
            fresh = listOf(turn(3, stepSeqs = listOf(21)), turn(null, promptSeqs = listOf(100))),
        )
        assertEquals(listOf(3, null), merged.map { it.turn })
    }

    @Test
    fun `two unnumbered prompt groups in a row stay separate`() {
        // Two unnumbered prompt groups in a row: the first is genuinely on its
        // own, so it is released rather than held forever.
        val first = turn(null, promptSeqs = listOf(10))
        val second = turn(null, promptSeqs = listOf(20))

        val reclaimed = reclaimStrandedPrompts(listOf(first, second))
        assertEquals(2, reclaimed.size)
        assertEquals(listOf(listOf(10), listOf(20)), reclaimed.map { t -> t.prompts.map { it.seq } })

        // And through the whole pipeline, where the merge used to overwrite one
        // of them with the other.
        val merged = mergeTurns(cached = emptyList(), fresh = listOf(first, second))
        assertEquals(listOf(listOf(10), listOf(20)), merged.map { t -> t.prompts.map { it.seq } })
    }

    @Test
    fun `reclaiming leaves a page with nothing to reclaim alone`() {
        val turns = listOf(
            turn(1, promptSeqs = listOf(10), stepSeqs = listOf(11)),
            turn(2, promptSeqs = listOf(20), stepSeqs = listOf(21)),
        )
        assertEquals(turns, reclaimStrandedPrompts(turns))
        assertEquals(turns, collapseContinuations(turns))
    }

    // MARK: - Continuations and failure, together

    @Test
    fun `a turn the operator cancelled is not a completed one`() {
        // Only `error` counted as unfinished, so a turn that was cancelled --
        // and then carried on by a turn that completed -- reported "已完成" with
        // the abort folded away behind the bar. The continuation shape is the
        // real one: DSH emits consecutive `turn/start` with no user-authored
        // message between them.
        for (kind in listOf("aborted", "blocked", "interrupted", "max-tokens")) {
            // Built by hand rather than through the helper: these need real
            // start and end times, and the helper deliberately leaves them out.
            val asked = ConversationTurn(
                turn = 5,
                prompts = listOf(message("seq-10", "go", 10)),
                steps = listOf(step("seq-11", "half", 11)),
                startedAtMillis = 10,
                endedAtMillis = 20,
                endedReason = kind,
            )
            val carriedOn = ConversationTurn(
                turn = 6,
                prompts = emptyList(),
                steps = listOf(step("seq-20", "the rest", 21)),
                startedAtMillis = 21,
                endedAtMillis = 30,
                endedReason = "completed",
            )

            val merged = mergeTurns(cached = emptyList(), fresh = listOf(asked, carriedOn))

            assertEquals(1, merged.size)
            val turn = merged.first()
            assertTrue(turn.failed, "a turn that ended '$kind' and was continued is reported as finished")
            // The first unfinished reason is kept, not flattened to `error`:
            // "the operator cancelled this" and "it hit an error" are different
            // things to be told.
            assertEquals(kind, turn.endedReason)
            assertFalse(turn.isRunning)
            assertFalse(turn.isCollapsible)
        }
    }

    @Test
    fun `a continuation that failed makes the whole turn failed`() {
        // "completed" then "error" is a failed turn: the operator needs to see
        // that the work they asked for did not finish, not that the first part
        // of it did.
        val merged = mergeTurns(
            cached = emptyList(),
            fresh = listOf(
                turn(2, promptSeqs = listOf(100), stepSeqs = listOf(101), ended = "completed"),
                turn(3, stepSeqs = listOf(200), ended = "error"),
            ),
        )
        assertEquals(1, merged.size)
        assertTrue(merged.first().failed)
        assertEquals("error", merged.first().endedReason)
    }

    @Test
    fun `a failure is not cancelled out by a continuation that finished`() {
        // The other order, and the one that bit. A turn fails, the agent
        // continues, the continuation completes. Taking the later reason made
        // the whole thing report "completed", which folded the failure behind
        // the summary bar -- so the one state an operator must see was the one
        // the fold could hide.
        val merged = mergeTurns(
            cached = emptyList(),
            fresh = listOf(
                turn(2, promptSeqs = listOf(100), stepSeqs = listOf(101), ended = "error"),
                turn(3, stepSeqs = listOf(200), ended = "completed"),
            ),
        )
        assertEquals(1, merged.size)
        assertTrue(merged.first().failed)
        assertEquals("error", merged.first().endedReason)
    }

    @Test
    fun `a continuation that is still running is not drawn as finished`() {
        // The *last* turn in the chain decides whether the whole thing has ended.
        // Keeping the predecessor's end time is what drew a still-working turn as
        // "completed, in 2 min 14 s" -- a real end time that belonged to the turn
        // before.
        val asked = ConversationTurn(
            turn = 5,
            prompts = listOf(message("seq-10", "go", 10)),
            steps = listOf(step("seq-11", "half", 11)),
            startedAtMillis = 10,
            endedAtMillis = 20,
            endedReason = "completed",
        )
        val carriedOn = ConversationTurn(
            turn = 6,
            prompts = emptyList(),
            steps = listOf(step("seq-20", "still working", 21)),
            startedAtMillis = 21,
            endedAtMillis = null,
            endedReason = null,
        )

        val merged = mergeTurns(cached = emptyList(), fresh = listOf(asked, carriedOn))

        assertEquals(1, merged.size)
        val turn = merged.first()
        assertNull(turn.endedAtMillis)
        assertTrue(turn.isRunning)
        assertNull(turn.durationMillis)
    }

    @Test
    fun `a continuation folds only into a prompt-bearing turn`() {
        val merged = collapseContinuations(
            listOf(
                turn(1, promptSeqs = listOf(10), stepSeqs = listOf(11)),
                turn(2, stepSeqs = listOf(20)),
                turn(3, stepSeqs = listOf(30)),
            ),
        )
        assertEquals(1, merged.size)
        assertEquals(listOf(10), merged.first().prompts.map { it.seq })
        assertEquals(listOf(11, 20, 30), merged.first().steps.map { it.seq })
    }

    @Test
    fun `a leading continuation with nothing before it is kept`() {
        val merged = collapseContinuations(listOf(turn(1, stepSeqs = listOf(10))))
        assertEquals(1, merged.size)
        assertEquals(1, merged.first().turn)
    }

    @Test
    fun `an unfinished reason is only completed when the host said completed`() {
        for (reason in listOf("aborted", "blocked", "interrupted", "max-tokens", "forked", "unheard-of")) {
            assertEquals(reason, ConversationTurn.unfinished(reason))
        }
        assertNull(ConversationTurn.unfinished("completed"))
        assertNull(ConversationTurn.unfinished(null))
    }

    @Test
    fun `turns are ordered by log position and then by number`() {
        val early = turn(null, promptSeqs = listOf(1))
        val late = turn(2, stepSeqs = listOf(50))
        assertEquals(listOf(null, 2), listOf(early, late).sortedWith(ConversationTurn.PRECEDES).map { it.turn })

        val one = turn(1, stepSeqs = listOf(50))
        val two = turn(2, stepSeqs = listOf(50))
        assertEquals(listOf(1, 2), listOf(two, one).sortedWith(ConversationTurn.PRECEDES).map { it.turn })
    }

    @Test
    fun `a turn's identity is its number, or its position when it has none`() {
        assertEquals("7", turn(7).id)
        assertEquals("unopened-10", turn(null, promptSeqs = listOf(10)).id)
        assertEquals("unopened-head", turn(null).id)
    }

    @Test
    fun `an item's id is the log position when the log gave one`() {
        assertEquals(8, message("seq-8", "x").seq)
        assertNull(message("unknown-user/message", "x").seq)
    }
}
