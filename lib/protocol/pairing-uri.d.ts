/**
 * The pairing URI.
 *
 * What the QR code actually contains. Kept in the protocol layer because both
 * halves depend on it: the Web panel renders it and the app parses it, and the
 * two must agree byte for byte or scanning silently produces a wrong host.
 *
 * Shape:
 *
 * ```
 * mizar://pair?h=<host:port>&c=<CODE>&n=<host name>&v=1
 * ```
 *
 * `h` is an authority, not a URL: it carries no scheme, so the app decides
 * whether to speak `ws://` or `wss://`. An IPv6 literal is bracketed. `c` is the
 * display form of the code, because a human who ends up reading it off the
 * screen should see the same grouped characters the panel shows.
 *
 * @module dsh-mizar/protocol/pairing-uri
 */
/** The custom scheme the QR encodes. */
export declare const PAIRING_SCHEME = "mizar";
/** The host part of a pairing URI. */
export declare const PAIRING_URI_PREFIX = "mizar://pair";
/** A decoded pairing URI. */
export interface PairingTarget {
    /** `host:port` the app should dial. */
    readonly authority: string;
    /** The pairing code, in display form. */
    readonly code: string;
    /** The host's display name, when it was included. */
    readonly hostName: string | null;
    /** The protocol version the host speaks. */
    readonly protocolVersion: number | null;
}
/**
 * Build the pairing URI a QR code carries.
 *
 * @param authority - `host:port`, already bracketed for IPv6.
 * @param code - the pairing code.
 * @param hostName - the host's display name.
 * @param protocolVersion - the protocol version the host speaks.
 * @returns the URI.
 */
export declare function buildPairingUri(authority: string, code: string, hostName: string, protocolVersion: number): string;
/**
 * Parse a pairing URI.
 *
 * Returns `null` rather than throwing for anything unrecognised: a scanned code
 * is untrusted input from a camera, and a wrong QR in front of the lens is a
 * normal thing to encounter.
 *
 * @param input - the scanned text.
 * @returns the target, or `null` when the text is not a usable pairing URI.
 */
export declare function parsePairingUri(input: string): PairingTarget | null;
