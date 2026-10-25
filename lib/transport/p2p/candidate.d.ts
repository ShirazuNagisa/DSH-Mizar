/**
 * Candidate addresses, ordered the way ICE orders them.
 *
 * A candidate is a place a peer might be reachable: a host address on its own
 * LAN, the address a STUN server saw (server-reflexive), or, one day, a relay
 * endpoint. The ordering is the only policy here — the engine punches every
 * address it is given, and the order decides which packet goes first.
 *
 * @module dsh-mizar/transport/p2p/candidate
 */
import type { Address } from './socket.js';
/**
 * Where a candidate came from.
 *
 * The values are the ones that travel in signaling, and they must match
 * `MizarNetCandidate.Kind`'s raw values exactly (`serverReflexive`, not the
 * `srflx` ICE prints): Swift decodes the enum by raw value, so a mismatch is
 * not a degraded candidate — it is a signal that fails to decode at all.
 */
export declare enum CandidateKind {
    /** An address on the sender's own network. */
    Host = "host",
    /** The public side of a NAT, as observed by a STUN server or a port mapping. */
    ServerReflexive = "serverReflexive",
    /** A relay endpoint — the fallback that always works. */
    Relay = "relay"
}
/** One address a peer might be reached at. */
export interface Candidate {
    readonly kind: CandidateKind;
    readonly address: string;
    readonly port: number;
    readonly priority: number;
}
/**
 * Build a candidate with its priority filled in.
 *
 * `(type preference << 24) + 1`, the same shape the Swift side computes. The
 * low bit is the component id placeholder — this protocol has one component,
 * so it is a constant, and only the type preference ever moves.
 *
 * @param kind - where the address came from.
 * @param address - the host.
 * @param port - the port.
 * @param localPreference - breaks ties inside a kind; a forwarded port uses 1
 *   so it is tried before the raw reflexive address it shares a kind with.
 * @returns the candidate.
 */
export declare function candidate(kind: CandidateKind, address: string, port: number, localPreference?: number): Candidate;
/**
 * Sort candidates best first.
 * @param candidates - the candidates to order.
 * @returns a new, sorted array.
 */
export declare function sortedByPriority(candidates: readonly Candidate[]): Candidate[];
/**
 * The addresses to punch: what signaling offered, plus the ticket's own hints,
 * best pair first and deduplicated.
 *
 * A hint is `ip:port` — the form a pairing URI can carry. Details are parsed
 * leniently: a hint that does not parse is a hint that is not there, not a
 * reason to refuse the dial.
 *
 * @param offered - candidates learned from the peer.
 * @param hints - `ip:port` strings from the ticket.
 * @param limit - how many addresses to keep; beyond a handful the extra
 *   packets only add noise to a punch that is either working or not.
 * @returns the addresses, best first.
 */
export declare function punchAddresses(offered: readonly Candidate[], hints: readonly string[], limit?: number): Address[];
