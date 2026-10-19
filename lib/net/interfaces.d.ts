import type { BindMode } from '../config.js';
/** One address as reported by `os.networkInterfaces()`. */
export interface InterfaceAddress {
    readonly address: string;
    readonly family: string;
    readonly internal: boolean;
}
/** A snapshot of the host's interfaces, keyed by interface name. */
export type InterfaceSnapshot = Readonly<Record<string, readonly InterfaceAddress[] | undefined>>;
/** The chosen bind plan. */
export interface BindPlan {
    /** Addresses to listen on. Never empty. */
    readonly addresses: readonly string[];
    /** The mode that actually decided the addresses; may differ from the request. */
    readonly mode: BindMode;
    /** Whether the requested mode found nothing and a fallback was used. */
    readonly fellBack: boolean;
    /** Human-readable explanation, surfaced in the Web panel and the log. */
    readonly reason: string;
}
/** The loopback literal the fallback always lands on. */
export declare const LOOPBACK = "127.0.0.1";
/**
 * Read the live interface snapshot from the operating system.
 * @returns the snapshot, safe to pass to {@link selectBindAddresses}.
 */
export declare function snapshotInterfaces(): InterfaceSnapshot;
/**
 * Choose the addresses the Mizar listener binds.
 *
 * A requested mode that finds nothing never widens the exposure: it falls back
 * to loopback and says so. That keeps a misconfigured or absent network from
 * quietly publishing the listener on a LAN interface.
 *
 * @param snapshot - the interface snapshot to decide from.
 * @param mode - the requested bind mode.
 * @param explicit - addresses for `mode: 'addresses'`; ignored otherwise.
 * @returns the plan, including whether a fallback was used.
 */
export declare function selectBindAddresses(snapshot: InterfaceSnapshot, mode: BindMode, explicit?: readonly string[]): BindPlan;
/**
 * Add the loopback socket the tunnel replays through.
 *
 * The relay client is a local client like any other: it dials `127.0.0.1:<port>`
 * for every phone request, and bridges a phone WebSocket to a local one. A
 * `lan` plan does not include loopback (it collects non-internal addresses
 * only), so a composition with a relay needs that socket added -- otherwise the
 * tunnel connects out and then has nowhere to replay into, and every phone
 * request over it fails while the logs still say the tunnel is up.
 *
 * Loopback is not exposure: only this machine can dial it. It is where the
 * relay, the panel's own probes and local tools reach the listener, and it does
 * not widen what the LAN bind already publishes.
 *
 * @param plan - the bind plan selected from the operator's settings.
 * @param relayEnabled - whether a tunnel is attached.
 * @returns the plan, with loopback when the tunnel needs it.
 */
export declare function bindPlanForRelay(plan: BindPlan, relayEnabled: boolean): BindPlan;
/**
 * Format an address and port as an authority the iOS app can dial.
 * IPv6 literals are bracketed.
 * @param address - the host address.
 * @param port - the port.
 * @returns `host:port`.
 */
export declare function authorityOf(address: string, port: number): string;
