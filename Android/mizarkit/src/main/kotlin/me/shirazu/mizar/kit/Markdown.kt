package me.shirazu.mizar.kit

/** How a run of markdown text should be drawn. */
enum class MarkdownStyle { BOLD, ITALIC, CODE, CODE_BLOCK, HEADING, LIST_ITEM, QUOTE, LINK }

/** One styled run, as offsets into [MarkdownDocument.text]. */
data class MarkdownSpan(val start: Int, val end: Int, val style: MarkdownStyle)

/**
 * A parsed message.
 *
 * @property text the source text with markers removed, which is what gets drawn.
 * @property spans the styling, in offset order and never overlapping.
 * @property plain whether parsing was given up on and the text is verbatim.
 */
data class MarkdownDocument(
    val text: String,
    val spans: List<MarkdownSpan>,
    val plain: Boolean,
)

/**
 * The panel's markdown, parsed without a library.
 *
 * Deliberately not a markdown implementation: the panel draws agent replies, which
 * are mostly prose with occasional emphasis, code and lists. What this must do is
 * **never fail and never lose text** — a half-streamed answer routinely arrives with
 * an unterminated code fence, and the one thing an operator must not see is a
 * message that vanished or a parser exception where a reply should be.
 *
 * The two-stage fallback the iOS client has (full parse, then inline-only, then
 * plain) exists for that case; here the fence rule handles it directly and the
 * `plain` flag is the last resort.
 */
object Markdown {

    /**
     * Whether the text is worth parsing at all.
     *
     * A cheap character scan, ported from the iOS client: most replies are plain
     * sentences, and running a parser over every one of them to discover that is
     * work for nothing.
     */
    fun looksLikeMarkdown(text: String): Boolean =
        text.contains("**") ||
            text.contains('`') ||
            LINE_MARKER_GATE.containsMatchIn(text) ||
            text.contains("](")

    /**
     * Parse, or return the text verbatim when there is nothing to parse.
     *
     * @param source the message body.
     */
    fun parse(source: String): MarkdownDocument {
        if (!looksLikeMarkdown(source)) return MarkdownDocument(source, emptyList(), plain = true)

        return try {
            val document = parseBlocks(source)
            // **Never lose a message.** A body that parses to nothing — the degenerate
            // case being a lone ``` fence, whose markers are the whole message — is
            // drawn verbatim instead of disappearing. Losing text is the one failure
            // this parser must not have.
            if (document.text.isBlank() && source.isNotBlank()) {
                MarkdownDocument(source, emptyList(), plain = true)
            } else {
                document
            }
        } catch (_: Throwable) {
            // A parser that can fail a message is worse than one that cannot style it.
            MarkdownDocument(source, emptyList(), plain = true)
        }
    }

    private fun parseBlocks(source: String): MarkdownDocument {
        val out = StringBuilder()
        val spans = mutableListOf<MarkdownSpan>()
        val lines = source.split('\n')
        var inFence = false
        var fenceStart = -1

        // The line break is written when a line *contributes* something, rather than
        // before every source line: a fence marker contributes nothing, and writing the
        // separator up front left a blank line where each of them used to be — two
        // spurious paragraph breaks around every fenced block.
        fun beginLine() {
            if (out.isNotEmpty()) out.append('\n')
        }

        for (line in lines) {
            val fence = line.trimStart().startsWith("```")
            if (fence) {
                if (!inFence) {
                    inFence = true
                    // Resolved on the first line *inside* the fence, not here: the line
                    // break in front of that line is written lazily, so a start captured
                    // now would point one character early — at the newline rather than
                    // at the code.
                    fenceStart = -1
                } else {
                    inFence = false
                    if (fenceStart >= 0) {
                        spans += MarkdownSpan(fenceStart, out.length, MarkdownStyle.CODE_BLOCK)
                    }
                }
                continue
            }
            if (inFence) {
                beginLine()
                if (fenceStart < 0) fenceStart = out.length
                out.append(line)
                continue
            }

            val heading = HEADING.matchEntire(line)
            if (heading != null) {
                beginLine()
                val start = out.length
                out.append(heading.groupValues[2])
                spans += MarkdownSpan(start, out.length, MarkdownStyle.HEADING)
                continue
            }

            val listItem = LIST_ITEM.matchEntire(line)
            if (listItem != null) {
                beginLine()
                val start = out.length
                out.append(listItem.groupValues[2].ifEmpty { line.trimStart() })
                spans += MarkdownSpan(start, out.length, MarkdownStyle.LIST_ITEM)
                continue
            }

            if (line.startsWith("> ")) {
                beginLine()
                val start = out.length
                out.append(line.removePrefix("> "))
                spans += MarkdownSpan(start, out.length, MarkdownStyle.QUOTE)
                continue
            }

            beginLine()
            appendInline(line, out, spans)
        }

        // An unterminated fence is the half-streamed case: everything after it is
        // code, which is exactly what the reader is watching arrive. An empty fence
        // has no span: there is no text to style, and `parse` draws it verbatim.
        if (inFence && fenceStart >= 0) {
            spans += MarkdownSpan(fenceStart, out.length, MarkdownStyle.CODE_BLOCK)
        }

        return MarkdownDocument(out.toString(), spans.sortedBy { it.start }, plain = false)
    }

