/**
 * DSH Link v1 — the wire between this plugin and the AGI Mizar desktop app.
 *
 * One loopback WebSocket, and the plugin is the **client**. That direction is
 * the whole security posture: the plugin opens no port, advertises nothing, and
 * has no reachable surface when the desktop is not running. It also means the
 * desktop can be restarted at will without leaving a stale listener behind.
 *
 * ### Two properties the frames have to keep
 *
 * **Opaqueness.** `payload`, `value`, `request` and `details` are carried
 * through untouched. This module validates the envelope and nothing inside it.
 * The plugin is not allowed to know what a session event looks like, because the
 * day it does, a new DSH field needs a new plugin release.
 *
 * **Fidelity.** `toWire` is a total serialiser with one job: produce what
 * `JSON.stringify` would produce, minus the values JSON cannot carry. It must
 * never drop a key because the key was not expected — that is the difference
 * between "the desktop can use a new field tomorrow" and "the plugin silently
 * ate it".
 *
 * @module dsh-mizar/link/frames
 */

/** Protocol version of this link. Independent of DSH's own versions. */
export const LINK_VERSION = 1

/** The path the desktop serves this link on. */
export const LINK_PATH = '/dsh'

/** What the plugin reports about itself and its host at handshake. */
export interface PluginIdentity {
  readonly name: string
  readonly version: string
  readonly linkVersion: number
}

/** What the plugin reports about the DSH process it lives in. */
export interface HostIdentity {
  /** `darwin` / `win32` / `linux`. */
  readonly platform: string
  /** DSH's home directory, as the plugin sees it. */
  readonly home: string
  /** Node's version — the runtime the plugin actually runs on. */
  readonly node: string
}

/** First frame on every connection. */
export interface HelloFrame {
  readonly v: typeof LINK_VERSION
  readonly type: 'hello'
  readonly token: string
  readonly plugin: PluginIdentity
  readonly dsh: HostIdentity
  /** Every strict endpoint registered in this process, `namespace/method`. */
  readonly endpoints: readonly string[]
  /** In-process services the desktop may call. */
  readonly services: readonly string[]
}

/** One post-commit record or projection change, forwarded verbatim. */
export interface EventFrame {
  readonly v: typeof LINK_VERSION
  readonly type: 'event'
  /** Monotonic across sessions. A gap means the desktop must re-read. */
  readonly seq: number
  /** ISO timestamp of forwarding, not of the record. */
  readonly at: string
  readonly sessionId: string | null
  /** `session/event` or `projection/changed`. */
  readonly name: string
  readonly payload: unknown
}

/** A unary result. */
export interface ResultFrame {
  readonly v: typeof LINK_VERSION
  readonly type: 'result'
  readonly id: string
  readonly ok: true
  readonly value: unknown
}

/** A failed call. Upstream codes are passed through, never re-mapped. */
export interface FailureFrame {
  readonly v: typeof LINK_VERSION
  readonly type: 'result'
  readonly id: string
  readonly ok: false
  readonly code: string
  readonly message: string
  readonly details?: unknown
}

/** One item of a stream result. */
export interface StreamItemFrame {
  readonly v: typeof LINK_VERSION
  readonly type: 'stream.item'
  readonly id: string
  readonly value: unknown
}

/** A stream ended. `reason` is `done`, `cancelled` or `failed`. */
export interface StreamEndFrame {
  readonly v: typeof LINK_VERSION
  readonly type: 'stream.end'
  readonly id: string
  readonly reason: string
}

/** An agent is blocked on a permission prompt. `request` is DSH's own payload. */
export interface ApprovalFrame {
  readonly v: typeof LINK_VERSION
  readonly type: 'approval'
  readonly id: string
  readonly request: unknown
}

/** An agent is blocked on a question batch. `request` is DSH's own payload. */
export interface QuestionFrame {
  readonly v: typeof LINK_VERSION
  readonly type: 'question'
  readonly id: string
  readonly request: unknown
}

/** An operator-facing notice, shown by the desktop. Never fatal. */
export interface NoticeFrame {
  readonly v: typeof LINK_VERSION
  readonly type: 'notice'
  readonly level: 'info' | 'warn'
  readonly message: string
}

/** Everything the plugin sends. */
export type FrameToDesktop =
  | HelloFrame
  | EventFrame
  | ResultFrame
  | FailureFrame
  | StreamItemFrame
  | StreamEndFrame
  | ApprovalFrame
  | QuestionFrame
  | NoticeFrame

/** The desktop accepted the handshake. */
export interface WelcomeFrame {
  readonly v: typeof LINK_VERSION
  readonly type: 'welcome'
  readonly linkVersion: number
  readonly desktop?: string
}

/** Call any registered strict endpoint. */
export interface InvokeFrame {
  readonly v: typeof LINK_VERSION
  readonly type: 'invoke'
  readonly id: string
  readonly endpoint: string
  readonly args: unknown
  readonly mode: 'unary' | 'stream'
}

/** Call an in-process service method. */
export interface ServiceFrame {
  readonly v: typeof LINK_VERSION
  readonly type: 'service'
  readonly id: string
  readonly service: string
  readonly method: string
  readonly args: readonly unknown[]
}

/** Stop a running stream. */
export interface CancelFrame {
  readonly v: typeof LINK_VERSION
  readonly type: 'cancel'
  readonly id: string
}

/** Answer a pending approval or question batch. */
export interface AnswerFrame {
  readonly v: typeof LINK_VERSION
  readonly type: 'answer'
  readonly id: string
  /** Approval only: `allowed-once` or `rejected`. */
  readonly outcome?: string
  /** Question only: one entry per question. */
  readonly answers?: readonly unknown[]
}

