/**
 * The Mizar wire protocol, version 1.
 *
 * This is the contract the iOS app is written against, and it is deliberately
 * *not* DSH's own Typert protocol. DSH's internal surface is 140 endpoints and
 * 40-plus session event variants with no version number and no stability
 * promise; adapting all of that to something a phone can render is the plugin's
 * job, and keeping that job on the host is what lets DSH change underneath
 * without touching the app.
 *
 * Three rules make the contract survivable:
 *
 *   - **Every frame carries `v`.** A peer that does not understand the version
 *     is told so explicitly instead of being fed fields it will misread.
 *   - **Requests carry `id`, responses echo it.** Server-initiated frames have
 *     no `id`, so the direction of a frame is unambiguous.
 *   - **Errors are codes, not prose.** The app renders localized text from the
 *     code; the message is for logs and support.
 *
 * @module dsh-mizar/protocol/frames
 */
/**
 * The protocol version this build speaks.
 *
 * **Adding an optional field to an existing payload is not a version bump**, and
 * the Live Activity fields (the bridge's `push.register.liveActivityToken`, and
 * the relay's `endLiveActivity`) are added that way: a peer that does not know a
 * key leaves it alone, which is what lets a phone update before its host or the
 * other way round. Changing what an existing field means, renaming one, or
 * requiring a new one *is* a bump.
 */
export const PROTOCOL_VERSION = 1;
/** Path of the authenticated WebSocket endpoint. */
export const WS_PATH = '/mizar/v1/ws';
/** Prefix shared by the plain-HTTP endpoints. */
export const HTTP_PREFIX = '/mizar/v1';
/** Path of the unauthenticated liveness and identity probe. */
export const HELLO_PATH = `${HTTP_PREFIX}/hello`;
/** Path of the one unauthenticated state-changing endpoint. */
export const PAIR_PATH = `${HTTP_PREFIX}/pair`;
/**
 * Machine-readable failure codes.
 *
 * These are the app's switch statement; adding one is a protocol change and
 * needs a version bump if it changes an existing meaning.
 */
export const ERROR_CODES = [
    'PROTOCOL_VERSION_MISMATCH',
    'MALFORMED_FRAME',
    'UNAUTHENTICATED',
    'PAIRING_REQUIRED',
    'PAIRING_CODE_INVALID',
    'PAIRING_CODE_EXPIRED',
    'PAIRING_CODE_UNKNOWN',
    'RATE_LIMITED',
    'DEVICE_REVOKED',
    // The session is held by another writer — normally the desktop UI. Retrying
    // later is the right advice, so the app branches on this rather than showing
    // a generic failure.
    'WRITER_HELD',
    // The requested provider/model pair is not in the available catalog.
    'MODEL_UNAVAILABLE',
    // An upstream DSH call failed for a reason this layer does not classify. The
    // original code is preserved in the message.
    'REMOTE_ERROR',
    'NOT_IMPLEMENTED',
    'INTERNAL',
    /**
     * The answer exists but is too large to deliver.
     *
     * Its own code because it is not a fault in the request and not a bug in the
     * host: the answer is real and the transport cannot carry it. Saying so lets
     * the client ask for less instead of retrying the same thing.
     */
    'RESPONSE_TOO_LARGE',
    /**
     * The upload id in a chunk/finish/abort is not knowable to this device.
     *
     * Deliberately one code for "never existed", "expired" and "belongs to another
     * device or session": a client can only react by starting over, and telling it
     * that somebody else's upload exists is a fact it must not learn.
     */
    'UPLOAD_UNKNOWN',
    /** A chunk was malformed, out of order, or conflicted with the bytes already stored for its index. */
    'UPLOAD_BAD_CHUNK',
    // The declared size, a chunk, or the prompt total exceeds the limits.
    'UPLOAD_TOO_LARGE',
    // `upload.finish` arrived before every declared byte did.
    'UPLOAD_INCOMPLETE',
    /**
     * A prompt names an attachment this device and session cannot use.
     *
     * Same reasoning as `UPLOAD_UNKNOWN`: absent, expired and foreign are one
     * answer on purpose.
     */
    'ATTACHMENT_UNKNOWN',
    // The attachments in one prompt exceed the per-prompt count or byte limits.
    'ATTACHMENT_TOO_LARGE',
    // The media type is not one this host can turn into prompt content.
    'ATTACHMENT_UNSUPPORTED',
    // Staging, saving or handing a file to DSH failed on the host.
    'ATTACHMENT_FAILED',
    /**
     * The stored bytes failed verification against what the client declared: the
     * SHA-256 does not match a full re-read of the staging area. The upload is
     * retired; the fix is to upload again.
     *
     * Ported from XEPX2's PR #2.
     */
    'UPLOAD_INTEGRITY',
    /**
     * A staging resource quota is exhausted: too many live uploads globally or
     * for this device, or too many declared bytes reserved. Retry later, after
     * prompts release them or the 30-minute TTL sweeps.
     *
     * Ported from XEPX2's PR #2.
     */
    'UPLOAD_LIMIT_REACHED',
    /**
     * A prompt's identity was reused with different content: the same
     * `requestId` sent again with other text, attachments, mode, timezone, or
     * from another device. The original request may or may not have landed;
     * guessing would risk a duplicate message, so the client must pick a fresh
     * `requestId`.
     *
     * Ported from XEPX2's PR #2.
     */
    'ATTACHMENT_INVALID',
];
/**
 * Narrow a client frame to `hello`.
 *
 * Written as a guard rather than relying on `frame.type === 'hello'`:
 * {@link ClientRequestFrame} carries `type: string`, so a plain comparison
 * yields an intersection that still includes the request branch.
 *
 * @param frame - the frame to test.
 * @returns whether the frame is a `hello`.
 */