    /** Inline markers, resolved left to right within one line. */
    private fun appendInline(line: String, out: StringBuilder, spans: MutableList<MarkdownSpan>) {
        var index = 0
        while (index < line.length) {
            val code = matchDelimited(line, index, "`", "`")
            if (code != null) {
                val start = out.length
                out.append(code.first)
                spans += MarkdownSpan(start, out.length, MarkdownStyle.CODE)
                index = code.second
                continue
            }

            val bold = matchDelimited(line, index, "**", "**")
            if (bold != null) {
                val start = out.length
                out.append(bold.first)
                spans += MarkdownSpan(start, out.length, MarkdownStyle.BOLD)
                index = bold.second
                continue
            }

            val link = LINK.find(line, index)
            if (link != null && link.range.first == index) {
                val start = out.length
                out.append(link.groupValues[1])
                spans += MarkdownSpan(start, out.length, MarkdownStyle.LINK)
                index = link.range.last + 1
                continue
            }

            val italic = matchDelimited(line, index, "*", "*") ?: matchDelimited(line, index, "_", "_")
            if (italic != null && italic.first.isNotEmpty()) {
                val start = out.length
                out.append(italic.first)
                spans += MarkdownSpan(start, out.length, MarkdownStyle.ITALIC)
                index = italic.second
                continue
            }

            out.append(line[index])
            index += 1
        }
    }

    /**
     * Find `open` at [from] and the matching `close` after it.
     *
     * @returns the inner text and the index just past the closing marker, or `null`
     *   when the pair is not there — an unmatched marker is left as literal text.
     */
    private fun matchDelimited(line: String, from: Int, open: String, close: String): Pair<String, Int>? {
        if (!line.startsWith(open, from)) return null
        val contentStart = from + open.length
        if (open == "*" && line.startsWith("**", from)) return null
        val end = line.indexOf(close, contentStart)
        if (end < 0 || end == contentStart) return null
        return line.substring(contentStart, end) to (end + close.length)
    }

    private val HEADING = Regex("^(#{1,6})\\s+(.*)$")

    /**
     * The gate for the line-anchored markers: a heading, a list item or a quote.
     *
     * A regular expression anchored on `^` or a newline, rather than the substrings
     * this started as (`"\n# "` and friends): those only matched a marker in the
     * *middle* of a message, so a body that was entirely a heading or a list — the
     * common case of a short reply — never reached the parser and was drawn with its
     * markers visible.
     */
    private val LINE_MARKER_GATE = Regex("(^|\\n)(?:#{1,6} |[-*+] |\\d+\\. |> )")
    private val LIST_ITEM = Regex("^(\\s*)(?:[-*+]|\\d+\\.)\\s+(.*)$")
    private val LINK = Regex("\\[([^\\]]+)]\\(([^)]*)\\)")
}
