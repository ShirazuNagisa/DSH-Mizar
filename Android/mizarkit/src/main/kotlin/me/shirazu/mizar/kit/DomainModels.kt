package me.shirazu.mizar.kit

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * What the host reports, typed.
 *
 * Every optional here mirrors an optional on the host, and the rule the whole app
 * is built on lives in this file: **an absent projection key means the capability
 * is not composed, not that its value is zero.** `cacheHit == null` renders as "—",
 * `tokenUsage == {0,0,0,0}` renders as `0`, and nothing anywhere converts one into
 * the other.
 */

/** `host.info`. */
@Serializable
data class HostInfo(
    val hostId: String,
    val hostName: String,
    val home: String,
    val protocolVersion: Int,
)

/** `session.list`. */
@Serializable
data class SessionListResult(val items: List<SessionRow> = emptyList())

/** `workspace.list` — the workspaces DSH has *now*, which is not the same as the directories sessions live in. */
@Serializable
data class WorkspaceListResult(val items: List<WorkspaceRow> = emptyList())

/** One workspace DSH knows about. */
@Serializable
data class WorkspaceRow(
    val workspaceId: String,
    val path: String,
    val title: String,
)

/**
 * One row in the session list.
 *
 * @property updatedAt epoch **milliseconds** as a double: the host sends a JSON
 *   number, and narrowing it to an `Int` would date every session to 1970.
 * @property blank a session that exists but has never been prompted.
 * @property agentAvailable whether an agent is configured for it at all.
 */
@Serializable
data class SessionRow(
    val sessionId: String,
    val updatedAt: Double,
    val running: Boolean,
    val blank: Boolean,
    val agentAvailable: Boolean,
    val cwd: String? = null,
    val parentSessionId: String? = null,
    val origin: String? = null,
) {
    /** Epoch milliseconds, for formatting. */
    val updatedMillis: Long get() = updatedAt.toLong()

    /**
     * Whether this is a delegated child rather than a session the operator opened.
     *
     * Either signal is enough: a subagent sets `origin`, a fork sets a parent.
     */
    val isSubagent: Boolean get() = origin == "subagent" || parentSessionId != null
}

/** `session.stats`. */
@Serializable
data class SessionStatsResult(
    val sessionId: String,
    val asOfSeq: Double? = null,
    val stats: SessionStatsFrame? = null,
)

/**
 * The usage frame.
 *
 * Every field is an independent optional: any subset may arrive, and `null` means
 * "this host cannot report it", never "zero".
 */
@Serializable
data class SessionStatsFrame(
    val tokenUsage: TokenUsage? = null,
    val cacheHit: CacheHit? = null,
    val context: ContextPressure? = null,
    val stats: Throughput? = null,
    val model: ModelSelectionPair? = null,
    val permissionPreset: String? = null,
    val title: String? = null,
)

/** The four counters, plus the host's own sum of the three inputs. */
@Serializable
data class TokenUsage(
    val uncachedInputTokens: Long,
    val outputTokens: Long,
    val cacheReadTokens: Long,
    val cacheWriteTokens: Long,
    val billedInputTokens: Long,
)

/**
 * A cache hit ratio.
 *
 * @property displayPercent a **string** on purpose: the host decides the precision,
 *   and an app that re-rounded it could turn 99.96% into "100%", which is the one
 *   claim a cache report must never make.
 */
@Serializable
data class CacheHit(
    val ratio: Double? = null,
    val displayPercent: String? = null,
)

/** How full the context window is. */
@Serializable
data class ContextPressure(
    val window: Long? = null,
    val pressureTokens: Long? = null,
    val projectedTokens: Long? = null,
    val percent: Int? = null,
    val breakdown: ContextBreakdown? = null,
)

/** The breakdown, which deliberately does not sum to `projectedTokens`. */
@Serializable
data class ContextBreakdown(
    val systemTokens: Long,
    val toolsTokens: Long,
    val messageTokens: Long,
)

/** Throughput figures for a session. */
@Serializable
data class Throughput(
    val turns: Long,
    val steps: Long,
    val llmMs: Double,
    val toolMs: Double,
    val ttftMs: Double? = null,
    val decodeTokensPerSecond: Double? = null,
)

/** The model in use, and the one the next turn will use. */
@Serializable
data class ModelSelectionPair(
    val lastUsed: ModelSelection? = null,
    val next: ModelSelection? = null,
)

/** One provider/model/effort route. */
@Serializable
data class ModelSelection(
    val provider: String,
    val model: String,
    val reasoningEffort: String? = null,
)

/** `model.catalog`. */
@Serializable
data class ModelCatalog(
    // `default` is a keyword on the Swift side, hence the rename; the wire key is
    // still `default`.
    @SerialName("default") val defaultSelection: ModelSelection? = null,
    val providers: List<ProviderGroup> = emptyList(),
    val failures: List<CatalogFailure> = emptyList(),
)

