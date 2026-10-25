/**
 * One session: a reliable, ordered, message-preserving channel over the shared
 * UDP socket.
 *
 * The same contract the Swift session implements, because the two have to
 * interoperate:
 *
 *  - a message is chunked to fit a datagram, and the chunks carry no offset —
 *    the receiver reassembles them in *packet number* order, which is why the
 *    sender must number them in the order it sends them;
 *  - the sender keeps the sealed bytes until an ack arrives and retransmits on
 *    a doubling timer;
 *  - the receiver acks what it delivers, buffers what arrives early (64
 *    packets) and reassembles messages from their chunks;
 *  - keepalives keep a NAT mapping warm, and silence beyond three of them is
 *    reported as degraded rather than written into a hole.
 *
 * No congestion control, on purpose: the traffic is request/response JSON at
 * human speeds, and a window would add failure modes without adding throughput
 * that matters.
 *
 * @module dsh-mizar/transport/p2p/session
 */
import { type KeyObject } from 'node:crypto';
import type { Policy } from './policy.js';
import type { Address, DatagramSocket } from './socket.js';
/** Which side of the handshake a session was built from. Decides key direction. */
export type SessionRole = 'dialer' | 'acceptor';
/** Which kind of path a stream is carried on. */
export type PathKind = 'lan' | 'p2p' | 'relay';
/** The engine's read on a path. */
export type Health = {
    readonly state: 'unknown';
} | {
    readonly state: 'healthy';
    readonly rttMilliseconds: number;
} | {
    readonly state: 'degraded';
    readonly rttMilliseconds: number;
    readonly lossPercent: number;
};
/** A reliable, ordered, bidirectional message stream. */
export interface Stream {
    readonly pathKind: PathKind;
    readonly connectionId: bigint;
    readonly remoteEndpointId: string;
    /**
     * Send one message.
     * @param data - the message.
     */
    send(data: Buffer): Promise<void>;
    /**
     * Await the next message.
     * @returns the message, or `null` when the peer closed the session.
     */
    receive(): Promise<Buffer | null>;
    /** Close the session, telling the peer. */
    close(reason?: string): Promise<void>;
    /** The session's read on itself. */
    health(): Health;
}
/** One session on the engine's socket. */
export declare class Session implements Stream {
    readonly pathKind: PathKind;
    readonly connectionId: bigint;
    readonly remoteEndpointId: string;
    /** This side's ephemeral public key — what a ServerHello answers with. */
    readonly localEphemeralPublicKey: Buffer;
    /**
     * Whether this session was started by a punch of ours rather than by a hello
     * we received. The engine's reconcile uses it, together with the connection
     * id, to pick the session a simultaneous open keeps.
     */
    readonly fromOwnPunch: boolean;
    private readonly socket;
    private readonly remote;
    private readonly keys;
    private readonly policy;
    private readonly onClose;
    private outgoingPacketNumber;
    private readonly unacked;
    private expectedPacketNumber;
    private readonly reorderBuffer;
    private incomingChunks;
    private incomingLength;
    private incomingMessageLength;
    private readonly recentReceived;
    private readonly receivedSet;
    private ackDirty;
    private smoothedRTT;
    private lastReceivedAt;
    private idle;
    private stalled;
    private readonly queued;
    private readonly waiters;
    private closed;
    private readonly timers;
    constructor(options: {
        role: SessionRole;
        connectionId: bigint;
        remote: Address;
        remoteEndpointId: string;
        localEphemeral: KeyObject;
        remoteEphemeralPublicKey: Buffer;
        localEndpointId: string;
        socket: DatagramSocket;
        policy: Policy;
        fromOwnPunch: boolean;
        onClose: (connectionId: bigint) => void;
    });
    /** Start the timers. Called before anything can send or receive on it. */
    activate(): void;
    /**
     * Send one message.
     * @param data - the message; chunked to fit datagrams.
     */
    send(data: Buffer): Promise<void>;
    /**
     * Await the next message.
     * @returns the message, or `null` when the peer closed the session.
     */
    receive(): Promise<Buffer | null>;
    /**
     * One datagram from the engine's dispatch loop.
     *
     * The loop is sequential, which is what keeps packet order intact — and the
     * reassembly below depends on it.
     *
     * @param data - the datagram.
     */
    receiveDatagram(data: Buffer): void;
    /** The session's read on itself. */
    health(): Health;
    /** Close the session, telling the peer. */
    close(reason?: string): Promise<void>;
    private sendChunk;
    private handleData;
    private acceptChunk;
    private deliver;
    private recordReceived;
    /**
     * The acks to ride along on a data packet.
     *
     * Deliberately does *not* clear the dirty flag: if the packet carrying them
     * is lost, the standalone ack timer still owes the peer those numbers, and a
     * sender that never hears them retransmits until the session stalls.
     */
    private piggybackedAcks;
    private processAcks;
    private flushAcksIfNeeded;
    private retransmitAndCheckIdle;
    private sendKeepalive;
    private closeInternal;
}
