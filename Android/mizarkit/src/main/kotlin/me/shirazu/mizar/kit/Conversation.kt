package me.shirazu.mizar.kit

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * `session.messages`.
 *
 * `records` stays raw JSON on purpose: the host's record shapes are
 * *merge-extensible* (a plugin can add an event type without this app knowing), so
 * the projection below decides what it recognises and leaves everything else
 * untouched. Reshaping them host-side would mean a plugin deploy for every new
 * event.
 */
@Serializable
data class SessionMessagesResult(
    val sessionId: String,
    val asOfSeq: Int? = null,
    val records: List<JsonElement> = emptyList(),
    val hasMore: Boolean = false,
)

/**
 * One record from the session log, with the two shapes it arrives in.
 *
 * The gateway wraps records as `{"type":"event","event":{…}}`; the log itself
 * writes them unwrapped, as `{"type":"assistant/message",…,"data":{…}}`. Both are
 * real, and the projection reads through [`payload`] so it does not care which it
 * got.
 */
class SessionRecord(private val raw: JsonElement) {

    /** The outer record type, or `""` for a record with none. */
    val type: String get() = raw["type"].stringValue() ?: ""

    /** The wrapped event, when this record has one. */
    private val event: JsonElement? get() = raw["event"]

    /** The event body, wrapped or not. */
    val payload: JsonElement get() = event ?: raw

    /** The event's own type, falling back to the record's. */
    val eventName: String get() = payload["type"].stringValue() ?: type

    /** The host's own timestamp for the record, in epoch milliseconds. */
    val timestampMillis: Long? get() = payload["time"].longValue()

    /**
     * A stable id for the items this record produces.
     *
     * `seq-<n>` when the log gave a position — the projection parses the number
     * back out of this id for tie-breaking, so the spelling is load-bearing.
     */
    val recordId: String
        get() = payload["seq"].intValue()?.let { "seq-$it" } ?: "unknown-$eventName"

    /** The turn this record belongs to, when it says. */
    val turn: Int? get() = payload["data"]["turn"].intValue()
}

/** One thing the conversation draws. */
sealed interface ConversationItem {
    /** Stable across merges: the same item from two pages has one id. */
    val id: String

    /** Epoch milliseconds, or `null` when the host did not say. */
    val atMillis: Long?

    /** Who said it. */
    enum class Role { USER, ASSISTANT, SYSTEM }

    data class Message(
        override val id: String,
        val role: Role,
        val text: String,
        override val atMillis: Long?,
    ) : ConversationItem

    /**
     * A one-line marker for something that happened.
     *
     * The projection below never produces one — an unknown event is dropped, not
     * drawn — but the type exists so a cache written by a build that did produce
     * them still decodes.
     */
    data class Activity(
        override val id: String,
        val label: String,
        override val atMillis: Long?,
    ) : ConversationItem

    /** A turn that ended without an answer. Rendered as a card, never as an empty reply. */
    data class Failure(
        override val id: String,
        val message: String,
        override val atMillis: Long?,
    ) : ConversationItem

    companion object {
        /**
         * A total order over items, oldest first.
         *
         * Time first and log position second. Sorting on the timestamp alone left a
         * tie for every run of records written in the same millisecond, and a
         * dictionary's iteration order then let unrelated messages swap places
         * between one load and the next.
         */
        val PRECEDES: Comparator<ConversationItem> = Comparator { left, right ->
            val byTime = compareOptional(left.atMillis, right.atMillis)
            if (byTime != 0) byTime else compareOptional(left.seq, right.seq)
        }
    }

    /** The log position, when the id carries one. */
    val seq: Int?
        get() = if (id.startsWith("seq-")) id.removePrefix("seq-").toIntOrNull() else null
}

/**
 * `null` sorts before any value, which is what Swift's `Optional` comparison does
 * and what the original ordering was written against.
 */
private fun <T : Comparable<T>> compareOptional(left: T?, right: T?): Int = when {
    left == null && right == null -> 0
    left == null -> -1
    right == null -> 1
    else -> left.compareTo(right)
}