export function isHelloFrame(frame) {
    return frame.type === 'hello';
}
/**
 * Encode a frame for the wire.
 * @param frame - the frame to send.
 * @returns the JSON text.
 */
export function encodeFrame(frame) {
    return JSON.stringify(frame);
}
/**
 * Build an error frame.
 * @param code - the failure code.
 * @param message - a log-oriented description.
 * @param id - the request being answered, when the failure answers one.
 * @param retryable - whether a retry could succeed.
 * @returns the frame.
 */
export function errorFrame(code, message, id, retryable = false) {
    return {
        v: PROTOCOL_VERSION,
        type: 'error',
        code,
        message,
        retryable,
        ...(id === undefined ? {} : { id }),
    };
}
/**
 * Build a success frame.
 * @param id - the request being answered.
 * @param result - the method-specific payload.
 * @returns the frame.
 */
export function okFrame(id, result) {
    return { v: PROTOCOL_VERSION, type: 'ok', id, ...(result === undefined ? {} : { result }) };
}
/**
 * Validate and narrow one inbound frame.
 *
 * Validation is intentionally strict about shape and permissive about payload:
 * a method that does not recognise a field must say so itself, because only the
 * method knows its own contract.
 *
 * @param raw - the raw text received from the socket.
 * @returns the parsed frame, or a failure code to answer with.
 */
export function parseClientFrame(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return { ok: false, code: 'MALFORMED_FRAME', message: 'frame is not valid JSON' };
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        return { ok: false, code: 'MALFORMED_FRAME', message: 'frame must be a JSON object' };
    }
    const record = parsed;
    if (record['v'] !== PROTOCOL_VERSION) {
        const seen = record['v'];
        return {
            ok: false,
            code: 'PROTOCOL_VERSION_MISMATCH',
            message: `expected protocol version ${PROTOCOL_VERSION}, received ${JSON.stringify(seen)}`,
        };
    }
    const type = record['type'];
    if (typeof type !== 'string' || type === '') {
        return { ok: false, code: 'MALFORMED_FRAME', message: 'frame has no type' };
    }
    const id = record['id'];
    if (id !== undefined && typeof id !== 'string') {
        return { ok: false, code: 'MALFORMED_FRAME', message: 'frame id must be a string' };
    }
    if (type === 'hello') {
        const token = record['token'];
        if (typeof token !== 'string') {
            return { ok: false, code: 'MALFORMED_FRAME', message: 'hello frame has no token string' };
        }
        return {
            ok: true,
            frame: {
                v: PROTOCOL_VERSION,
                type: 'hello',
                token,
                ...(id === undefined ? {} : { id }),
                ...(typeof record['appVersion'] === 'string' ? { appVersion: record['appVersion'] } : {}),
                ...(typeof record['deviceModel'] === 'string' ? { deviceModel: record['deviceModel'] } : {}),
                ...(typeof record['protocolVersion'] === 'number'
                    ? { protocolVersion: record['protocolVersion'] }
                    : {}),
            },
        };
    }
    if (id === undefined || id === '') {
        return { ok: false, code: 'MALFORMED_FRAME', message: `frame "${type}" has no id` };
    }
    return {
        ok: true,
        frame: {
            v: PROTOCOL_VERSION,
            id,
            type,
            ...(record['payload'] === undefined ? {} : { payload: record['payload'] }),
        },
    };
}
