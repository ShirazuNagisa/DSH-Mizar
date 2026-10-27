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
/** The code used for failures that named none of their own. */
export const LINK_ERROR = 'REMOTE_ERROR';
/** The code used for a call this plugin refused before reaching DSH. */
export const LINK_REFUSED = 'LINK_REFUSED';
/** A refusal this plugin owns, as opposed to one DSH produced. */
export class LinkError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.name = 'LinkError';
        this.code = code;
    }
}
/**
 * Read a thrown value as a wire failure.
 *
 * @param error - anything thrown.
 * @returns the code, message and details to send.
 */
export function upstreamFailure(error) {
    if (typeof error === 'object' && error !== null) {
        const record = error;
        const code = typeof record['code'] === 'string' && record['code'] !== '' ? record['code'] : LINK_ERROR;
        const message = typeof record['message'] === 'string' && record['message'] !== ''
            ? record['message']
            : String(error);
        return record['details'] === undefined
            ? { code, message }
            : { code, message, details: record['details'] };
    }
    return { code: LINK_ERROR, message: String(error) };
}