/** One turn: a prompt, what came of it, and how it ended. */
data class ConversationTurn(
    val turn: Int?,
    val prompts: List<ConversationItem>,
    val steps: List<ConversationItem>,
    val startedAtMillis: Long?,
    val endedAtMillis: Long?,
    val endedReason: String?,
) {
    /**
     * The identity used when merging two copies of the same turn.
     *
     * An unnumbered group is identified by its position, not by the constant string
     * it used to be: several of them in one conversation shared
     * `"unopened"` and overwrote each other in the id-keyed merge.
     */
    val id: String get() = turn?.let { it.toString() } ?: "unopened-${orderSeq?.toString() ?: "head"}"

    /** Where this turn sits in the log: the earliest position it holds. */
    val orderSeq: Int? get() = items.mapNotNull { it.seq }.minOrNull()

    /** Prompts first, then everything the agent did. */
    val items: List<ConversationItem> get() = prompts + steps

    /** How long the turn took, once it has both ends. */
    val durationMillis: Long?
        get() {
            val start = startedAtMillis ?: return null
            val end = endedAtMillis ?: return null
            return maxOf(0L, end - start)
        }

    /** An unnumbered group is never "running": nothing said it started. */
    val isRunning: Boolean get() = turn != null && endedAtMillis == null

    /** When the turn began: the host's `turn/start`, or the oldest item in it. */
    val beganAtMillis: Long? get() = startedAtMillis ?: items.mapNotNull { it.atMillis }.minOrNull()

    /** How long it has been going, as of `now` (or how long it took). */
    fun elapsedMillis(asOf: Long): Long? {
        val began = beganAtMillis ?: return null
        return maxOf(0L, (endedAtMillis ?: asOf) - began)
    }

    /**
     * Whether the turn did not finish cleanly.
     *
     * Reason-based **or** by carrying a failure step: on a host with no credentials
     * every turn ends `completed` with a failed attempt inside it, so the reason
     * alone would draw those as done.
     */
    val failed: Boolean
        get() = (endedReason != null && endedReason != "completed") || steps.any { it is ConversationItem.Failure }

    /**
     * Whether the steps should be folded behind a summary bar.
     *
     * A failed turn is never folded: the failure is the thing the operator needs to
     * see, and hiding it behind a tap is how it goes unnoticed.
     */
    val isCollapsible: Boolean
        get() = if (isRunning) steps.size > 1 else steps.size > 1 && !failed

    /** This turn, with prompts put in front of the ones it already has. */
    fun prepending(prompts: List<ConversationItem>): ConversationTurn =
        copy(prompts = prompts + this.prompts)

    /**
     * This turn and the one that carried on from it, as one turn.
     *
     * The *last* turn in the chain decides whether the whole thing has ended, which
     * is why the end is taken from the continuation outright instead of falling
     * back: keeping the predecessor's end time is what drew a still-working turn as
     * "completed, in 2 min 14 s" — a real end time that belonged to the turn before.
     */
    fun absorbing(next: ConversationTurn): ConversationTurn {
        val continuation = next.startedAtMillis != null || next.endedAtMillis != null
        val unfinished = unfinished(endedReason) ?: unfinished(next.endedReason)
        return ConversationTurn(
            turn = turn,
            prompts = prompts,
            steps = union(steps, next.steps),
            startedAtMillis = startedAtMillis,
            endedAtMillis = if (continuation) next.endedAtMillis else endedAtMillis,
            endedReason = unfinished ?: if (continuation) next.endedReason else endedReason,
        )
    }

    /**
     * This turn, with another copy of itself folded in.
     *
     * Neither copy is a superset of the other: a page is a window, so the turn
     * straddling its oldest edge comes back without the prompt that began it.
     * Replacing the stored copy therefore deleted the operator's own message from
     * the conversation, and nothing they could do on the phone brought it back.
     */
    fun merging(other: ConversationTurn): ConversationTurn = ConversationTurn(
        turn = turn ?: other.turn,
        // `other` first, so this copy — the one just fetched — wins per item.
        prompts = union(other.prompts, prompts),
        steps = union(other.steps, steps),
        startedAtMillis = listOfNotNull(startedAtMillis, other.startedAtMillis).minOrNull(),
        endedAtMillis = endedAtMillis ?: other.endedAtMillis,
        endedReason = endedReason ?: other.endedReason,
    )

    companion object {
        /** A total order over turns, oldest first, by log position rather than number. */
        val PRECEDES: Comparator<ConversationTurn> = Comparator { left, right ->
            val lhs = left.orderSeq ?: Int.MAX_VALUE
            val rhs = right.orderSeq ?: Int.MAX_VALUE
            if (lhs != rhs) lhs.compareTo(rhs) else (left.turn ?: Int.MAX_VALUE).compareTo(right.turn ?: Int.MAX_VALUE)
        }

        /** Every item from both lists, once, in log order. The second list wins on a collision. */
        fun union(first: List<ConversationItem>, second: List<ConversationItem>): List<ConversationItem> {
            val byId = LinkedHashMap<String, ConversationItem>()
            for (item in first) byId[item.id] = item
            for (item in second) byId[item.id] = item
            return byId.values.sortedWith(ConversationItem.PRECEDES)
        }

        /**
         * The reason a turn did not finish, when it is one.
         *
         * Anything that is not `completed` counts: the vocabulary is
         * merge-extensible, and an unknown reason shown as done is a lie while the
         * same reason shown as unfinished is merely cautious.
         */
        fun unfinished(reason: String?): String? = if (reason == null || reason == "completed") null else reason
    }
}

