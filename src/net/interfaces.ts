/**
 * Listener address selection.
 *
 * Mizar never touches DSH's own bind policy: `dsh web --host 0.0.0.0` is
 * refused on purpose, because exposing the GUI exposes arbitrary code execution
 * to the network. Mizar opens its own listener instead, and this module decides
 * what that listener binds to.
 *
 * Reach for a relay rather than a VPN when a phone has to get in from outside:
 * `dsh plugin` reaches this machine over an outbound connection it dials itself,
 * which needs no inbound port and no address the network has to hand out. The
 * modes here are for the local cases -- the same Wi-Fi, or a single explicit
 * address.
 *
 * Every function here is pure and takes an interface snapshot, so the decisions
 * are testable without depending on the machine the tests run on.
 *
 * @module dsh-mizar/net/interfaces
 */
import { networkInterfaces } from 'node:os'
import type { BindMode } from '../config.js'

/** One address as reported by `os.networkInterfaces()`. */
export interface InterfaceAddress {
  readonly address: string
  readonly family: string
  readonly internal: boolean
}

/** A snapshot of the host's interfaces, keyed by interface name. */
export type InterfaceSnapshot = Readonly<Record<string, readonly InterfaceAddress[] | undefined>>

/** The chosen bind plan. */
export interface BindPlan {
  /** Addresses to listen on. Never empty. */
  readonly addresses: readonly string[]
  /** The mode that actually decided the addresses; may differ from the request. */
  readonly mode: BindMode
  /** Whether the requested mode found nothing and a fallback was used. */
  readonly fellBack: boolean
  /** Human-readable explanation, surfaced in the Web panel and the log. */
  readonly reason: string
}

/** The loopback literal the fallback always lands on. */
export const LOOPBACK = '127.0.0.1'

/**
 * Strip an IPv6 zone index (`fe80::1%en0`) and lowercase the result.
 * @param address - the raw address.
 * @returns the comparable form.
 */
function normalize(address: string): string {
  const withoutZone = address.includes('%') ? address.slice(0, address.indexOf('%')) : address
  return withoutZone.toLowerCase()
}

/**
 * Collect unique, non-internal addresses from a snapshot that satisfy a test.
 * @param snapshot - the interface snapshot.
 * @param accept - predicate over one address.
 * @returns matching addresses, in interface order, deduplicated.
 */
function collect(
  snapshot: InterfaceSnapshot,
  accept: (entry: InterfaceAddress) => boolean,
): string[] {
  const seen = new Set<string>()
  for (const entries of Object.values(snapshot)) {
    for (const entry of entries ?? []) {
      if (entry.internal) continue
      if (!accept(entry)) continue
      const value = normalize(entry.address)
      if (value === '') continue
      seen.add(value)
    }
  }
  return [...seen]
}

/**
 * Read the live interface snapshot from the operating system.
 * @returns the snapshot, safe to pass to {@link selectBindAddresses}.
 */
export function snapshotInterfaces(): InterfaceSnapshot {
  return networkInterfaces() as unknown as InterfaceSnapshot
}

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
export function selectBindAddresses(
  snapshot: InterfaceSnapshot,
  mode: BindMode,
  explicit: readonly string[] = [],
): BindPlan {
  switch (mode) {
    case 'lan': {
      const addresses = collect(snapshot, (entry) => entry.family === 'IPv4')
      if (addresses.length > 0) {
        return { addresses, mode, fellBack: false, reason: `${addresses.length} LAN IPv4 address(es)` }
      }
      return {
        addresses: [LOOPBACK],
        mode: 'loopback',
        fellBack: true,
        reason: 'no non-internal IPv4 address found; binding loopback only',
      }
    }

    case 'loopback':
      return { addresses: [LOOPBACK], mode, fellBack: false, reason: 'loopback requested' }

    case 'addresses': {
      const addresses = [...new Set(explicit.map(normalize).filter((value) => value !== ''))]
      if (addresses.length > 0) {
        return { addresses, mode, fellBack: false, reason: `${addresses.length} configured address(es)` }
      }
      return {
        addresses: [LOOPBACK],
        mode: 'loopback',
        fellBack: true,
        reason: 'bind.addresses is empty; binding loopback only',
      }
    }
  }
}

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
export function bindPlanForRelay(plan: BindPlan, relayEnabled: boolean): BindPlan {
  if (!relayEnabled || plan.addresses.includes(LOOPBACK)) return plan
  return { ...plan, addresses: [...plan.addresses, LOOPBACK] }
}

/**
 * Format an address and port as an authority the iOS app can dial.
 * IPv6 literals are bracketed.
 * @param address - the host address.
 * @param port - the port.
 * @returns `host:port`.
 */
export function authorityOf(address: string, port: number): string {
  return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`
}
