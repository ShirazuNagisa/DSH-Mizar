/**
 * Failure translation, deliberately thin.
 *
 * 0.8.x mapped DSH's error codes onto a Mizar vocabulary (`session/writer-held`
 * → `WRITER_HELD`) because the phone app had a switch statement per code and
 * could not be taught DSH's names. That mapping is gone. The desktop app reads
 * DSH directly, and a mapping table between two vocabularies is exactly the kind
 * of "understanding" this plugin is not supposed to have: every new DSH code
 * would need a new plugin release to be visible.
 *
 * So an upstream failure crosses the link as it was thrown: code, message,
 * details. The one thing added is a code for failures that carry none, so the
 * desktop can always branch on something.
 *
 * @module dsh-mizar/bridge/errors
 */
/** A failure as it will appear on the wire. */
export interface UpstreamFailure {
    /** DSH's own code when it had one, otherwise {@link LINK_ERROR}. */
    readonly code: string;
    readonly message: string;
    /** DSH's `details`, verbatim, when the error carried any. */
    readonly details?: unknown;
}
/** The code used for failures that named none of their own. */
export declare const LINK_ERROR = "REMOTE_ERROR";
/** The code used for a call this plugin refused before reaching DSH. */
export declare const LINK_REFUSED = "LINK_REFUSED";
/** A refusal this plugin owns, as opposed to one DSH produced. */
export declare class LinkError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
/**
 * Read a thrown value as a wire failure.
 *
 * @param error - anything thrown.
 * @returns the code, message and details to send.
 */
export declare function upstreamFailure(error: unknown): UpstreamFailure;
