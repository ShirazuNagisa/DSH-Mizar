/** Default output cap for one rewrite. */
export declare const DEFAULT_MAX_TOKENS = 1024;
/** Floor of the output cap. Below this a rewrite is not worth the round trip. */
export declare const MIN_MAX_TOKENS = 64;
/** Ceiling of the output cap: a prompt rewrite is never a long answer. */
export declare const MAX_MAX_TOKENS = 2048;
/** A provider/model failure, as much of a failure as this module reads. */
export interface EnhanceFailure {
    readonly code?: string;
    readonly message?: string;
}
/**
 * One stream chunk, as much of it as this module reads.
 *
 * `kind`/`failure` at the top level are the flat finish shape; `reason` is the
 * nested one 0.2.1-rc.2 actually emits. See the module note.
 */
export interface EnhanceChunk {
    readonly type: string;
    readonly text?: string;
    readonly kind?: string;
    readonly failure?: EnhanceFailure;
    readonly reason?: EnhanceFailure & {
        readonly kind?: string;
    };
}
/** The one request shape this service sends through `llm.stream`. */
export interface EnhanceStreamOptions {
    readonly provider: string;
    readonly model: string;
    readonly system?: string;
    readonly messages: readonly {
        readonly role: 'user';
        readonly content: readonly {
            readonly type: 'text';
            readonly text: string;
        }[];
    }[];
    readonly maxTokens: number;
    readonly signal?: AbortSignal;
}
/** The slice of `ctx.llm` this module calls. */
export interface EnhanceLlm {
    stream(options: EnhanceStreamOptions): AsyncIterable<EnhanceChunk>;
}
/** One rewrite request. */
export interface EnhanceArgs {
    /** Provider route, as configured in the profile. */
    readonly provider: string;
    /** Model id under that route. */
    readonly model: string;
    /** Rewrite instructions. Omitted when the desktop sends none. */
    readonly system?: string;
    /** The draft to rewrite, verbatim. */
    readonly user: string;
    /** Output cap; defaults to {@link DEFAULT_MAX_TOKENS} and is clamped. */
    readonly maxTokens?: number;
    /** Cancellation, when the caller has one. The link's `service` frame does not. */
    readonly signal?: AbortSignal;
}
/**
 * Bring an output cap into the range this service accepts.
 *
 * @param raw - whatever the desktop sent, if anything.
 * @returns a whole number in `[MIN_MAX_TOKENS, MAX_MAX_TOKENS]`.
 */
export declare function clampMaxTokens(raw: number | undefined): number;
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
export declare function rewriteWithLlm(llm: EnhanceLlm, args: EnhanceArgs): Promise<string>;
/** The service object the desktop reaches through the `service` frame. */
export interface EnhanceService {
    /**
     * Rewrite one draft. Positional, because the link forwards positional args.
     *
     * @returns `{"text": "…"}` as a JSON string: the `result` frame carries the
     *   return value verbatim, and a string keeps this service's wire shape its
     *   own instead of making the desktop read a bare array or string.
     */
    rewrite(provider: string, model: string, system: string | null, user: string, maxTokens?: number): Promise<string>;
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
export declare function createEnhanceService(llmFor: () => EnhanceLlm | null): EnhanceService;
