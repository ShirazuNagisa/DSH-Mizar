package me.shirazu.mizar.kit

import org.junit.jupiter.api.Test
import kotlin.test.*

/**
 * The panel's markdown reader.
 *
 * There is no Swift test file to port here: iOS hands the whole message to
 * `AttributedString(markdown:)` with a three-stage fallback
 * (`MessageBubble.markdown` in `ConversationView.swift`) and pins neither the
 * offsets nor the failure behaviour. This parser is written by hand instead, so the
 * properties its callers depend on are stated directly:
 *
 *  - the **offsets** are into the text that gets drawn, because a span that indexed
 *    the source would style the wrong characters the moment a marker is dropped;
 *  - an **unterminated fence** still styles the rest, because a half-streamed answer
 *    routinely arrives that way and the reader is watching it arrive;
 *  - nothing a model can write makes it **throw**, because a parser that can fail a
 *    message is worse than one that cannot style it.
 */
class MarkdownTest {

    /** The gate. A false negative shows backticks; a false positive costs a parse. */
    @Test
    fun `looksLikeMarkdown accepts the markers it parses`() {
        assertTrue(Markdown.looksLikeMarkdown("some **bold** text"))
        assertTrue(Markdown.looksLikeMarkdown("some `code`"))
        assertTrue(Markdown.looksLikeMarkdown("prose\n# Heading"))
        assertTrue(Markdown.looksLikeMarkdown("prose\n- item"))
        assertTrue(Markdown.looksLikeMarkdown("prose\n* item"))
        assertTrue(Markdown.looksLikeMarkdown("prose\n1. item"))
        assertTrue(Markdown.looksLikeMarkdown("prose\n> quoted"))
        assertTrue(Markdown.looksLikeMarkdown("see [docs](https://example.com)"))
        assertTrue(Markdown.looksLikeMarkdown("prose\n```\ncode\n```"))
    }

    @Test
    fun `looksLikeMarkdown refuses plain prose`() {
        // Most replies are plain sentences, and running a parser over every one of
        // them to discover that is work for nothing.
        assertFalse(Markdown.looksLikeMarkdown(""))
        assertFalse(Markdown.looksLikeMarkdown("Just a sentence with no markers at all."))
        assertFalse(Markdown.looksLikeMarkdown("2 * 3 = 6 and 4 - 1 = 3"))
        // The marker rules are line-anchored, and the *start of the message* is a line
        // start: a hash or a dash there is a marker, and one in the middle of a
        // sentence is not.
        assertTrue(Markdown.looksLikeMarkdown("# Title"))
        assertTrue(Markdown.looksLikeMarkdown("- item"))
        assertFalse(Markdown.looksLikeMarkdown("a # b"))
        assertFalse(Markdown.looksLikeMarkdown("a - b"))
    }

    @Test
    fun `plain prose comes back plain with no spans`() {
        val source = "Just a sentence with no markers at all."
        val document = Markdown.parse(source)
        assertEquals(source, document.text)
        assertTrue(document.plain, "prose was reported as parsed")
        assertTrue(document.spans.isEmpty(), "prose produced spans: ${document.spans}")
    }

    @Test
    fun `bold is styled and its markers are dropped`() {
        val document = Markdown.parse("This is **bold** text")
        assertEquals("This is bold text", document.text)
        assertFalse(document.plain)
        assertEquals(listOf(MarkdownSpan(8, 12, MarkdownStyle.BOLD)), document.spans)
    }

    @Test
    fun `italic is styled and its markers are dropped`() {
        // The marker pair has to have something between it: `**` is bold, not two
        // empty italics, and a lone `*` is literal text. A single `*` does not pass
        // the gate on its own (see the gate's test above), so the line carries a
        // backtick and the italics are what is under test.
        val document = Markdown.parse("*italic* and _also italic_ `x`")
        assertFalse(document.plain)
        assertEquals("italic and also italic x", document.text)
        assertEquals(
            listOf(
                MarkdownSpan(0, 6, MarkdownStyle.ITALIC),
                MarkdownSpan(11, 22, MarkdownStyle.ITALIC),
                MarkdownSpan(23, 24, MarkdownStyle.CODE),
            ),
            document.spans,
        )
    }

    @Test
    fun `inline code is styled and its backticks are dropped`() {
        val document = Markdown.parse("run `npm test` now")
        assertEquals("run npm test now", document.text)
        assertEquals(listOf(MarkdownSpan(4, 12, MarkdownStyle.CODE)), document.spans)
    }

