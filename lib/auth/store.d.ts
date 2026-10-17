import { type DevicePush, type DeviceRecord } from './devices.js';
import type { PairingSlot } from './pairing.js';
/** Schema version of the state file. */
export declare const STATE_VERSION = 1;
/** The persisted state. */
export interface MizarState {
    readonly version: typeof STATE_VERSION;
    /** Base64url host secret; the root of every pairing code and device token. */
    readonly hostSecret: string;
    /** Stable host identity, shown to the phone on pairing. */
    readonly hostId: string;
    /** When this host first ran Mizar, in epoch milliseconds. */
    readonly createdAt: number;
    /** The outstanding pairing slot, or `null` when no code is live. */
    readonly pairing: PairingSlot | null;
    /** Every device ever paired, including revoked ones. */
    readonly devices: readonly DeviceRecord[];
}
/** One line of the append-only audit log. */
export interface AuditEvent {
    /** Epoch milliseconds. */
    readonly time: number;
    /** What happened. */
    readonly event: 'state-created' | 'pairing-issued' | 'pairing-redeemed' | 'pairing-failed' | 'device-paired' | 'device-revoked' | 'client-connected' | 'client-rejected';
    /** Remote address the request came from, when known. */
    readonly remote?: string;
    /** Free-form detail; never contains secrets. */
    readonly detail?: string;
}
/**
 * Resolve the Mizar state directory for a DSH home.
 * @param env - environment to read `DSH_HOME` from.
 * @param home - the user's home directory.
 * @returns the absolute state directory.
 */
export declare function resolveMizarHome(env?: Record<string, string | undefined>, home?: string): string;
/**
 * Parse persisted JSON into state, or return `null` when it is unusable.
 * @param raw - the file contents.
 * @returns the parsed state, or `null`.
 */
export declare function parseState(raw: string): MizarState | null;
/**
 * Owner-only state store for one DSH home.
 *
 * All writes are serialized through an internal promise chain, so two concurrent
 * mutations cannot interleave their read-modify-write cycles and lose one.
 */
export declare class MizarStore {
    #private;
    private constructor();
    /**
     * Open the store, creating state on first run.
     * @param dir - the state directory, normally from {@link resolveMizarHome}.
     * @param warn - sink for a failure that is survivable but must not be silent,
     *   such as an audit log that has stopped accepting lines. Defaults to
     *   dropping them, which is what a bare test store wants.
     * @returns the opened store.
     */
    static open(dir: string, warn?: (message: string) => void): Promise<MizarStore>;
    /** The current state. Immutable; use {@link mutate} to change it. */
    get state(): MizarState;
    /** The decoded host secret. */
    get secret(): Uint8Array;
    /** The state directory. */
    get dir(): string;
    /**
     * Apply a change and persist it.
     *
     * Calls are serialized: the mutation runs against the state produced by the
     * previous one, so a concurrent pair of updates cannot lose an entry.
     *
     * @param produce - returns the next state; returning the same reference skips the write.
     * @returns the state after the mutation.
     */
    mutate(produce: (state: MizarState) => MizarState): Promise<MizarState>;
    /**
     * Record, or clear, one device's push endpoint.
     *
     * Only ever touches the one device. A phone that registers its token must not
     * be able to disturb another phone's pairing, and the roster is the record of
     * who may connect at all.
     *
     * @param deviceId - the device to update.
     * @param push - the endpoint, or `null` to forget it.
     * @returns whether a device with that id is on the roster.
     */
    setDevicePush(deviceId: string, push: DevicePush | null): Promise<boolean>;
    /**
     * Append one line to the audit log.
     *
     * Auditing never throws into the caller: losing a log line must not take down
     * a pairing request that already succeeded. It is not silent either -- the
     * audit trail is the operator's only forensic record, and a trail that stopped
     * last week looks exactly like a host nothing has happened to.
     *
     * @param event - the event to record.
     */
    audit(event: AuditEvent): Promise<void>;
    /**
     * Read the audit log back, newest last.
     * @param limit - maximum lines to return.
     * @returns the parsed events, skipping unreadable lines.
     */
    readAudit(limit?: number): Promise<AuditEvent[]>;
}
/** Exported for tests: build a state object without touching disk. */
export declare function createInitialState(now?: number): MizarState;
