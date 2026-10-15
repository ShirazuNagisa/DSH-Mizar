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
import { networkInterfaces } from 'node:os';
/** The loopback literal the fallback always lands on. */
export const LOOPBACK = '127.0.0.1';
/**
 * Strip an IPv6 zone index (`fe80::1%en0`) and lowercase the result.
 * @param address - the raw address.
 * @returns the comparable form.
 */
function normalize(address) {
    const withoutZone = address.includes('%') ? address.slice(0, address.indexOf('%')) : address;
    return withoutZone.toLowerCase();
}
/**
 * Collect unique, non-internal addresses from a snapshot that satisfy a test.
 * @param snapshot - the interface snapshot.
 * @param accept - predicate over one address.
 * @returns matching addresses, in interface order, deduplicated.
 */
function collect(snapshot, accept) {
    const seen = new Set();
    for (const entries of Object.values(snapshot)) {
        for (const entry of entries ?? []) {
            if (entry.internal)
                continue;
            if (!accept(entry))
                continue;
            const value = normalize(entry.address);
            if (value === '')
                continue;
            seen.add(value);
        }
    }
    return [...seen];
}
/**
 * Read the live interface snapshot from the operating system.
 * @returns the snapshot, safe to pass to {@link selectBindAddresses}.
 */
export function snapshotInterfaces() {
    return networkInterfaces();
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
export function selectBindAddresses(snapshot, mode, explicit = []) {
    switch (mode) {
        case 'lan': {
            const addresses = collect(snapshot, (entry) => entry.family === 'IPv4');
            if (addresses.length > 0) {
                return { addresses, mode, fellBack: false, reason: `${addresses.length} LAN IPv4 address(es)` };
            }
            return {
                addresses: [LOOPBACK],
                mode: 'loopback',
                fellBack: true,
                reason: 'no non-internal IPv4 address found; binding loopback only',
            };
        }
        case 'loopback':
            return { addresses: [LOOPBACK], mode, fellBack: false, reason: 'loopback requested' };
        case 'addresses': {
            const addresses = [...new Set(explicit.map(normalize).filter((value) => value !== ''))];
            if (addresses.length > 0) {
                return { addresses, mode, fellBack: false, reason: `${addresses.length} configured address(es)` };
            }
            return {
                addresses: [LOOPBACK],
                mode: 'loopback',
                fellBack: true,
                reason: 'bind.addresses is empty; binding loopback only',
            };
        }
    }
}
/**
 * Format an address and port as an authority the iOS app can dial.
 * IPv6 literals are bracketed.
 * @param address - the host address.
 * @param port - the port.
 * @returns `host:port`.
 */
export function authorityOf(address, port) {
    return address.includes(':') ? `[${address}]:${port}` : `${address}:${port}`;
}