/** The projection: raw records in, drawable items out. */
object Conversation {

    /** Everything a page of records draws, oldest first. */
    fun items(result: SessionMessagesResult): List<ConversationItem> {
        val out = mutableListOf<ConversationItem>()
        for (raw in result.records) {
            for (item in recordItems(SessionRecord(raw))) {
                // Consecutive duplicates only — the same prompt is written twice, once
                // by the RPC and once by the inbox splice. Non-adjacent repeats and
                // edits are real and survive.
                val last = out.lastOrNull()
                if (item is ConversationItem.Message && last is ConversationItem.Message &&
                    last.role == item.role && last.text == item.text
                ) {
                    continue
                }
                out += item
            }
        }
        return out
    }

    /** The turns a page of records forms, oldest first. */
    fun turns(result: SessionMessagesResult): List<ConversationTurn> {
        val order = mutableListOf<Int?>()
        val prompts = LinkedHashMap<Int?, MutableList<ConversationItem>>()
        val steps = LinkedHashMap<Int?, MutableList<ConversationItem>>()
        val started = HashMap<Int?, Long?>()
        val ended = HashMap<Int?, Long?>()
        val reason = HashMap<Int?, String?>()
        var pending = mutableListOf<ConversationItem>()

        fun flush(into: Int?) {
            if (pending.isEmpty()) return
            prompts.getOrPut(into) { mutableListOf() }.addAll(pending)
            pending = mutableListOf()
        }

        for (raw in result.records) {
            val record = SessionRecord(raw)
            val name = record.eventName
            val turn = record.turn
            val at = record.timestampMillis

            when (name) {
                "turn/start" -> {
                    if (turn !in order) order += turn
                    started[turn] = at
                    flush(turn)
                }

                "turn/end" -> {
                    ended[turn] = at
                    reason[turn] = record.payload["data"]["reason"]["kind"].stringValue()
                }

                "user/message", "assistant/message", "assistant/attempt", "system/message" -> {
                    val items = recordItems(record)
                    if (items.isEmpty()) continue
                    if (name == "user/message") {
                        // A prompt belongs to the turn it starts, and it is written
                        // before that turn exists.
                        if (turn != null && order.contains(turn)) {
                            prompts.getOrPut(turn) { mutableListOf() }.addAll(items)
                        } else {
                            pending.addAll(items)
                        }
                        continue
                    }
                    if (turn !in order) order += turn
                    // A prompt can also arrive after its `turn/start`; whichever of the
                    // two comes first claims it.
                    flush(turn)
                    steps.getOrPut(turn) { mutableListOf() }.addAll(items)
                }
            }
        }

        // A prompt with nothing after it still has to be on screen.
        if (pending.isNotEmpty()) {
            order += null
            prompts.getOrPut(null) { mutableListOf() }.addAll(pending)
        }

        return order.map { key ->
            ConversationTurn(
                turn = key,
                prompts = prompts[key] ?: emptyList(),
                steps = steps[key] ?: emptyList(),
                startedAtMillis = started[key],
                // Only a `turn/end` ends a turn. Falling back to the last step's time
                // made every unfinished turn look finished, with a duration that was
                // just the age of the newest message in it.
                endedAtMillis = ended[key],
                endedReason = reason[key],
            )
        }
    }

