/**
 * Session usage bridge.
 *
 * Everything the phone shows about cost and context comes from DSH's session
 * projections, which are folded from the durable session log and cost no model
 * calls. Four keys matter:
 *
 *   - `tokenUsage`        cumulative `{uncachedInputTokens, outputTokens,
 *                         cacheReadTokens, cacheWriteTokens}`
 *   - `contextPressure`   `{contextWindow, pressureTokens, projectedTokens}`
 *   - `contextBreakdown`  approximate `{systemTokens, toolsTokens, messageTokens}`
 *   - `sessionStats`      `{turns, steps, llmMs, toolMs, ttftMs, decode*}` (dsh-session-stats)
 *
 * Two rules are inherited from DSH and are load-bearing here:
 *
 *   1. **A missing key means the capability is absent, not zero.** A projection
 *      key disappears when its owning package is not composed, so an absent key
 *      must render as "unknown". Reporting `0` would be a lie an operator could
 *      act on.
 *   2. **The derived figures are computed here, not in the app.** Cache hit rate
 *      and context occupancy have specific, documented rounding rules — notably
 *      that a partial hit must never round up to a flat `100` — and computing
 *      them twice means they will eventually disagree.
 *
 * @module dsh-mizar/bridge/stats
 */
import type { SessionProjectionMap } from '../dsh.js';
/** The projection values this module reads. */
export type ProjectionValues = Partial<SessionProjectionMap>;
/** Cumulative billed tokens over the whole durable log. */
export interface TokenUsageView {
    /** Input tokens billed at full rate. */
    readonly uncachedInputTokens: number;
    /** Tokens produced by the model. */
    readonly outputTokens: number;
    /** Input tokens served from the provider's prompt cache. */
    readonly cacheReadTokens: number;
    /** Input tokens written into the provider's prompt cache. */
    readonly cacheWriteTokens: number;
    /** `uncachedInputTokens + cacheReadTokens + cacheWriteTokens`. */
    readonly billedInputTokens: number;
}
/** Cache effectiveness. */
export interface CacheHitView {
    /** Exact ratio in `[0, 1]`, or `null` when nothing has been billed yet. */
    readonly ratio: number | null;
    /**
     * Display-ready percentage that never overstates the saving, or `null`.
     *
     * Kept as a string because "99.96% rounds to 100%" is exactly the kind of
     * claim a cache report must not make.
     */
    readonly displayPercent: string | null;
}
/** Context-window occupancy. */
export interface ContextPressureView {
    /** The model's context window, when the provider reported one. */
    readonly window: number | null;
    /** Newest provider-reported prompt size. */
    readonly pressureTokens: number | null;
    /** What the next request's prompt would cost. */
    readonly projectedTokens: number | null;
    /** Occupancy percentage, clamped to 100, or `null` when uncomputable. */
    readonly percent: number | null;
    /** Approximate composition of the context; never sums to `projectedTokens`. */
    readonly breakdown: {
        readonly systemTokens: number;
        readonly toolsTokens: number;
        readonly messageTokens: number;
    } | null;
}
/** Throughput and latency folded from the durable log. */
export interface SessionStatsView {
    readonly turns: number;
    readonly steps: number;
    /** Milliseconds spent waiting on the model, summed over steps. */
    readonly llmMs: number;
    /** Milliseconds spent in tool calls, summed. */
    readonly toolMs: number;
    /** Time to first token, averaged over the steps that reported one. */
    readonly ttftMs: number | null;
    /** Output tokens per second while decoding, or `null` without decode timing. */
    readonly decodeTokensPerSecond: number | null;
}
/** The complete usage frame for one session. */
export interface SessionStatsFrame {
    /** `null` when the token-meter is not composed. */
    readonly tokenUsage: TokenUsageView | null;
    /** `null` when the token-meter is not composed. */
    readonly cacheHit: CacheHitView | null;
    /** `null` when the token-meter is not composed. */
    readonly context: ContextPressureView | null;
    /** `null` when the session-stats package is not composed. */
    readonly stats: SessionStatsView | null;
    /** The route the last request actually used, and any pending change. */
    readonly model: {
        readonly lastUsed: {
            provider: string;
            model: string;
            reasoningEffort?: string;
        } | null;
        readonly next: {
            provider: string;
            model: string;
            reasoningEffort?: string;
        } | null;
    } | null;
    /** The session's permission preset, or the derived `custom`. */
    readonly permissionPreset: string | null;
    /** The session title, when one has been assigned. */
    readonly title: string | null;
}
/**
 * Format a cache hit ratio so it never claims a saving that did not happen.
 *
 * Whole percentages are used while they are honest. A ratio that would round up
 * to `100` gets enough decimals to stay below it — `99.9`, `99.99`, and so on —
 * and a ratio that still rounds to `100` at the precision cap is floored.
 *
 * @param cacheReadTokens - tokens served from cache.
 * @param billedInputTokens - all billed input tokens.
 * @returns the percentage text, or `null` when nothing was billed.
 */
export declare function formatCacheHitPercent(cacheReadTokens: number, billedInputTokens: number): string | null;
/**
 * Build the token usage view.
 * @param value - the `tokenUsage` projection value.
 * @returns the view, or `null` when the key is absent.
 */
export declare function buildTokenUsage(value: unknown): TokenUsageView | null;
/**
 * Build the cache hit view from a token usage view.
 * @param usage - the token usage view.
 * @returns the cache view, or `null` without a usage view.
 */
export declare function buildCacheHit(usage: TokenUsageView | null): CacheHitView | null;
/**
 * Build the context pressure view.
 *
 * Occupancy follows DSH's own client: prefer `projectedTokens`, fall back to
 * `pressureTokens`, and clamp to 100. A window without a pressure sample (or the
 * reverse) yields no percentage rather than a guess.
 *
 * @param pressure - the `contextPressure` projection value.
 * @param breakdown - the `contextBreakdown` projection value.
 * @returns the view, or `null` when `contextPressure` is absent.
 */
export declare function buildContextPressure(pressure: unknown, breakdown: unknown): ContextPressureView | null;
/**
 * Build the throughput view.
 * @param value - the `sessionStats` projection value.
 * @returns the view, or `null` when the key is absent.
 */
export declare function buildSessionStatsView(value: unknown): SessionStatsView | null;
/**
 * Build the model selection view.
 * @param value - the `modelSelection` projection value.
 * @returns the view, or `null` when the key is absent.
 */
export declare function buildModelSelection(value: unknown): SessionStatsFrame['model'];
/** The projection keys this module reads, for a targeted snapshot. */
export declare const STATS_KEYS: readonly ["tokenUsage", "contextPressure", "contextBreakdown", "sessionStats", "modelSelection", "permissions", "title"];
/**
 * Assemble the complete usage frame from one projection snapshot.
 *
 * @param values - projection values keyed by projection name; absent keys are
 *   treated as "capability not composed" and yield `null`.
 * @returns the frame the phone renders.
 */
export declare function buildStatsFrame(values: ProjectionValues): SessionStatsFrame;
