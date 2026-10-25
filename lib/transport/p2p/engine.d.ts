/**
 * The engine: one socket, every session, and the punch that starts them.
 *
 * This is the desktop half of the direct path, and it mirrors the Swift
 * engine's decisions rather than its code — the two have to agree on behaviour
 * because they punch at each other:
 *
 *  - a dial adopts a session that already exists instead of punching over it;
 *  - both sides punch (the acceptor answers signaling by sending its own
 *    hello), because a restricted filter only lets a peer in after it has sent
 *    to that peer first;
 *  - a simultaneous open leaves two sessions, and the one with the smaller
 *    connection id wins — a rule both sides compute identically, with no
 *    negotiation;
 *  - a punch loop never reports a timeout while a session to that endpoint
 *    exists, because a connection that is up is not a failure.
 *
 * What it deliberately does not do: choose a fallback path. A path that
 * degrades is reported, and the layer holding the pairing decides what happens
 * next. Two components that both route will eventually disagree.
 *
 * @module dsh-mizar/transport/p2p/engine
 */
import { type Candidate } from './candidate.js';
import { type EndpointIdentity } from './crypto.js';
import { type Policy } from './policy.js';
import { type PortMapper, type PortMappingOptions } from './portmap.js';
import { type Health, type Stream } from './session.js';
import { DatagramSocket } from './socket.js';
/** A failure the engine reports instead of a stream. */
export declare class P2PError extends Error {
    /** The Mizar error code the app layer sees. */
    readonly code: string;
    constructor(code: string, message: string);
}
/** Who to dial. */
export interface Ticket {
    /** The far endpoint's id — the base64url Ed25519 public key. */
    readonly endpointId: string;
    /** `ip:port` hints from the ticket, tried alongside the peer's candidates. */
    readonly direct?: readonly string[];
}
/** The engine. */
export declare class Engine {
    /** This endpoint's identity. */
    readonly identity: EndpointIdentity;
    private readonly policy;
    private readonly stunServers;
    private socket;
    private hostCandidates;
    private readonly reflexiveCandidates;
    private readonly offered;
    private readonly sessions;
    private readonly sessionOrder;
    private activeDial?;
    private readonly dialOutcomes;
    private readonly commitTimers;
    private readonly yielded;
    private acceptorPunchStarted;
    private intent;
    private readonly incomingQueue;
    private readonly incomingWaiters;
    private readonly stunPending;
    private readonly stunResults;
    /** The router mapping in force, if one was granted. */
    private mapper?;
    /** The address a mapping was paired with — the STUN-observed one. */
    private mappedAddress?;
    private mappedCandidate?;
    private mappingTimer?;
    private closed;
    private receiveLoop?;
    private constructor();
    /**
     * Start an engine: bind a socket, learn its addresses, ask STUN what it looks
     * like from outside.
     *
     * @param options - identity, policy, the STUN servers to ask (`host:port`).
     *   An empty list means host candidates only — the LAN case, and what a test
     *   that deliberately wants no outside help passes.
     * @returns the started engine.
     */
    static create(options: {
        identity: EndpointIdentity;
        policy?: Policy;
        stunServers?: readonly string[];
        socket?: DatagramSocket;
        /**
         * Ask the router for a forwarded port. The highest-value traversal work
         * there is: a forwarded port makes a symmetric NAT reachable, which no
         * amount of punching can.
         */
        portMapping?: Omit<PortMappingOptions, 'internalPort'>;
        /** A mapper supplied by the caller — how a test stands in for a router. */
        portMapper?: PortMapper;
    }): Promise<Engine>;
    /** The UDP port this engine is bound to — what a ticket or a test dials. */
    get port(): number;
    /** The candidates this endpoint can offer a peer. */
    localCandidates(): Candidate[];
    /**
     * Candidates the peer announced over signaling.
     *
     * On the side being dialled this is also the moment to punch back: the
     * dialer's first hello is already on its way, and a restricted filter will
     * only let it in if this side has sent to that address first.
     *
     * @param candidates - what the peer offered.
     */
    offerCandidates(candidates: readonly Candidate[]): void;
    /**
     * Say what this engine is for.
     *
     * An engine that has not been told does not punch back: an acceptor punch is
     * a filter opener, and punching on a side that is itself dialling would race
     * its own dial.
     *
     * @param intent - dialling or waiting to be dialled.
     */
    noteIntent(intent: 'dial' | 'accept'): void;
    /**
     * Dial a peer.
     * @param ticket - who to dial, plus any direct hints.
     * @param timeoutMs - the budget; defaults to the policy's.
     * @returns the connected stream.
     */
    dial(ticket: Ticket, timeoutMs?: number): Promise<Stream>;
    /**
     * Wait for a peer to dial this endpoint.
     * @returns the stream the peer dialled in on.
     */
    accept(): Promise<Stream>;
    /** The engine's read on its path. */
    health(): Health;
    /** Close the engine: every session, then the socket. */
    close(): Promise<void>;
    private runReceiveLoop;
    private handleDatagram;
    /**
     * A peer dialled us.
     *
     * The signature is the whole admission check: it proves the sender holds the
     * private half of the endpoint id it claims, which is the trust the pairing
     * established. There is no allow-list, because the session key is bound to
     * *these two* endpoint ids and the Mizar protocol's own device check runs on
     * top of it anyway.
     */
    private handleClientHello;
    /** The far end answered our hello. */
    private handleServerHello;
    /**
     * Route an endpoint's surviving session to whoever is waiting for it.
     *
     * The wait ends the moment both kinds of session exist — the common case,
     * costing milliseconds — or when the grace expires. The symmetric-acceptor
     * case arrives through the same door: only the punch-back session exists,
     * the grace expires, and it becomes the connection.
     */
    private scheduleCommit;
    private clearCommit;
    private hasBothKinds;
    private commit;
    /**
     * One session per endpoint: the smaller connection id wins.
     *
     * Both sides of a simultaneous open hold the same two connection ids — each
     * side's own punch and the hello it received — so both close the same loser
     * without a word between them.
     */
    private reconcile;
    private adoptExistingSession;
    private sessionsTo;
    private deliverIncoming;
    private startAcceptorPunchIfNeeded;
    /**
     * Send the hello to every candidate, several times.
     *
     * Rounds rather than a shared clock: two peers that started dialling
     * milliseconds apart are absorbed by repetition, and neither needs to know
     * when the other began.
     */
    private punch;
    private buildHello;
    private answerHello;
    private cleanupDial;
    private takeOutcome;
    private gatherReflexiveCandidates;
    private handleSTUNResponse;
    /**
     * Adopt a granted mapping as a candidate.
     *
     * A mapping is only half an address: the port is what the router forwards,
     * the address is what STUN saw. Pairing them is the point — the pair is
     * reachable even when the NAT is symmetric, because the router is now
     * forwarding instead of filtering.
     */
    private adoptPortMapping;
    private installMappedCandidate;
    private renewMapping;
    private removeSession;
}
/** The identity a desktop derives from its host secret. */
export declare function hostIdentity(hostSecret: Buffer): EndpointIdentity;
/** The identity a phone derives from its device token. */
export declare function deviceIdentity(deviceTokenDigest: Buffer): EndpointIdentity;
