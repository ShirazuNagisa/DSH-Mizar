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
import type { SessionProjectionMap } from '../dsh.js'

/** The projection values this module reads. */
export type ProjectionValues = Partial<SessionProjectionMap>

/** Cumulative billed tokens over the whole durable log. */
export interface TokenUsageView {
  /** Input tokens billed at full rate. */
  readonly uncachedInputTokens: number
  /** Tokens produced by the model. */
  readonly outputTokens: number
  /** Input tokens served from the provider's prompt cache. */
  readonly cacheReadTokens: number
  /** Input tokens written into the provider's prompt cache. */
  readonly cacheWriteTokens: number
  /** `uncachedInputTokens + cacheReadTokens + cacheWriteTokens`. */
  readonly billedInputTokens: number
}

/** Cache effectiveness. */
export interface CacheHitView {
  /** Exact ratio in `[0, 1]`, or `null` when nothing has been billed yet. */
  readonly ratio: number | null
  /**
   * Display-ready percentage that never overstates the saving, or `null`.
   *
   * Kept as a string because "99.96% rounds to 100%" is exactly the kind of
   * claim a cache report must not make.
   */
  readonly displayPercent: string | null
}

/** Context-window occupancy. */
export interface ContextPressureView {
  /** The model's context window, when the provider reported one. */
  readonly window: number | null
  /** Newest provider-reported prompt size. */
  readonly pressureTokens: number | null
  /** What the next request's prompt would cost. */
  readonly projectedTokens: number | null
  /** Occupancy percentage, clamped to 100, or `null` when uncomputable. */
  readonly percent: number | null
  /** Approximate composition of the context; never sums to `projectedTokens`. */
  readonly breakdown: {
    readonly systemTokens: number
    readonly toolsTokens: number
    readonly messageTokens: number
  } | null
}

/** Throughput and latency folded from the durable log. */
export interface SessionStatsView {
  readonly turns: number
  readonly steps: number
  /** Milliseconds spent waiting on the model, summed over steps. */
  readonly llmMs: number
  /** Milliseconds spent in tool calls, summed. */
  readonly toolMs: number
  /** Time to first token, averaged over the steps that reported one. */
  readonly ttftMs: number | null
  /** Output tokens per second while decoding, or `null` without decode timing. */
  readonly decodeTokensPerSecond: number | null
}

/** The complete usage frame for one session. */
export interface SessionStatsFrame {
  /** `null` when the token-meter is not composed. */
  readonly tokenUsage: TokenUsageView | null
  /** `null` when the token-meter is not composed. */
  readonly cacheHit: CacheHitView | null
  /** `null` when the token-meter is not composed. */
  readonly context: ContextPressureView | null
  /** `null` when the session-stats package is not composed. */
  readonly stats: SessionStatsView | null
  /** The route the last request actually used, and any pending change. */
  readonly model: {
    readonly lastUsed: { provider: string; model: string; reasoningEffort?: string } | null
    readonly next: { provider: string; model: string; reasoningEffort?: string } | null
  } | null
  /** The session's permission preset, or the derived `custom`. */
  readonly permissionPreset: string | null
  /** The session title, when one has been assigned. */
  readonly title: string | null
}

/**
 * Read a number field, rejecting non-finite values.
 * @param source - the object to read.
 * @param key - the field name.
 * @returns the value, or `undefined` when it is not a usable number.
 */