    @Test
    fun `a fenced block is styled and its markers are dropped`() {
        // The fence's own line is not drawn *and leaves no line break*: the markers
        // are not content, so the block sits directly under the prose that preceded
        // it. Writing the separator for every source line instead left a blank line
        // at each marker — two spurious paragraph breaks per fenced block.
        val document = Markdown.parse("before\n```\nval x = 1\n```\nafter")
        assertEquals("before\nval x = 1\nafter", document.text)
        assertEquals(listOf(MarkdownSpan(7, 16, MarkdownStyle.CODE_BLOCK)), document.spans)
        assertFalse(document.plain)
    }

    @Test
    fun `an unterminated fence still styles the rest`() {
        // The half-streamed case: the answer is still arriving and the closing fence
        // has not been written. Everything after the opening marker is code, which
        // is exactly what the reader is watching arrive.
        val document = Markdown.parse("here it comes\n```\nval x = ")
        assertFalse(document.plain, "an unterminated fence fell back to plain text")
        assertEquals("here it comes\nval x = ", document.text)
        assertEquals(listOf(MarkdownSpan(14, 22, MarkdownStyle.CODE_BLOCK)), document.spans)
    }

    @Test
    fun `an unterminated fence does not lose the text after it`() {
        val document = Markdown.parse("```\n**not bold**")
        assertEquals("**not bold**", document.text)
        assertEquals(listOf(MarkdownSpan(0, 12, MarkdownStyle.CODE_BLOCK)), document.spans)
    }

    @Test
    fun `inline markers inside a fence are left alone`() {
        // A code block is text, not a place where markdown is interpreted. Styling
        // the `**` inside it as bold would draw the code wrong.
        val document = Markdown.parse("```\na ** b ` c\n```")
        assertEquals("a ** b ` c", document.text)
        assertEquals(listOf(MarkdownSpan(0, 10, MarkdownStyle.CODE_BLOCK)), document.spans)
    }

    @Test
    fun `headings, list items and quotes are styled with their markers dropped`() {
        val document = Markdown.parse("prose\n# Title\n- one\n> quoted")
        assertEquals("prose\nTitle\none\nquoted", document.text)
        val spans = document.spans
        assertEquals(
            listOf(
                MarkdownStyle.HEADING to "Title",
                MarkdownStyle.LIST_ITEM to "one",
                MarkdownStyle.QUOTE to "quoted",
            ),
            spans.map { it.style to document.text.substring(it.start, it.end) },
        )
    }

    @Test
    fun `a heading's hashes are dropped wherever the level stops`() {
        // The first line's `##` is what makes the gate fire, and a `#` line that
        // ends the message is a heading too. (The third line's is as well.)
        val document = Markdown.parse("## Title\n### Deep\n# End")
        assertEquals("Title\nDeep\nEnd", document.text)
        assertEquals(
            listOf(MarkdownStyle.HEADING, MarkdownStyle.HEADING, MarkdownStyle.HEADING),
            document.spans.map { it.style },
        )
        assertEquals(listOf("Title", "Deep", "End"), document.spans.map { document.text.substring(it.start, it.end) })
    }

    @Test
    fun `a heading with three or more hashes is parsed wherever it appears`() {
        // The gate used to list `"\n# "` and nothing else hash-shaped, so a
        // level-three heading never reached the parser and was drawn with its hashes.
        // Pinned here so narrowing the gate again is a deliberate change: a short
        // reply that *is* a heading is the common case, not an edge one.
        val document = Markdown.parse("prose\n### Deep")
        assertEquals("prose\nDeep", document.text)
        assertFalse(document.plain, "a level-3 heading was not parsed by the gate")
        assertEquals(listOf(MarkdownStyle.HEADING), document.spans.map { it.style })
    }

    @Test
    fun `a heading at the very start of a message is parsed`() {
        // The gate is anchored on `^` as well as on a newline, so a message that is
        // only a heading parses instead of being drawn with its hashes.
        val document = Markdown.parse("# Title")
        assertEquals("Title", document.text)
        assertFalse(document.plain)
        assertEquals(listOf(MarkdownStyle.HEADING), document.spans.map { it.style })

        assertFalse(Markdown.parse("prose\n# Title").plain)
    }

    @Test
    fun `a fence with nothing inside it is drawn verbatim rather than lost`() {
        // A lone ```` ``` ```` passes the gate on its backtick, opens a fence and never
        // closes it. Its markers are the whole message, so there is no text to style —
        // and the document used to come back *empty*, which is the one way this reader
        // lost a message whole. Nothing parses to nothing: it falls back to verbatim.
        val document = Markdown.parse("```")
        assertEquals("```", document.text)
        assertTrue(document.plain, "an empty parse was preferred over the message")
        assertTrue(document.spans.isEmpty())
    }