/** One provider's models. */
@Serializable
data class ProviderGroup(
    val id: String,
    val name: String,
    val models: List<ModelOption> = emptyList(),
)

/**
 * One selectable model.
 *
 * @property efforts never `null`: absent decodes to an empty list, because the
 *   picker branches on emptiness and sending an effort to a model that has none is
 *   an error upstream rather than something to clamp.
 */
@Serializable
data class ModelOption(
    val id: String,
    val name: String,
    val description: String? = null,
    val efforts: List<ReasoningEffortOption> = emptyList(),
    val defaultEffort: String? = null,
)

/** One reasoning-effort level. */
@Serializable
data class ReasoningEffortOption(
    val id: String,
    val name: String,
    val description: String? = null,
)

/** A provider that could not be listed. Shown, not hidden. */
@Serializable
data class CatalogFailure(
    val id: String,
    val name: String,
    val message: String,
)

/** `session.model.set`. */
@Serializable
data class SelectModelResult(
    val sessionId: String,
    val selected: ModelSelection,
)

/** `permissions.catalog`. */
@Serializable
data class PermissionCatalog(
    val options: List<PermissionOption> = emptyList(),
    val defaults: List<PermissionOption> = emptyList(),
    val defaultPreset: String = "",
)

/**
 * One permission preset.
 *
 * @property isDangerous exactly `danger-full-access`: `auto` is broad but not this,
 *   and `custom` is derived-only — it may be the current value but is never offered
 *   as a target.
 */
@Serializable
data class PermissionOption(
    val value: String,
    val name: String,
    val description: String? = null,
) {
    val isDangerous: Boolean get() = value == "danger-full-access"
}

/** `interactions.pending`. */
@Serializable
data class PendingInteractions(
    val approvals: List<PendingApproval> = emptyList(),
    val questions: List<PendingQuestion> = emptyList(),
) {
    val isEmpty: Boolean get() = approvals.isEmpty() && questions.isEmpty()
}

/** An approval waiting for an answer. */
@Serializable
data class PendingApproval(
    val requestId: String,
    val sessionId: String? = null,
    val toolName: String,
    val callId: String? = null,
    val reason: String? = null,
    val displayReason: Map<String, String>? = null,
    val requestedAt: Double = 0.0,
) {
    /**
     * The reason to show, in the operator's language when the host offered one.
     *
     * Lookup is by the first two letters of the locale, then English, then the raw
     * reason — the order the host's own catalogue was written for.
     */
    fun reasonText(preferring: String): String? {
        val table = displayReason ?: return reason
        val language = preferring.lowercase().take(2)
        return table[language] ?: table["en"] ?: reason
    }
}

/** The only two answers an approval accepts. */
enum class ApprovalOutcome(val wire: String) {
    ALLOWED_ONCE("allowed-once"),
    REJECTED("rejected"),
}

/** A question batch waiting for answers. */
@Serializable
data class PendingQuestion(
    val callId: String,
    val sessionId: String? = null,
    val questions: List<QuestionItem> = emptyList(),
    val requestedAt: Double = 0.0,
)

/** One question inside a batch. */
@Serializable
data class QuestionItem(
    val id: String,
    val question: String,
    val detail: String? = null,
    val header: String? = null,
    val options: List<QuestionOption> = emptyList(),
    val multiSelect: Boolean = false,
    val intent: QuestionIntent? = null,
)

/** One option inside a question. */
@Serializable
data class QuestionOption(
    val label: String,
    val description: String? = null,
)

/** What the host intends the question to mean. `plan-review` changes the button's wording. */
@Serializable
data class QuestionIntent(
    val kind: String,
    val approve: String = "",
) {
    val isPlanReview: Boolean get() = kind == "plan-review"
}

/** One answer inside a batch. */
@Serializable
data class QuestionAnswer(
    val id: String,
    val selected: List<String> = emptyList(),
    val custom: String? = null,
)

/** The `question.answer` payload. */
@Serializable
data class QuestionAnswerBatch(val answers: List<QuestionAnswer>)

/** `push.register`. */
@Serializable
data class PushRegistrationResult(val registered: Boolean = false)

/** `push.unregister`. */
@Serializable
data class PushUnregisterResult(val unregistered: Boolean = false)

/** `approval.answer`, `session.cancel`, `push.presence`. */
@Serializable
data class AcceptanceResult(val accepted: Boolean = false)

/** `session.create`. */
@Serializable
data class CreateSessionResult(
    val sessionId: String,
    val agentPreset: String? = null,
)

/** `session.prompt`. */
@Serializable
data class PromptResult(
    val accepted: Boolean = false,
    val requestId: String = "",
)

/** What a command-shaped method reports back. */
@Serializable
data class CommandResult(
    val kind: String,
    val text: String? = null,
) {
    val succeeded: Boolean get() = kind == "success"
}

/** `session.permission.set`. */
@Serializable
data class SetPermissionResult(val commandResult: CommandResult? = null)

/** `session.rename`. */
@Serializable
data class RenameResult(val renamed: Boolean = false)
