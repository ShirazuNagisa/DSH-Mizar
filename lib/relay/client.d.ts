/** How the client is configured. */
export interface RelayClientOptions {
    /**
     * The relay's base URL.
     *
     * `https://` and `http://` are both accepted and translated to `wss://` and
     * `ws://`, because the value a human copies out of a browser is an `https`
     * URL and making them rewrite it is a needless way to get it wrong.
     */
    readonly url: string;
    /** The tunnel token. Sent as a bearer token on the upgrade. */
    readonly token: string;
    /** Local port the listener is bound to. */
    readonly localPort: number;
    /** Local interface the listener is bound to. */
    readonly localHost?: string;
    /** Where to report. */
    readonly log: (message: string) => void;
    /** Called whenever the connection state or room changes. */
    readonly onState?: (state: RelayClientState) => void;
    /** Injected for tests; defaults to the real `ws` constructor. */
    readonly socketFactory?: (url: string, token: string) => RelaySocket;
    /** First reconnect delay, in ms. Doubles up to the cap. */
    readonly reconnectBaseMs?: number;
    /** Longest reconnect delay, in ms. */
    readonly reconnectMaxMs?: number;
}
/** What the outside world can see about the tunnel. */
export interface RelayClientState {
    readonly connected: boolean;
    /** The room the relay assigned, once known. */
    readonly room: string | null;
    /** The last failure, or `null`. */
    readonly lastError: string | null;
}
/**
 * The subset of a WebSocket this client needs, so a test can stand in.
 *
 * Declared with overloads rather than one loose `on` so the listener parameters
 * stay typed at each call site. The real `ws` WebSocket is structurally close but
 * not identical -- its listeners carry a `this` type and `RawData` instead of
 * `Buffer` -- so it is cast once, where it is constructed, rather than widening
 * this interface until everything happens to fit.
 */
export interface RelaySocket {
    send(text: string): void;
    close(code?: number, reason?: string): void;
    on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): unknown;
    on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown;
    on(event: 'error', listener: (error: Error) => void): unknown;
    on(event: 'open', listener: () => void): unknown;
}
/**
 * Make a close code safe to send.
 *
 * A close frame carries a code, and a few codes describe *the absence* of one:
 * 1005 is "no status received" and 1006 is "connection closed abnormally". They
 * are reported to a `close` handler but are reserved -- RFC 6455 says they must
 * never appear *in* a close frame, and `ws` throws a TypeError if you try. Since
 * a bridged socket forwards the code it was given, the far end has to be able to
 * receive one of these, and without this it takes the process down.
 *
 * Anything reserved or unknown becomes 1000: the peer learns the stream closed
 * and loses only the detail of why, which is better than losing the connection.
 *
 * @param code - the code a socket reported, if any.
 * @returns a code that is legal to send.
 */
export declare function saneCloseCode(code: number | undefined): number;
/**
 * Make a close reason safe to send.
 *
 * The sibling of {@link saneCloseCode}, for the same reason: `WebSocket.close()`
 * throws a `RangeError` -- synchronously, out of the frame handler -- for a
 * reason longer than 123 bytes. A conforming peer cannot produce one (a close
 * frame carries at most 125 bytes), but a relay that is a version ahead, is
 * misconfigured, or is not the one the operator thinks it is, can say anything:
 * the frame arrives as JSON, and `parseRelayFrame` narrows the envelope only.
 *
 * The cut is made on a character boundary, because a reason truncated mid
 * codepoint decodes to U+FFFD and re-encodes to three bytes, which can push the
 * result back over the limit it was cut to.
 *
 * @param reason - the reason the relay reported.
 * @returns a reason that is legal to send.
 */
export declare function saneCloseReason(reason: string | undefined): string;
/**
 * Turn a relay URL into the WebSocket URL for the tunnel.
 *
 * @param url - `https://relay.example.com`, `wss://…`, or either with a path.
 * @returns the absolute tunnel URL, or `null` when the URL is unusable.
 */
export declare function tunnelURL(url: string): string | null;
/**
 * The base URL a phone should be given, for a room.
 *
 * A Mac on the same LAN as its relay may dial a private address while a phone
 * has to use the public one, so this prefers `publicUrl` when it is set. With
 * neither set there is nothing to give a phone, and returning `null` beats
 * inventing a URL that will not resolve.
 *
 * @param url - the relay URL the Mac dials.
 * @param publicUrl - the operator's override, or empty.
 * @param room - the room, when it is known.
 * @returns the base URL, or `null`.
 */
export declare function phoneBaseURL(url: string, publicUrl: string, room?: string | null): string | null;
/** The tunnel client. */
export declare class RelayClient {
    #private;
    /**
     * @param options - the configuration.
     */
    constructor(options: RelayClientOptions);
    /** The relay connection's current state. */
    get state(): RelayClientState;
    /** The room the relay assigned, or `null` before the first welcome. */
    get room(): string | null;
    /** Connect, and keep reconnecting until {@link stop}. */
    start(): void;
    /** Stop reconnecting and close the tunnel. */
    stop(): void;
}
