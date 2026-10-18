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
 * mizar://pair?h=<host:port>&c=<CODE>&n=<host name>&v=1[&u=<base url>]
 * ```
 *
 * `h` is an authority, not a URL: it carries no scheme, so the app decides
 * whether to speak `ws://` or `wss://`. An IPv6 literal is bracketed. `c` is the
 * display form of the code, because a human who ends up reading it off the
 * screen should see the same grouped characters the panel shows.
 *
 * `u` is a base URL for a reverse tunnel, and it is optional in both directions.
 * When a computer is only reachable through a relay, `h` is omitted and `u` carries
 * everything -- there is no direct address worth dialling. When both are present
 * the app tries the direct one first, so one QR code covers both "same Wi-Fi"
 * and "anywhere", and the good path is taken when it is available.
 *
 * @module dsh-mizar/protocol/pairing-uri
 */

/** The custom scheme the QR encodes. */
export const PAIRING_SCHEME = 'mizar'

/** The host part of a pairing URI. */
export const PAIRING_URI_PREFIX = `${PAIRING_SCHEME}://pair`

/** A decoded pairing URI. */
export interface PairingTarget {
  /**
   * `host:port` the app should dial directly, or `null` when the host is only
   * reachable through a relay.
   */
  readonly authority: string | null
  /** The pairing code, in display form. */
  readonly code: string
  /** The host's display name, when it was included. */
  readonly hostName: string | null
  /** The protocol version the host speaks. */
  readonly protocolVersion: number | null
  /**
   * Base URL of a reverse tunnel, when the host is behind one.
   *
   * A base URL rather than an authority because the room is part of the path:
   * `https://relay.example.com/r/ABCD1234`. Both the pairing request and the
   * WebSocket are built from it.
   */
  readonly baseURL: string | null
}

/**
 * Build the pairing URI a QR code carries.
 *
 * @param authority - `host:port`, already bracketed for IPv6. Empty when the
 *   host is reachable only through a relay.
 * @param code - the pairing code.
 * @param hostName - the host's display name.
 * @param protocolVersion - the protocol version the host speaks.
 * @param baseURL - the relay base URL, when there is one.
 * @returns the URI, or `null` when there is nothing for a phone to dial.
 */
export function buildPairingUri(
  authority: string,
  code: string,
  hostName: string,
  protocolVersion: number,
  baseURL: string | null = null,
): string | null {
  // A QR with no address at all would scan successfully and then fail with
  // nothing useful to say about why. Refusing to build one is better than
  // rendering a code that cannot work.
  if (authority === '' && (baseURL === null || baseURL === '')) return null

  const params = new URLSearchParams()
  if (authority !== '') params.set('h', authority)
  if (baseURL !== null && baseURL !== '') params.set('u', baseURL)
  params.set('c', code)
  params.set('n', hostName)
  params.set('v', String(protocolVersion))
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
  const baseURL = params.get('u')?.trim() ?? ''
  const code = params.get('c')?.trim() ?? ''
  // The code is the one thing that must always be there; an address may arrive
  // through either parameter, but one of them has to arrive.
  if (code === '' || (authority === '' && baseURL === '')) return null
  if (baseURL !== '' && !isUsableBaseUrl(baseURL)) return null

  const versionText = params.get('v')
  const version = versionText === null ? Number.NaN : Number(versionText)

  return {
    authority: authority === '' ? null : authority,
    code,
    hostName: params.get('n'),
    protocolVersion: Number.isInteger(version) ? version : null,
    baseURL: baseURL === '' ? null : baseURL,
  }
}

/**
 * Whether a base URL is one this client can dial.
 *
 * A scanned code is untrusted input, and this URL decides where a device token
 * gets sent. Restricting the scheme to what the protocol actually speaks keeps a
 * crafted QR from pointing the app somewhere it would never otherwise go.
 *
 * @param value - the candidate.
 * @returns whether it is usable.
 */
export function isUsableBaseUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false
  return parsed.hostname !== ''
}