/** Ask the plugin to stop forwarding event names the desktop does not need. */
export interface FilterFrame {
  readonly v: typeof LINK_VERSION
  readonly type: 'filter'
  readonly drop: readonly string[]
}

/** Everything the desktop sends. */
export type FrameToPlugin = WelcomeFrame | InvokeFrame | ServiceFrame | CancelFrame | AnswerFrame | FilterFrame

/**
 * Serialise a value for the wire without losing anything JSON can carry.
 *
 * `JSON.stringify` already does most of this. The replacer exists for the four
 * things it cannot: functions and symbols (dropped, as JSON does), bigints
 * (rendered as strings rather than throwing), and `AbortSignal`s — which appear
 * on Cordis waterfall payloads and would otherwise be serialised as an empty
 * object that looks like data.
 *
 * A value that cannot be serialised at all (a cycle) becomes a marker rather
 * than an exception: one weird record must not take down the feed.
 *
 * @param value - anything.
 * @returns a JSON-safe projection of it.
 */
export function toWire(value: unknown): unknown {
  try {
    // `JSON.stringify` writes a lone surrogate as `\ud83d` with no trailing
    // half, because JavaScript strings allow one. A strict JSON reader (ours
    // included) refuses the whole document over it, so a single half emoji in
    // one session title can cost a 900 KB answer. `toWellFormed` replaces those
    // halves with U+FFFD before they reach the wire.
    const text = JSON.stringify(wellFormed(value), (_key, item: unknown) => {
      if (typeof item === 'function' || typeof item === 'symbol') return undefined
      if (typeof item === 'bigint') return item.toString()
      if (item instanceof AbortSignal) return undefined
      if (item instanceof Error) {
        return { name: item.name, message: item.message, stack: item.stack }
      }
      return item
    })
    return text === undefined ? null : (JSON.parse(text) as unknown)
  } catch {
    return { __unserializable: true, kind: typeof value }
  }
}

/**
 * Replace lone surrogates in every string, recursively.
 *
 * Cheap enough at these sizes and only on the outbound path, and it keeps a
 * producer's malformed string from becoming a consumer's parse failure.
 */
function wellFormed(value: unknown): unknown {
  if (typeof value === 'string') return value.toWellFormed()
  if (Array.isArray(value)) return value.map(wellFormed)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value)) out[key] = wellFormed(item)
    return out
  }
  return value
}

/** Read a string field from an unknown record. */
function text(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Parse one frame the desktop sent.
 *
 * Unknown frame types return `null` rather than throwing: a desktop that grew a
 * frame this plugin does not know is a version skew, and the right answer is to
 * ignore that frame, not to drop the connection.
 *
 * @param raw - the text of one WebSocket message.
 * @returns the frame, or `null` when it is not one this version understands.
 */
export function parseDesktopFrame(raw: string): FrameToPlugin | null {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const frame = value as Record<string, unknown>
  const type = text(frame, 'type')
  if (type === undefined) return null

  switch (type) {
    case 'welcome': {
      const linkVersion = frame['linkVersion']
      return {
        v: LINK_VERSION,
        type: 'welcome',
        linkVersion: typeof linkVersion === 'number' ? linkVersion : 0,
        ...(text(frame, 'desktop') === undefined ? {} : { desktop: text(frame, 'desktop') as string }),
      }
    }
    case 'invoke': {
      const id = text(frame, 'id')
      const endpoint = text(frame, 'endpoint')
      if (id === undefined || endpoint === undefined) return null
      const mode = frame['mode'] === 'stream' ? 'stream' : 'unary'
      return { v: LINK_VERSION, type: 'invoke', id, endpoint, args: frame['args'], mode }
    }
    case 'service': {
      const id = text(frame, 'id')
      const service = text(frame, 'service')
      const method = text(frame, 'method')
      if (id === undefined || service === undefined || method === undefined) return null
      const args = Array.isArray(frame['args']) ? (frame['args'] as unknown[]) : []
      return { v: LINK_VERSION, type: 'service', id, service, method, args }
    }
    case 'cancel': {
      const id = text(frame, 'id')
      return id === undefined ? null : { v: LINK_VERSION, type: 'cancel', id }
    }
    case 'answer': {
      const id = text(frame, 'id')
      if (id === undefined) return null
      const outcome = text(frame, 'outcome')
      const answers = Array.isArray(frame['answers']) ? (frame['answers'] as unknown[]) : undefined
      return {
        v: LINK_VERSION,
        type: 'answer',
        id,
        ...(outcome === undefined ? {} : { outcome }),
        ...(answers === undefined ? {} : { answers }),
      }
    }
    case 'filter': {
      const drop = Array.isArray(frame['drop'])
        ? (frame['drop'] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
        : []
      return { v: LINK_VERSION, type: 'filter', drop }
    }
    default:
      return null
  }
}

/**
 * Build the handshake this plugin sends.
 * @param input - token, identities, endpoint and service names.
 * @returns the frame.
 */
export function helloFrame(input: {
  token: string
  plugin: PluginIdentity
  dsh: HostIdentity
  endpoints: readonly string[]
  services: readonly string[]
}): HelloFrame {
  return {
    v: LINK_VERSION,
    type: 'hello',
    token: input.token,
    plugin: input.plugin,
    dsh: input.dsh,
    endpoints: [...input.endpoints],
    services: [...input.services],
  }
}
