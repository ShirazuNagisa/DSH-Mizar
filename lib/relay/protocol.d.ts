/**
 * The tunnel protocol, from the computer's side.
 *
 * Declared again here rather than imported from `relay/` so the plugin and the
 * relay stay separately deployable -- a plugin installed from a git checkout has
 * no relay/ directory at all, because the package's `files` list is
 * `["lib", "cordis.patch.yml"]`. The two declarations are pinned by decoding the
 * same golden frames: `protocol/fixtures/relay-tunnel.json` here and
 * `relay/test/protocol.test.ts` there. A shared artifact is what holds a
 * contract; a shared import would only hold a build.
 *
 * @module dsh-mizar/relay/protocol
 */
/** The first frame the relay sends. */
export interface RelayWelcome {
    readonly t: 'welcome';
    /** The room this tunnel serves. The relay chooses it; the computer never invents one. */
    readonly room: string;
    readonly protocolVersion: number;
}
/** A phone request on its way to the local listener. */
export interface RelayRequest {
    readonly t: 'req';
    readonly id: string;
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string | null;
}
/** Open a phone WebSocket locally. */
export interface RelayStreamOpen {
    readonly t: 'ws-open';
    readonly id: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
}
/** One message on an open stream. */
export interface RelayStreamMessage {
    readonly t: 'ws-msg';
    readonly id: string;
    readonly data: string;
    readonly binary: boolean;
}
/** Close an open stream. */
export interface RelayStreamClose {
    readonly t: 'ws-close';
    readonly id: string;
    readonly code?: number;
    readonly reason?: string;
}
/** Liveness. */
export interface RelayPing {
    readonly t: 'ping';
    readonly id: string;
}
/** Everything the relay may send. */
export type RelayToHost = RelayWelcome | RelayRequest | RelayStreamOpen | RelayStreamMessage | RelayStreamClose | RelayPing;
/** The answer to a {@link RelayRequest}. */
export interface HostResponse {
    readonly t: 'res';
    readonly id: string;
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string | null;
}
/** The local listener accepted a stream. */
export interface HostStreamOpened {
    readonly t: 'ws-open-ok';
    readonly id: string;
}
/** A message toward the phone. */
export interface HostStreamMessage {
    readonly t: 'ws-msg';
    readonly id: string;
    readonly data: string;
    readonly binary: boolean;
}
/** Closing a stream. */
export interface HostStreamClose {
    readonly t: 'ws-close';
    readonly id: string;
    readonly code?: number;
    readonly reason?: string;
}
/** Liveness answer. */
export interface HostPong {
    readonly t: 'pong';
    readonly id: string;
}
/** Something went wrong with one id. */
export interface HostError {
    readonly t: 'error';
    readonly id: string;
    readonly message: string;
}
/** Everything the computer may send. */
export type HostToRelay = HostResponse | HostStreamOpened | HostStreamMessage | HostStreamClose | HostPong | HostError;
/** The tunnel protocol version. */
export declare const TUNNEL_PROTOCOL_VERSION = 1;
/** The path a computer dials to establish its tunnel. */
export declare const TUNNEL_PATH = "/tunnel";
/**
 * Parse a frame from the relay, refusing anything unrecognised.
 *
 * A relay that is a version ahead may send frames this build does not know; the
 * honest response is to ignore them rather than to guess, so this returns `null`
 * instead of throwing and the caller drops the frame.
 *
 * @param text - the raw frame.
 * @returns the frame, or `null`.
 */
export declare function parseRelayFrame(text: string): RelayToHost | null;
