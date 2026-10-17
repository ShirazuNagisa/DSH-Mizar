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
export declare const PROTOCOL_VERSION = 1;
/** Path of the authenticated WebSocket endpoint. */
export declare const WS_PATH = "/mizar/v1/ws";
/** Prefix shared by the plain-HTTP endpoints. */
export declare const HTTP_PREFIX = "/mizar/v1";
/** Path of the unauthenticated liveness and identity probe. */
export declare const HELLO_PATH = "/mizar/v1/hello";
/** Path of the one unauthenticated state-changing endpoint. */
export declare const PAIR_PATH = "/mizar/v1/pair";
/**
 * Machine-readable failure codes.
 *
 * These are the app's switch statement; adding one is a protocol change and
 * needs a version bump if it changes an existing meaning.
 */
export declare const ERROR_CODES: readonly ["PROTOCOL_VERSION_MISMATCH", "MALFORMED_FRAME", "UNAUTHENTICATED", "PAIRING_REQUIRED", "PAIRING_CODE_INVALID", "PAIRING_CODE_EXPIRED", "PAIRING_CODE_UNKNOWN", "RATE_LIMITED", "DEVICE_REVOKED", "WRITER_HELD", "MODEL_UNAVAILABLE", "REMOTE_ERROR", "NOT_IMPLEMENTED", "INTERNAL", "RESPONSE_TOO_LARGE"];
/** One failure code. */
export type ErrorCode = (typeof ERROR_CODES)[number];
/** The `hello` frame: the first frame a client must send on a socket. */
export interface ClientHelloFrame {
    readonly v: typeof PROTOCOL_VERSION;
    /**
     * Correlation id, echoed by nothing.
     *
     * A `welcome` frame carries no `id`: the host answers a `hello` once, and the
     * captured golden frame in `protocol/fixtures/welcome.json` is the record of
     * that. This field is accepted because a client may send one, not because
     * anything comes back with it.
     */
    readonly id?: string;
    readonly type: 'hello';
    /** The device token obtained from pairing, or an empty string on a LAN probe. */
    readonly token: string;
    /** App marketing version, for the roster and support. */
    readonly appVersion?: string;
    /** Device model, for the roster. */
    readonly deviceModel?: string;
    /** The app's protocol version, so a mismatch is reported precisely. */
    readonly protocolVersion?: number;
}
/**
 * A request that expects a correlated response.
 *
 * Method arguments live in `payload` rather than at the top level. A free-form
 * index signature would look more convenient, but it makes every field read
 * `unknown` and — worse — it defeats discriminated-union narrowing, because a
 * `type: string` member with an index signature continues to match after
 * `frame.type === 'hello'`. Keeping the envelope closed is what lets the frame
 * types narrow.
 */
export interface ClientRequestFrame {
    readonly v: typeof PROTOCOL_VERSION;
    readonly id: string;
    readonly type: string;
    /** Method-specific arguments; the method validates its own shape. */
    readonly payload?: unknown;
}
/** Any frame a client may send. */
export type ClientFrame = ClientHelloFrame | ClientRequestFrame;
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
export declare function isHelloFrame(frame: ClientFrame): frame is ClientHelloFrame;
/** The `welcome` frame: the host's answer to an accepted `hello`. */
export interface ServerWelcomeFrame {
    readonly v: typeof PROTOCOL_VERSION;
    readonly type: 'welcome';
    /** Stable host identity. */
    readonly hostId: string;
    /** Human-readable host name, normally the machine name. */
    readonly hostName: string;
    /** The protocol version the host speaks. */
    readonly protocolVersion: number;
    /** The DSH home directory, shown in the app's host details. */
    readonly home: string;
    /** The device id the token belongs to. */
    readonly deviceId: string;
}
/** A successful response to a correlated request. */
export interface ServerOkFrame {
    readonly v: typeof PROTOCOL_VERSION;
    readonly id: string;
    readonly type: 'ok';
    /** Method-specific payload; absent when the method has no result. */
    readonly result?: unknown;
}
/** A failed response, or an unsolicited failure. */
export interface ServerErrorFrame {
    readonly v: typeof PROTOCOL_VERSION;
    readonly id?: string;
    readonly type: 'error';
    readonly code: ErrorCode;
    readonly message: string;
    /** Whether retrying the same request could succeed. */
    readonly retryable?: boolean;
}
/** A server-initiated notification. */
export interface ServerEventFrame {
    readonly v: typeof PROTOCOL_VERSION;
    readonly type: 'event';
    readonly event: string;
    readonly data: unknown;
}
/** Any frame the host may send. */
export type ServerFrame = ServerWelcomeFrame | ServerOkFrame | ServerErrorFrame | ServerEventFrame;
/** Outcome of validating an inbound frame. */
export type ParseResult = {
    readonly ok: true;
    readonly frame: ClientFrame;
} | {
    readonly ok: false;
    readonly code: ErrorCode;
    readonly message: string;
};
/**
 * Encode a frame for the wire.
 * @param frame - the frame to send.
 * @returns the JSON text.
 */
export declare function encodeFrame(frame: ServerFrame): string;
/**
 * Build an error frame.
 * @param code - the failure code.
 * @param message - a log-oriented description.
 * @param id - the request being answered, when the failure answers one.
 * @param retryable - whether a retry could succeed.
 * @returns the frame.
 */
export declare function errorFrame(code: ErrorCode, message: string, id?: string, retryable?: boolean): ServerErrorFrame;
/**
 * Build a success frame.
 * @param id - the request being answered.
 * @param result - the method-specific payload.
 * @returns the frame.
 */
export declare function okFrame(id: string, result?: unknown): ServerOkFrame;
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
export declare function parseClientFrame(raw: string): ParseResult;
/** The body of a pairing request. */
export interface PairRequestBody {
    readonly code: string;
    readonly deviceName?: string;
    readonly deviceModel?: string;
    readonly appVersion?: string;
    readonly protocolVersion?: number;
}
/** The body of a successful pairing response. */
export interface PairResponseBody {
    readonly deviceToken: string;
    readonly deviceId: string;
    readonly hostId: string;
    readonly hostName: string;
    readonly protocolVersion: number;
}
/** The body of the unauthenticated identity probe. */
export interface HelloResponseBody {
    readonly hostId: string;
    readonly hostName: string;
    readonly protocolVersion: number;
    /** Whether a pairing code is currently outstanding. */
    readonly pairingOpen: boolean;
    /** Whether at least one live device is paired. */
    readonly paired: boolean;
}
