import { MizarStore } from '../auth/store.js';
import type { BindPlan } from '../net/interfaces.js';
import { type ServerFrame } from '../protocol/frames.js';
export interface ClientSession {
    /** The device this session speaks for. */
    readonly deviceId: string;
    /** The device's display name. */
    readonly deviceName: string;
    /** The remote address the socket came from. */
    readonly remote: string;
    /** Send one frame to this client, reporting whether it was actually written. */
    send(frame: ServerFrame): boolean;
    /** Close this client's socket. */
    close(code?: number, reason?: string): void;
}
/** Everything the listener needs from its host. */
export interface ListenerOptions {
    /** Addresses to bind, from `selectBindAddresses`. */
    readonly plan: BindPlan;
    /** Configured port. */
    readonly port: number;
    /** Whether to probe upward for a free port. */
    readonly portFallback: boolean;
    /** Persistent host state. */
    readonly store: MizarStore;
    /** Pairing code lifetime, in seconds. */
    readonly pairingTtlSeconds: number;
    /** Pairing attempts allowed per minute per remote address. */
    readonly maxAttemptsPerMinute: number;
    /** Socket heartbeat interval, in milliseconds. */
    readonly heartbeatMs: number;
    /** How long a socket may miss heartbeats before it is dropped. */
    readonly pongTimeoutMs: number;
    /** Sink for operator-facing diagnostics. */
    readonly log: (message: string) => void;
    /** Called once per authenticated connection. */
    readonly onSession?: (session: ClientSession) => void;
    /**
     * Called whenever the authenticated client count changes.
     *
     * The interaction broker uses this as its fail-closed trigger: an approval
     * with nobody left to answer it must settle rather than hang the agent.
     */
    readonly onClientCount?: (count: number) => void;
    /**
     * Called after a method's `ok` frame was written to an open socket.
     *
     * The listener itself has no idea what a result means; this exists so the one
     * thing that does -- the bridge's delivery ledger -- can record what the phone
     * has actually been sent. It must never be called for a frame that was not
     * written: a response refused for size, or one aimed at a socket that had
     * already closed, is not something the phone holds.
     */
    readonly onDelivered?: (method: string, result: unknown, session: ClientSession) => void;
    /**
     * Wire method implementations, keyed by frame `type`.
     *
     * The listener stays transport-only: it moves frames and enforces
     * authentication, and every DSH-shaped decision lives behind this table.
     */
    readonly methods?: Readonly<Record<string, MethodHandler>>;
}
/**
 * A wire method implementation.
 *
 * @param payload - the frame's `payload`, already known to be JSON.
 * @param session - the authenticated connection making the call.
 * @returns the value to place in the `ok` frame's `result`.
 */
export type MethodHandler = (payload: unknown, session: ClientSession) => Promise<unknown>;
/** A running listener. */
export declare class MizarListener {
    #private;
    private constructor();
    /**
     * Bind every planned address on the first free port.
     *
     * The port is probed as a unit across all addresses: a half-bound listener is
     * worse than a failure, because the app would reach one family and not the
     * other with no explanation.
     *
     * @param options - host wiring and configuration.
     * @returns the running listener.
     */
    static start(options: ListenerOptions): Promise<MizarListener>;
    /** The port actually bound. */
    get port(): number;
    /** The addresses actually bound. */
    get addresses(): readonly string[];
    /** The `host:port` authorities a phone can dial, one per bound address. */
    get authorities(): readonly string[];
    /** Every live authenticated session. */
    get sessions(): readonly ClientSession[];
    /** How many authenticated clients could currently answer a question. */
    get clientCount(): number;
    /**
     * Send one frame to every authenticated client.
     *
     * Used for interactions that every client should see — an approval or a
     * question is addressed to the operator, not to one device.
     *
     * @param frame - the frame to deliver.
     */
    broadcast(frame: ServerFrame): void;
    /**
     * Issue a fresh pairing code and persist the slot.
     * @param now - current epoch milliseconds.
     * @returns the code to display.
     */
    issuePairingCode(now?: number): Promise<{
        code: string;
        display: string;
        expiresAt: number;
    }>;
    /**
     * Revoke one device and drop its live sessions.
     * @param deviceId - the device to revoke.
     * @returns whether a device was revoked.
     */
    revokeDevice(deviceId: string): Promise<boolean>;
    /** Close every socket and server. */
    stop(): Promise<void>;
    /**
     * Move the listener to a different set of addresses.
     *
     * Used when the host's network changes under it, most often a VPN that
     * appeared, or came back, after DSH had already started. Connected clients are
     * dropped rather than migrated: their sockets were accepted on an address that
     * may no longer exist, and a phone reconnecting is cheaper than a socket that
     * silently stops delivering.
     *
     * @param plan - the new plan to bind.
     */
    rebind(plan: BindPlan): Promise<void>;
}
