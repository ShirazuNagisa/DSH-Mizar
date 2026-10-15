/**
 * The Web panel's status view.
 *
 * Pure, so the shape the panel renders is testable without a browser or a
 * running host. The panel polls this and re-renders whole: the payload is small
 * enough that a partial-update protocol would be one more thing to get wrong for
 * no gain.
 *
 * @module dsh-mizar/panel/status
 */
import type { DeviceRecord } from '../auth/devices.js';
import type { PairingSlot } from '../auth/pairing.js';
import type { BindPlan } from '../net/interfaces.js';
/** One device row. */
export interface PanelDeviceView {
    readonly deviceId: string;
    readonly name: string;
    readonly model: string | null;
    /** Short non-secret id, so a support request can name a device. */
    readonly tokenPrefix: string;
    readonly createdAt: number;
    readonly lastSeenAt: number;
    readonly revoked: boolean;
}
/** The pairing block, present only while a code is live. */
export interface PanelPairingView {
    /** Grouped form, for reading aloud. */
    readonly display: string;
    /** Epoch milliseconds the code stops working. */
    readonly expiresAt: number;
    /** What the QR code encodes. */
    readonly uri: string;
}
/**
 * The reverse tunnel, when one is configured.
 *
 * `connected` and `pairBaseURL` are separate on purpose: a relay can be enabled
 * and unreachable, which is the state an operator most needs the panel to
 * distinguish from "no relay configured" -- in the first case phones that used
 * to work have stopped, and in the second they never would have.
 */
export interface PanelRelayView {
    readonly enabled: boolean;
    readonly connected: boolean;
    /** The room the relay assigned, once it has. */
    readonly room: string | null;
    /** The base URL a phone should be paired against, once known. */
    readonly pairBaseURL: string | null;
    /** The last failure, or `null`. */
    readonly lastError: string | null;
}
/** How the listener is bound. */
export interface PanelBindView {
    readonly mode: string;
    /** Whether the requested mode found nothing and fell back to loopback. */
    readonly fellBack: boolean;
    readonly reason: string;
}
/** Everything the panel renders. */
export interface PanelStatus {
    readonly hostId: string;
    readonly hostName: string;
    readonly protocolVersion: number;
    /** Whether the listener bound successfully. */
    readonly listening: boolean;
    /** Every `host:port` the phone can dial. */
    readonly authorities: readonly string[];
    readonly bind: PanelBindView;
    /** The live pairing code, or `null` when none is outstanding. */
    readonly pairing: PanelPairingView | null;
    /** Paired devices, live first, newest first within each group. */
    readonly devices: readonly PanelDeviceView[];
    /** How many authenticated clients are connected right now. */
    readonly clients: number;
    /** The reverse tunnel, or `null` when none is configured. */
    readonly relay: PanelRelayView | null;
}
/** What the status builder needs. */
export interface PanelStatusInput {
    readonly hostId: string;
    readonly hostName: string;
    readonly protocolVersion: number;
    readonly authorities: readonly string[];
    readonly plan: BindPlan;
    readonly pairing: PairingSlot | null;
    readonly devices: readonly DeviceRecord[];
    readonly clients: number;
    /** The reverse tunnel's state, or `null` when none is configured. */
    readonly relay: Omit<PanelRelayView, 'enabled'> | null;
    /** Current time, for deciding whether a code is still live. */
    readonly now: number;
    /**
     * Recover the canonical code for a live slot.
     *
     * The slot stores only a counter and a deadline — the code is *derived* from
     * the host secret, never stored — so the caller supplies the derivation. The
     * builder itself never sees the secret.
     */
    readonly deriveCode: (slot: PairingSlot) => string;
}
/**
 * Build the panel's status view.
 *
 * A pairing slot is only reported while it is live. The slot persists with
 * `expiresAt: 0` once a code is redeemed, and showing a spent code would invite
 * an operator to read out something that can never work.
 *
 * @param input - host facts, stored state, and the code derivation.
 * @returns the status the panel renders.
 */
export declare function buildPanelStatus(input: PanelStatusInput): PanelStatus;