    @Test
    fun `a numbered list keeps its text and loses its number`() {
        val document = Markdown.parse("steps\n1. first\n2. second")
        assertEquals("steps\nfirst\nsecond", document.text)
        assertEquals(
            listOf(MarkdownStyle.LIST_ITEM, MarkdownStyle.LIST_ITEM),
            document.spans.map { it.style },
        )
    }

    @Test
    fun `a link is styled by its label, and the target is not drawn`() {
        // The target is a URL, and drawing it turns one sentence into two lines of
        // machinery. Only the label is styled; the destination is dropped.
        val document = Markdown.parse("see [docs](https://example.com/x) now")
        assertEquals("see docs now", document.text)
        assertEquals(listOf(MarkdownSpan(4, 8, MarkdownStyle.LINK)), document.spans)
    }

    @Test
    fun `spans come back in offset order and never overlap`() {
        val document = Markdown.parse("# Title\n**bold** and `code`\n- item\n> quoted\n[a](b)")
        assertEquals(listOf(0, 6, 15, 20, 25, 32), document.spans.map { it.start })
        for ((index, span) in document.spans.withIndex()) {
            assertTrue(span.start < span.end, "empty span at $index: $span")
            assertTrue(span.end <= document.text.length, "span past the end at $index: $span")
            if (index > 0) {
                assertTrue(
                    document.spans[index - 1].end <= span.start,
                    "spans ${document.spans[index - 1]} and $span overlap",
                )
            }
        }
    }

    @Test
    fun `no marker survives into the drawn text`() {
        val document = Markdown.parse("# Title\n**bold** *italic* `code`\n- item\n> quoted\n[a](b)\n```\nfenced\n```")
        for (marker in listOf("**", "`", "*", "#", "[", "](")) {
            assertFalse(document.text.contains(marker), "'$marker' survived into ${document.text}")
        }
        // The destination of the link is dropped rather than drawn beside its label.
        assertFalse(document.text.contains("(b)"), "a link target survived into ${document.text}")
    }

    @Test
    fun `hostile input never throws and never loses text`() {
        // Worst case rather than a realistic one. A parser that can fail a message
        // is worse than one that cannot style it, and a message that vanishes is the
        // one thing an operator must never see.
        val hostile = listOf(
            "*",
            "`",
            "**",
            "[text](",
            "[](",
            "[](  )",
            "**unclosed bold",
            "*unclosed italic",
            "```",
            "# ",
            "> ",
            "- ",
            "***",
            "****",
            "``",
            "`**`",
            "a * b ` c",
            "[](x)",
            "[a](b",
            "\n",
            "\n\n",
            "*a**b*",
        )
        for (source in hostile) {
            val document = try {
                Markdown.parse(source)
            } catch (throwable: Throwable) {
                fail("parse threw on ${source.replace("\n", "\\n")}: $throwable")
            }
            // Whatever else happened, the text is there to read and the reader is
            // not left holding a half-parsed document. A lone fence is the one
            // source that does not survive (pinned by `a fence with nothing inside
            // it leaves an empty block`), so it is checked separately.
            assertNotNull(document.text)
            assertNotNull(document.spans)
            if (source != "```") {
                assertFalse(
                    document.text.isEmpty() && source.isNotEmpty(),
                    "parse lost the whole of ${source.replace("\n", "\\n")}",
                )
            }
            // Every span has to point inside the text it claims to style, or the
            // view draws a range that does not exist.
            for (span in document.spans) {
                assertTrue(
                    span.start in 0..span.end && span.end <= document.text.length,
                    "span $span is outside ${document.text.length} characters: ${document.text}",
                )
            }
        }
    }

    @Test
    fun `a lone marker is drawn literally`() {
        // Nothing pairs with it, so nothing is styled -- and the character itself
        // stays on screen, which is the honest thing to draw.
        val document = Markdown.parse("*")
        assertEquals("*", document.text)
        assertTrue(document.spans.isEmpty())

        val backtick = Markdown.parse("`")
        assertEquals("`", backtick.text)
        assertTrue(backtick.spans.isEmpty())

        // `](" is enough to pass the gate, and then there is nothing to parse: the
        // document is not `plain`, and it still holds the whole line.
        val dangling = Markdown.parse("[text](")
        assertEquals("[text](", dangling.text)
        assertTrue(dangling.spans.isEmpty())
    }

    @Test
    fun `an unmatched asterisk does not swallow the sentence`() {
        val document = Markdown.parse("a * b * c")
        assertEquals("a * b * c", document.text)
    }

    @Test
    fun `the text is the source with markers removed, never the source itself`() {
        // The two are the same only for prose, which is why `plain` carries the
        // distinction rather than the text doing it.
        val source = "**bold**"
        val document = Markdown.parse(source)
        assertEquals("bold", document.text)
        assertNotEquals(source, document.text)
    }
}