    /** The items one record produces, which is often none. */
    fun recordItems(record: SessionRecord): List<ConversationItem> = when (record.eventName) {
        "user/message" ->
            if (!isUserAuthored(record.payload)) {
                emptyList()
            } else {
                messageText(record.payload)?.let {
                    listOf(ConversationItem.Message(record.recordId, ConversationItem.Role.USER, it, record.timestampMillis))
                } ?: emptyList()
            }

        // The system prompt is thousands of characters of instructions, not a
        // message to the operator.
        "system/message" -> emptyList()

        "assistant/message" ->
            messageText(record.payload)?.let {
                listOf(ConversationItem.Message(record.recordId, ConversationItem.Role.ASSISTANT, it, record.timestampMillis))
            } ?: attemptItems(record)

        "assistant/attempt" -> attemptItems(record)

        else -> emptyList()
    }

    /**
     * Whether a `user/message` was written by the operator.
     *
     * An allowlist on `kind == "user"`, because the host also files nine other
     * kinds of bookkeeping under `user/message` (`tool-jobs`, `runtime-context`,
     * `skill-catalog`, `subagent-settled`, `goal`, `user-approval`, `agent-message`,
     * `compact-checkpoint`, `model-selection`, `plan-mode`). A missing kind is *not*
     * treated as the operator: the blocklist this replaced let all of them through,
     * and the conversation filled with system text.
     */
    private fun isUserAuthored(event: JsonElement): Boolean {
        val data = event["data"]
        val kind = data["source"]["kind"].stringValue()
            ?: data["message"]["source"]["kind"].stringValue()
        return kind == "user"
    }

    /**
     * The text of a message-shaped event.
     *
     * `data.message.content` is read before `data.content`, and only `text` parts
     * are kept: reading only the flat key is the bug that made every reply vanish.
     */
    private fun messageText(event: JsonElement): String? {
        val data = event["data"]
        val parts = data["message"]["content"].arrayValue() ?: data["content"].arrayValue() ?: return null
        val texts = parts.mapNotNull { part ->
            if (part["type"].stringValue() == "text") part["text"].stringValue() else null
        }
        return if (texts.isEmpty()) null else texts.joinToString("\n")
    }

    /**
     * What an `assistant/attempt` says.
     *
     * The error chunk wins outright: a turn that ended in an error produced no
     * answer, and drawing the partial text it streamed before dying as the answer is
     * the one thing the operator must not be shown. Note `reason.failure.message` —
     * `turn/end` uses `reason.error.message`, and reading the wrong one is a
     * plausible way to lose the reason entirely.
     */
    private fun attemptItems(record: SessionRecord): List<ConversationItem> {
        val stream = record.payload["data"]["stream"].arrayValue() ?: return emptyList()

        for (entry in stream) {
            val chunk = entry["chunk"]
            if (chunk["type"].stringValue() != "finish") continue
            val kind = chunk["reason"]["kind"].stringValue()
            if (kind != "error") continue
            val message = chunk["reason"]["failure"]["message"].stringValue()
                ?: "the turn ended without a response"
            return listOf(ConversationItem.Failure(record.recordId, message, record.timestampMillis))
        }

        val text = StringBuilder()
        for (entry in stream) {
            val chunk = entry["chunk"]
            for (key in listOf("text", "delta", "content")) {
                chunk[key].stringValue()?.let { text.append(it) }
            }
        }
        if (text.isEmpty()) return emptyList()
        return listOf(
            ConversationItem.Message(record.recordId, ConversationItem.Role.ASSISTANT, text.toString(), record.timestampMillis),
        )
    }
}

