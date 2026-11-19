/**
 * The `mizarEnhance` service: one model call, no session.
 *
 * The desktop's composer can hand a draft to a model when the phone has no
 * usable on-device model (a region-locked Apple Intelligence build, for one).
 * That is a single request — no conversation, no session log, no agent loop —
 * and DSH's own answer to "call a model once" is `ctx.llm.stream`, so this
 * module is a thin consumer of it.
 *
 * ### Why the core takes a structural `llm`, not `Context`
 *
 * `rewriteWithLlm` is the whole behaviour, and it should be provable with a
 * fake async iterable rather than a composed DSH profile. The `llm` parameter is
 * therefore a local interface listing exactly what this module reads; the real
 * `LlmRuntime` satisfies it structurally, and `index.ts` is the only place that
 * knows a Cordis context exists.
 *
 * ### The finish vocabulary
 *
 * `@deepseek-ai/dsh-llm` 0.2.1-rc.2 nests the stop reason: a terminal chunk is
 * `{ type: 'finish', reason: { kind: 'error' | 'aborted' | 'stop', failure? } }`.
 * Frontier builds have also carried the reason flat on the chunk. Both are read
 * here — a rewrite that silently returned half a sentence because the reason
 * moved would be worse than five lines of tolerance.
 *
 * @module dsh-mizar/bridge/enhance
 */
import { ENHANCE_FAILED, LINK_REFUSED, LinkError } from './errors.js';
/** Default output cap for one rewrite. */
export const DEFAULT_MAX_TOKENS = 1024;
/** Floor of the output cap. Below this a rewrite is not worth the round trip. */
export const MIN_MAX_TOKENS = 64;
/** Ceiling of the output cap: a prompt rewrite is never a long answer. */
export const MAX_MAX_TOKENS = 2048;
/**
 * Bring an output cap into the range this service accepts.
 *
 * @param raw - whatever the desktop sent, if anything.
 * @returns a whole number in `[MIN_MAX_TOKENS, MAX_MAX_TOKENS]`.
 */
export function clampMaxTokens(raw) {
    if (raw === undefined || !Number.isFinite(raw))
        return DEFAULT_MAX_TOKENS;
    return Math.min(MAX_MAX_TOKENS, Math.max(MIN_MAX_TOKENS, Math.trunc(raw)));
}
/** Read whichever finish shape the stream used. */
function finishOf(chunk) {
    return chunk.reason ?? chunk;
}
/** Translate a non-`stop` finish into the one code the desktop branches on. */
function finishFailure(kind, failure) {
    const named = `finish "${kind ?? 'unknown'}"`;
    const code = failure?.code === undefined ? '' : ` (code ${failure.code})`;
    const detail = failure?.message === undefined ? '' : `: ${failure.message}`;
    return new LinkError(ENHANCE_FAILED, `the model call stopped with ${named}${code}${detail}`);
}
/**
 * Stream one rewrite and return its text.
 *
 * The request is one request-only user message, so nothing here can reach a
 * session: `dsh-llm` writes no log for a hand-built call.
 *
 * @param llm - the model service, or anything shaped like it.
 * @param args - provider, model, prompts and cap.
 * @returns the assistant text, trimmed.
 * @throws LinkError with code {@link ENHANCE_FAILED} when the call fails, is
 *   aborted, or produces no text at all.
 */
export async function rewriteWithLlm(llm, args) {
    const options = {
        provider: args.provider,
        model: args.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: args.user }] }],
        maxTokens: clampMaxTokens(args.maxTokens),
        ...(args.system === undefined ? {} : { system: args.system }),
        // The branded Session id is only a string on this side; the adapter reads
        // it as transport metadata.
        ...(args.sessionId === undefined ? {} : { sessionId: args.sessionId }),
        ...(args.signal === undefined ? {} : { signal: args.signal }),
    };
    let text = '';
    for await (const chunk of llm.stream(options)) {
        if (chunk.type === 'text-delta') {
            // Reasoning deltas are a different chunk type and are deliberately not
            // "the answer": a rewrite panel showing the model's thinking would be a
            // worse draft than the one the user typed.
            if (typeof chunk.text === 'string')
                text += chunk.text;
            continue;
        }
        if (chunk.type !== 'finish')
            continue;
        const finish = finishOf(chunk);
        if (finish.kind === 'stop')
            continue;
        throw finishFailure(finish.kind, finish.failure);
    }
    const trimmed = text.trim();
    if (trimmed === '')
        throw new LinkError(ENHANCE_FAILED, 'the model returned no text');
    return trimmed;
}
/**
 * Build the service around a lazy read of the model service.
 *
 * Lazy because a profile can compose `llm` after this plugin applies, and
 * because a profile with no model service at all must still activate: the link
 * is useful without a rewrite, so the failure belongs to the call rather than
 * to plugin activation.
 *
 * @param llmFor - returns the model service, or `null` when none is composed.
 * @returns the object `ctx.provide('mizarEnhance', …)` registers.
 */
export function createEnhanceService(llmFor) {
    return {
        async rewrite(provider, model, system, user, maxTokens, sessionId) {
            const llm = llmFor();
            if (llm === null) {
                throw new LinkError(ENHANCE_FAILED, 'this DSH profile has no model service (ctx.llm)');
            }
            if (typeof provider !== 'string' || provider === '' || typeof model !== 'string' || model === '') {
                throw new LinkError(LINK_REFUSED, 'rewrite needs a provider and a model');
            }
            // The args arrived as JSON, so "no system prompt" may be `null` and a
            // missing draft may be `undefined`; neither should reach the model as the
            // string "null".
            const args = {
                provider,
                model,
                user: typeof user === 'string' ? user : '',
                ...(typeof system === 'string' && system !== '' ? { system } : {}),
                ...(typeof maxTokens === 'number' ? { maxTokens } : {}),
                ...(typeof sessionId === 'string' && sessionId !== '' ? { sessionId } : {}),
            };
            return JSON.stringify({ text: await rewriteWithLlm(llm, args) });
        },
    };
}
