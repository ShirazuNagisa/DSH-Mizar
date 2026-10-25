import type { WebSocket } from 'ws';
import { type Candidate } from '../transport/p2p/candidate.js';
import { type EndpointIdentity } from '../transport/p2p/crypto.js';
import type { PortMappingOptions } from '../transport/p2p/portmap.js';
import { type Policy } from '../transport/p2p/policy.js';
import type { Stream } from '../transport/p2p/session.js';
/** The path a phone dials for signaling, behind the relay's room prefix. */
export declare const SIGNAL_PATH = "/mizar-net/signal";
/** The patch of a p2p connection, as far as this module cares. */
export interface StreamLike {
    receive(): Promise<Buffer | null>;
    send(data: Buffer): Promise<void>;
    close(reason?: string): Promise<void>;
}
/** The part of the engine this service uses. */
export interface P2PEngineLike {
    readonly identity: EndpointIdentity;
    accept(): Promise<Stream>;
    offerCandidates(candidates: readonly Candidate[]): void;
    localCandidates(): Candidate[];
    close(): Promise<void>;
}
/** What a signaling channel has to be able to do. */
export interface SignalChannelLike {
    send(text: string): void;
    onMessage(listener: (text: string) => void): void;
    onClose(listener: () => void): void;
    close(): void;
}
/** One Mizar frame's worth of bytes, adapted to the listener's channel shape. */
export interface MizarChannelLike {
    readonly open: boolean;
    send(text: string): void;
    close(code?: number, reason?: string): void;
    onMessage(listener: (data: Buffer, isBinary: boolean) => void): void;
    onClose(listener: () => void): void;
}
/**
 * This install's endpoint identity.
 *
 * The secret is the tunnel secret: the same bytes that already decide which
 * room this computer serves. Deriving rather than generating means the endpoint
 * id is stable across reinstalls, and a phone that paired once can dial again
 * without another scan.
 *
 * @param tunnelSecret - the install's tunnel secret, base64url text.
 * @returns the identity.
 */
export declare function deriveEndpointIdentity(tunnelSecret: string): EndpointIdentity;
/**
 * Turn whatever arrived over signaling into candidates, dropping what does not
 * parse.
 *
 * A signal channel is reachable by anyone holding the room, so its contents are
 * untrusted: a malformed candidate must cost that candidate, not the connection
 * or the process.
 *
 * @param value - the decoded `candidates` field.
 * @returns the usable candidates.
 */
export declare function readCandidates(value: unknown): Candidate[];
/** Everything the service needs to start. */
export interface P2PServiceOptions {
    /** The install's tunnel secret, base64url. */
    readonly tunnelSecret: string;
    /** STUN servers to ask. Empty means host candidates and a port mapping only. */
    readonly stunServers?: readonly string[];
    /** Ask the router for a forwarded port. */
    readonly portMapping?: Omit<PortMappingOptions, 'internalPort'>;
    /** The numbers. */
    readonly policy?: Policy;
    /** Where to report what happened. */
    readonly log?: (message: string) => void;
}
/**
 * The desktop's direct-path service: one engine, one accept loop, one signaling
 * channel per phone.
 */
export declare class P2PService {
    /** This install's endpoint id — what a phone dials and `host.info` advertises. */
    readonly endpointId: string;
    private readonly engine;
    private readonly log;
    private accepts;
    private running;
    private streamListeners;
    private readonly signals;
    /**
     * A service around an engine.
     *
     * Prefer ``P2PService.start``: it derives the identity and starts the accept
     * loop. This constructor exists so a test can supply its own engine, which is
     * the only way to exercise the signaling vocabulary without a socket.
     *
     * @param engine - the engine to serve with.
     * @param log - where to report what happened.
     */
    constructor(engine: P2PEngineLike, log: (message: string) => void);
    /**
     * Start the engine and the accept loop.
     * @param options - identity source, network hints, policy.
     * @returns the running service.
     */
    static start(options: P2PServiceOptions): Promise<P2PService>;
    /** Where this endpoint can be reached right now. */
    candidates(): Candidate[];
    /**
     * Register the consumer of accepted connections.
     *
     * One listener, not a queue: the plugin has exactly one frame-serving path,
     * and a second consumer would split connections by timing.
     *
     * @param listener - called with a channel and the remote's description.
     */
    onStream(listener: (channel: MizarChannelLike, remote: string) => void): void;
    /**
     * Attach a signaling channel — one per phone.
     *
     * Both sides say hello on connect: the phone because it is about to dial, the
     * desktop because the dialer needs somewhere to aim. Candidates learned from
     * the phone go straight into the engine, whose acceptor punch is what opens
     * this side's filter.
     *
     * @param channel - the phone's signal channel.
     */
    attachSignal(channel: SignalChannelLike): void;
    /** Stop accepting, drop every stream, and close the engine. */
    close(): Promise<void>;
    private handleSignal;
    private acceptLoop;
}
/**
 * A p2p stream, wearing the shape the listener serves.
 *
 * The listener speaks WebSocket frames; a punched connection carries bytes. The
 * translation is one message per frame, which is what the phone's own transport
 * does in the other direction (`P2PWebSocketTransport`).
 */
export declare class StreamChannel implements MizarChannelLike {
    private readonly stream;
    private readonly messageListeners;
    private readonly closeListeners;
    private pumping;
    private finished;
    constructor(stream: StreamLike);
    get open(): boolean;
    onMessage(listener: (data: Buffer, isBinary: boolean) => void): void;
    onClose(listener: () => void): void;
    send(text: string): void;
    close(_code?: number, reason?: string): void;
    private pump;
    private finish;
}
/**
 * A WebSocket, wearing the shape a signaling channel needs.
 *
 * The listener owns the upgrade; this only translates. Text in, text out — the
 * signal vocabulary is JSON and nothing here parses it.
 *
 * @param socket - the accepted socket.
 * @returns the channel.
 */
export declare function adaptSignalSocket(socket: WebSocket): SignalChannelLike;
/**
 * A digest of a tunnel secret, for logs.
 *
 * Prints eight characters of a SHA-256 — enough to tell two installs apart in a
 * support conversation, useless for impersonating one.
 *
 * @param tunnelSecret - the raw secret.
 * @returns the short form.
 */
export declare function shortSecret(tunnelSecret: string): string;
