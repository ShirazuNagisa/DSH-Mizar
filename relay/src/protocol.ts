/**
 * The tunnel wire vocabulary.
 *
 * These types are declared on both sides -- here and in the plugin's
 * `src/relay/protocol.ts` -- because they are separate packages with separate
 * builds, and a shared import would couple a deployed service to a plugin's
 * tsconfig. They are pinned instead by `relay/test/protocol.test.ts` and the
 * plugin's matching test, both decoding the same golden frames from
 * `protocol/fixtures/relay-tunnel.json`: two decoders reading one artifact is
 * what actually holds a contract, and it is the approach this repository already
 * uses for the Mizar protocol itself.
 *
 * Everything is JSON text. Frames are small and the traffic is request/response,
 * so base64 costs less than the complexity of a binary framing layer would.
 *
 * @module dsh-mizar-relay/protocol
 */

/** A request the phone made, on its way to the Mac. */
export interface TunnelRequest {
  readonly t: 'req'
  readonly id: string
  readonly method: string
  /** Path **including** the `/mizar/v1` prefix, as the phone sent it. */
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
  /** Base64 body, or `null` for none. */
  readonly body: string | null
}

/** The Mac's answer to {@link TunnelRequest}. */
export interface TunnelResponse {
  readonly t: 'res'
  readonly id: string
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: string | null
}

/** Open a phone WebSocket through the tunnel. */
export interface TunnelStreamOpen {
  readonly t: 'ws-open'
  readonly id: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
}

/** The Mac accepted the stream; the phone socket is upgraded. */
export interface TunnelStreamOpened {
  readonly t: 'ws-open-ok'
  readonly id: string
}

/** One message in either direction on an open stream. */
export interface TunnelStreamMessage {
  readonly t: 'ws-msg'
  readonly id: string
  /** Base64 payload. Text frames are UTF-8 bytes, like any other payload. */
  readonly data: string
  readonly binary: boolean
}

/** Either side closing a stream. */
export interface TunnelStreamClose {
  readonly t: 'ws-close'
  readonly id: string
  readonly code?: number
  readonly reason?: string
}

/** Liveness. Sent by the relay; the Mac answers with the same id. */
export interface TunnelPing {
  readonly t: 'ping'
  readonly id: string
}

/** Liveness answer. */
export interface TunnelPong {
  readonly t: 'pong'
  readonly id: string
}

/** The first frame the relay sends after a tunnel authenticates. */
export interface TunnelWelcome {
  readonly t: 'welcome'
  /**
   * The room this tunnel serves.
   *
   * The relay derives it from the token rather than accepting one from the Mac.
   * That keeps the derivation in exactly one place -- there is no second
   * implementation to drift -- and means a tunnel cannot claim a room belonging
   * to a different token.
   */
  readonly room: string
  readonly protocolVersion: number
}

/** Everything the relay may send to a Mac. */
export type RelayToHost =
  | TunnelWelcome
  | TunnelRequest
  | TunnelStreamOpen
  | TunnelStreamMessage
  | TunnelStreamClose
  | TunnelPing

/** Everything a Mac may send to the relay. */
export type HostToRelay =
  | TunnelResponse
  | TunnelStreamOpened
  | TunnelStreamMessage
  | TunnelStreamClose
  | TunnelPong
  | { readonly t: 'error'; readonly id: string; readonly message: string }

/** The tunnel protocol version. */
export const TUNNEL_PROTOCOL_VERSION = 1

/** The path a Mac dials to establish its tunnel. */
export const TUNNEL_PATH = '/tunnel'

/** The prefix a phone dials. Everything after it is the room, then the Mizar path. */
export const ROOM_PREFIX = '/r/'

/** Parse a tunnel frame, refusing anything that is not an object with a known `t`. */
export function parseHostFrame(text: string): HostToRelay | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const t = (value as { t?: unknown }).t
  if (typeof t !== 'string') return null
  return value as HostToRelay
}

/** Parse a relay frame. */
export function parseRelayFrame(text: string): RelayToHost | null {
  return parseHostFrame(text) as RelayToHost | null
}

/**
 * Split a phone path into its room and the Mizar path behind it.
 *
 * `/r/ABCD1234/mizar/v1/ws` becomes `{room: 'ABCD1234', path: '/mizar/v1/ws'}`.
 * A path with no room, or an empty one, returns `null` -- the relay answers 404
 * rather than guessing, so a typo in a URL does not silently reach a machine.
 *
 * @param url - the request path, with or without a query string.
 * @returns the split, or `null` when the path is not a room path.
 */
export function splitRoomPath(url: string): { room: string; path: string } | null {
  if (!url.startsWith(ROOM_PREFIX)) return null
  const rest = url.slice(ROOM_PREFIX.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const room = rest.slice(0, slash)
  const path = rest.slice(slash)
  return path === '' ? null : { room, path }
}
