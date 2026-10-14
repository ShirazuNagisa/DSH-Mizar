/**
 * Read a number field, rejecting non-finite values.
 * @param source - the object to read.
 * @param key - the field name.
 * @returns the value, or `undefined` when it is not a usable number.
 */
function num(source, key) {
    if (typeof source !== 'object' || source === null)
        return undefined;
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
export function formatCacheHitPercent(cacheReadTokens, billedInputTokens) {
    if (billedInputTokens <= 0)
        return null;
    if (cacheReadTokens <= 0)
        return '0';
    if (cacheReadTokens >= billedInputTokens)
        return '100';
    const ratio = cacheReadTokens / billedInputTokens;
    const whole = Math.round(ratio * 100);
    if (whole < 100)
        return String(whole);
    for (let places = 1; places <= 4; places += 1) {
        const text = (ratio * 100).toFixed(places);
        if (Number(text) < 100)
            return text;
    }
    // At four decimals a genuine partial hit still reads as 100, so step down to
    // the largest value below 100 rather than rounding the difference away.
    return '99.9999';
}
/**
 * Build the token usage view.
 * @param value - the `tokenUsage` projection value.
 * @returns the view, or `null` when the key is absent.
 */
export function buildTokenUsage(value) {
    const uncached = num(value, 'uncachedInputTokens');
    const output = num(value, 'outputTokens');
    if (uncached === undefined || output === undefined)
        return null;
    const cacheRead = num(value, 'cacheReadTokens') ?? 0;
    const cacheWrite = num(value, 'cacheWriteTokens') ?? 0;
    return {
        uncachedInputTokens: uncached,
        outputTokens: output,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        billedInputTokens: uncached + cacheRead + cacheWrite,
    };
}
/**
 * Build the cache hit view from a token usage view.
 * @param usage - the token usage view.
 * @returns the cache view, or `null` without a usage view.
 */
export function buildCacheHit(usage) {
    if (usage === null)
        return null;
    const { billedInputTokens, cacheReadTokens } = usage;
    return {
        ratio: billedInputTokens > 0 ? cacheReadTokens / billedInputTokens : null,
        displayPercent: formatCacheHitPercent(cacheReadTokens, billedInputTokens),
    };
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
export function buildContextPressure(pressure, breakdown) {
    const window = num(pressure, 'contextWindow');
    const pressureTokens = num(pressure, 'pressureTokens');
    const projectedTokens = num(pressure, 'projectedTokens');
    if (window === undefined && pressureTokens === undefined && projectedTokens === undefined) {
        return null;
    }
    const used = projectedTokens ?? pressureTokens;
    const percent = used !== undefined && window !== undefined && window > 0
        ? Math.min(100, Math.round((used / window) * 100))
        : null;
    const system = num(breakdown, 'systemTokens');
    const tools = num(breakdown, 'toolsTokens');
    const messages = num(breakdown, 'messageTokens');
    return {
        window: window ?? null,
        pressureTokens: pressureTokens ?? null,
        projectedTokens: projectedTokens ?? null,
        percent,
        breakdown: system === undefined && tools === undefined && messages === undefined
            ? null
            : {
                systemTokens: system ?? 0,
                toolsTokens: tools ?? 0,
                messageTokens: messages ?? 0,
            },
    };
}
/**
 * Build the throughput view.
 * @param value - the `sessionStats` projection value.
 * @returns the view, or `null` when the key is absent.
 */
export function buildSessionStatsView(value) {
    const turns = num(value, 'turns');
    const steps = num(value, 'steps');
    if (turns === undefined || steps === undefined)
        return null;
    const llmMs = num(value, 'llmMs') ?? 0;
    const toolMs = num(value, 'toolMs') ?? 0;
    const ttftMs = num(value, 'ttftMs');
    const ttftSteps = num(value, 'ttftSteps');
    const decodeMs = num(value, 'decodeMs');
    const decodeTokens = num(value, 'decodeTokens');
    return {
        turns,
        steps,
        llmMs,
        toolMs,
        ttftMs: ttftMs !== undefined && ttftSteps !== undefined && ttftSteps > 0 ? ttftMs / ttftSteps : null,
        decodeTokensPerSecond: decodeMs !== undefined && decodeMs > 0 && decodeTokens !== undefined
            ? decodeTokens / (decodeMs / 1000)
            : null,
    };
}
/**
 * Build the model selection view.
 * @param value - the `modelSelection` projection value.
 * @returns the view, or `null` when the key is absent.
 */
export function buildModelSelection(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const record = value;
    const read = (candidate) => {
        if (typeof candidate !== 'object' || candidate === null)
            return null;
        const entry = candidate;
        if (typeof entry['provider'] !== 'string' || typeof entry['model'] !== 'string')
            return null;
        return {
            provider: entry['provider'],
            model: entry['model'],
            ...(typeof entry['reasoningEffort'] === 'string'
                ? { reasoningEffort: entry['reasoningEffort'] }
                : {}),
        };
    };
    return { lastUsed: read(record['lastUsed']), next: read(record['next']) };
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
];
/**
 * Assemble the complete usage frame from one projection snapshot.
 *
 * @param values - projection values keyed by projection name; absent keys are
 *   treated as "capability not composed" and yield `null`.
 * @returns the frame the phone renders.
 */
export function buildStatsFrame(values) {
    const tokenUsage = buildTokenUsage(values['tokenUsage']);
    const permissions = values['permissions'];
    const title = values['title'];
    return {
        tokenUsage,
        cacheHit: buildCacheHit(tokenUsage),
        context: buildContextPressure(values['contextPressure'], values['contextBreakdown']),
        stats: buildSessionStatsView(values['sessionStats']),
        model: buildModelSelection(values['modelSelection']),
        permissionPreset: typeof permissions?.currentValue === 'string' ? permissions.currentValue : null,
        title: typeof title === 'string' ? title : null,
    };
}