function num(source: unknown, key: string): number | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const value = (source as Record<string, unknown>)[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
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
export function formatCacheHitPercent(
  cacheReadTokens: number,
  billedInputTokens: number,
): string | null {
  if (billedInputTokens <= 0) return null
  if (cacheReadTokens <= 0) return '0'
  if (cacheReadTokens >= billedInputTokens) return '100'

  const ratio = cacheReadTokens / billedInputTokens
  const whole = Math.round(ratio * 100)
  if (whole < 100) return String(whole)

  for (let places = 1; places <= 4; places += 1) {
    const text = (ratio * 100).toFixed(places)
    if (Number(text) < 100) return text
  }
  // At four decimals a genuine partial hit still reads as 100, so step down to
  // the largest value below 100 rather than rounding the difference away.
  return '99.9999'
}

/**
 * Build the token usage view.
 * @param value - the `tokenUsage` projection value.
 * @returns the view, or `null` when the key is absent.
 */
export function buildTokenUsage(value: unknown): TokenUsageView | null {
  const uncached = num(value, 'uncachedInputTokens')
  const output = num(value, 'outputTokens')
  if (uncached === undefined || output === undefined) return null
  const cacheRead = num(value, 'cacheReadTokens') ?? 0
  const cacheWrite = num(value, 'cacheWriteTokens') ?? 0
  return {
    uncachedInputTokens: uncached,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    billedInputTokens: uncached + cacheRead + cacheWrite,
  }
}

/**
 * Build the cache hit view from a token usage view.
 * @param usage - the token usage view.
 * @returns the cache view, or `null` without a usage view.
 */
export function buildCacheHit(usage: TokenUsageView | null): CacheHitView | null {
  if (usage === null) return null
  const { billedInputTokens, cacheReadTokens } = usage
  return {
    ratio: billedInputTokens > 0 ? cacheReadTokens / billedInputTokens : null,
    displayPercent: formatCacheHitPercent(cacheReadTokens, billedInputTokens),
  }
}

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
export function buildContextPressure(pressure: unknown, breakdown: unknown): ContextPressureView | null {
  const window = num(pressure, 'contextWindow')
  const pressureTokens = num(pressure, 'pressureTokens')
  const projectedTokens = num(pressure, 'projectedTokens')
  if (window === undefined && pressureTokens === undefined && projectedTokens === undefined) {
    return null
  }

  const used = projectedTokens ?? pressureTokens
  const percent =
    used !== undefined && window !== undefined && window > 0
      ? Math.min(100, Math.round((used / window) * 100))
      : null

  const system = num(breakdown, 'systemTokens')
  const tools = num(breakdown, 'toolsTokens')
  const messages = num(breakdown, 'messageTokens')

  return {
    window: window ?? null,
    pressureTokens: pressureTokens ?? null,
    projectedTokens: projectedTokens ?? null,
    percent,
    breakdown:
      system === undefined && tools === undefined && messages === undefined
        ? null
        : {
            systemTokens: system ?? 0,
            toolsTokens: tools ?? 0,
            messageTokens: messages ?? 0,
          },
  }
}

/**
 * Build the throughput view.
 * @param value - the `sessionStats` projection value.
 * @returns the view, or `null` when the key is absent.
 */
export function buildSessionStatsView(value: unknown): SessionStatsView | null {
  const turns = num(value, 'turns')
  const steps = num(value, 'steps')
  if (turns === undefined || steps === undefined) return null

  const llmMs = num(value, 'llmMs') ?? 0
  const toolMs = num(value, 'toolMs') ?? 0
  const ttftMs = num(value, 'ttftMs')
  const ttftSteps = num(value, 'ttftSteps')
  const decodeMs = num(value, 'decodeMs')
  const decodeTokens = num(value, 'decodeTokens')

  return {
    turns,
    steps,
    llmMs,
    toolMs,
    ttftMs: ttftMs !== undefined && ttftSteps !== undefined && ttftSteps > 0 ? ttftMs / ttftSteps : null,
    decodeTokensPerSecond:
      decodeMs !== undefined && decodeMs > 0 && decodeTokens !== undefined
        ? decodeTokens / (decodeMs / 1000)
        : null,
  }
}

/**
 * Build the model selection view.
 * @param value - the `modelSelection` projection value.
 * @returns the view, or `null` when the key is absent.
 */
export function buildModelSelection(value: unknown): SessionStatsFrame['model'] {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const read = (candidate: unknown): { provider: string; model: string; reasoningEffort?: string } | null => {
    if (typeof candidate !== 'object' || candidate === null) return null
    const entry = candidate as Record<string, unknown>
    if (typeof entry['provider'] !== 'string' || typeof entry['model'] !== 'string') return null
    return {
      provider: entry['provider'],
      model: entry['model'],
      ...(typeof entry['reasoningEffort'] === 'string'
        ? { reasoningEffort: entry['reasoningEffort'] }
        : {}),
    }
  }
  return { lastUsed: read(record['lastUsed']), next: read(record['next']) }
}

/** The projection keys this module reads, for a targeted snapshot. */
export const STATS_KEYS = [
  'tokenUsage',
  'contextPressure',
  'contextBreakdown',
  'sessionStats',
  'modelSelection',
  'permissions',
  'title',
] as const

/**
 * Assemble the complete usage frame from one projection snapshot.
 *
 * @param values - projection values keyed by projection name; absent keys are
 *   treated as "capability not composed" and yield `null`.
 * @returns the frame the phone renders.
 */
export function buildStatsFrame(values: ProjectionValues): SessionStatsFrame {
  const tokenUsage = buildTokenUsage(values['tokenUsage'])
  const permissions = values['permissions'] as { currentValue?: unknown } | undefined
  const title = values['title']

  return {
    tokenUsage,
    cacheHit: buildCacheHit(tokenUsage),
    context: buildContextPressure(values['contextPressure'], values['contextBreakdown']),
    stats: buildSessionStatsView(values['sessionStats']),
    model: buildModelSelection(values['modelSelection']),
    permissionPreset:
      typeof permissions?.currentValue === 'string' ? permissions.currentValue : null,
    title: typeof title === 'string' ? title : null,
  }
}