/** Fold a fresh page of items into what is already held. */
fun mergeConversations(cached: List<ConversationItem>, fresh: List<ConversationItem>): List<ConversationItem> {
    val byId = LinkedHashMap<String, ConversationItem>()
    for (item in cached) byId[item.id] = item
    // Fresh wins on a collision: it is the host's current answer.
    for (item in fresh) byId[item.id] = item
    return byId.values.sortedWith(ConversationItem.PRECEDES)
}

/**
 * Fold a fresh page of turns into what is already held.
 *
 * **Merged, not replaced**, and the reason is symmetric: a page fetched with
 * `beforeSeq` is *older* than what is stored (so "fresh wins" flipped a turn back to
 * "still running" on every scroll up), and a page is a *window* (so the turn
 * crossing its edge arrived without the prompt that began it, and replacing deleted
 * the operator's message for good).
 */
fun mergeTurns(cached: List<ConversationTurn>, fresh: List<ConversationTurn>): List<ConversationTurn> {
    val byId = LinkedHashMap<String, ConversationTurn>()
    for (turn in cached) byId[turn.id] = turn
    for (turn in fresh) {
        val known = byId[turn.id]
        byId[turn.id] = if (known == null) turn else turn.merging(known)
    }
    return collapseContinuations(reclaimStrandedPrompts(byId.values.sortedWith(ConversationTurn.PRECEDES)))
}

/**
 * Fold the turns an agent continued on its own back into the turn they continued.
 *
 * DSH does not emit one turn per prompt: a real log holds runs of consecutive
 * `turn/start` with no `user/message` between them, which the screen drew as two or
 * three stacked "completed" bars under one message.
 */
fun collapseContinuations(turns: List<ConversationTurn>): List<ConversationTurn> {
    val out = mutableListOf<ConversationTurn>()
    for (turn in turns) {
        val previous = out.lastOrNull()
        if (turn.prompts.isEmpty() && previous != null && previous.prompts.isNotEmpty()) {
            out[out.size - 1] = previous.absorbing(turn)
            continue
        }
        out += turn
    }
    return out
}

/**
 * Give a page-edge prompt back to the turn it started.
 *
 * A page can end in the gap between a prompt and the `turn/start` that opens its
 * turn, leaving a prompt-only group that sorted to the end of the conversation.
 * The pairing rule the grouping already uses is applied one page later: a group with
 * prompts and no number belongs to the next turn, when that turn sits after it and
 * arrived without a prompt of its own.
 */
fun reclaimStrandedPrompts(turns: List<ConversationTurn>): List<ConversationTurn> {
    val out = mutableListOf<ConversationTurn>()
    var held: ConversationTurn? = null
    for (turn in turns) {
        if (turn.turn == null && turn.prompts.isNotEmpty()) {
            // Two unnumbered prompt groups in a row: the first is genuinely on its
            // own, so it is released rather than held forever.
            held?.let { out += it }
            held = turn
            continue
        }
        val previous = held
        if (previous == null) {
            out += turn
            continue
        }
        held = null
        val before = previous.orderSeq
        val after = turn.orderSeq
        val followsIt = before != null && after != null && before < after
        if (turn.prompts.isEmpty() && followsIt) {
            out += turn.prepending(previous.prompts)
        } else {
            out += previous
            out += turn
        }
    }
    held?.let { out += it }
    return out
}
