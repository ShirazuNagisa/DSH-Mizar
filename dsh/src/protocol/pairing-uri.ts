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
export const PAIRING_SCHEME = 'mizar'

/** The host part of a pairing URI. */
export const PAIRING_URI_PREFIX = `${PAIRING_SCHEME}://pair`

/** A decoded pairing URI. */
export interface PairingTarget {
  /** `host:port` the app should dial. */
  readonly authority: string
  /** The pairing code, in display form. */
  readonly code: string
  /** The host's display name, when it was included. */
  readonly hostName: string | null
  /** The protocol version the host speaks. */
  readonly protocolVersion: number | null
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
export function buildPairingUri(
  authority: string,
  code: string,
  hostName: string,
  protocolVersion: number,
): string {
  const params = new URLSearchParams({
    h: authority,
    c: code,
    n: hostName,
    v: String(protocolVersion),
  })
  return `${PAIRING_URI_PREFIX}?${params.toString()}`
}

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
export function parsePairingUri(input: string): PairingTarget | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith(`${PAIRING_URI_PREFIX}?`)) return null

  let params: URLSearchParams
  try {
    params = new URLSearchParams(trimmed.slice(PAIRING_URI_PREFIX.length + 1))
  } catch {
    return null
  }

  const authority = params.get('h')?.trim() ?? ''
  const code = params.get('c')?.trim() ?? ''
  if (authority === '' || code === '') return null

  const versionText = params.get('v')
  const version = versionText === null ? Number.NaN : Number(versionText)

  return {
    authority,
    code,
    hostName: params.get('n'),
    protocolVersion: Number.isInteger(version) ? version : null,
  }
}
