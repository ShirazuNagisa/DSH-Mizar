/**
 * The tunnel client: the computer dialling out.
 *
 * The contract this exists to satisfy is that a computer behind a firewall which
 * blocks all inbound traffic is still reachable, and the only way to do that is
 * to be the one who dials. So this connects *out* to the relay and holds the
 * connection open; the relay replays phone requests down it and this replays
 * them against the listener already running on loopback.
 *
 * Replaying rather than reimplementing is the point. The listener, the pairing
 * endpoint, the method table and every error code keep working exactly as they
 * do on a LAN, because from their side nothing has changed -- a request arrives
 * on a socket and an answer goes back. Nothing in `src/server/listener.ts` knows
 * this file exists.
 *
 * @module dsh-mizar/relay/client
 */
import { WebSocket } from 'ws'
import {
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
  parseRelayFrame,
  type HostToRelay,
  type RelayToHost,
  type RelayStreamMessage,
} from './protocol.js'

/** How the client is configured. */
export interface RelayClientOptions {
  /**
   * The relay's base URL.
   *
   * `https://` and `http://` are both accepted and translated to `wss://` and
   * `ws://`, because the value a human copies out of a browser is an `https`
   * URL and making them rewrite it is a needless way to get it wrong.
   */
  readonly url: string
  /** The tunnel token. Sent as a bearer token on the upgrade. */
  readonly token: string
  /** Local port the listener is bound to. */
  readonly localPort: number
  /** Local interface the listener is bound to. */
  readonly localHost?: string
  /** Where to report. */
  readonly log: (message: string) => void
  /** Called whenever the connection state or room changes. */
  readonly onState?: (state: RelayClientState) => void
  /** Injected for tests; defaults to the real `ws` constructor. */
  readonly socketFactory?: (url: string, token: string) => RelaySocket
  /** First reconnect delay, in ms. Doubles up to the cap. */
  readonly reconnectBaseMs?: number
  /** Longest reconnect delay, in ms. */
  readonly reconnectMaxMs?: number
  /**
   * How long the relay may stay silent before the tunnel is redialled, in ms.
   *
   * The relay pings every tunnel (`tunnelIdleMs / 3` in its own config, 30 s by
   * default) precisely so that a half-open tunnel becomes a `close` it can act
   * on. The computer has the mirror problem: a network change can blackhole the
   * socket without the operating system ever reporting a close, and then the
   * tunnel is gone at the relay while this side still says "connected" -- which
   * is what left a phone's relay room unreachable for hours. Silence for longer
   * than this window is treated as a dead tunnel and redialled. `0` disables the
   * watchdog.
   */
  readonly watchdogMs?: number
}

/** What the outside world can see about the tunnel. */
export interface RelayClientState {
  readonly connected: boolean
  /** The room the relay assigned, once known. */
  readonly room: string | null
  /** The last failure, or `null`. */
  readonly lastError: string | null
}

/**
 * The subset of a WebSocket this client needs, so a test can stand in.
 *
 * Declared with overloads rather than one loose `on` so the listener parameters
 * stay typed at each call site. The real `ws` WebSocket is structurally close but
 * not identical -- its listeners carry a `this` type and `RawData` instead of
 * `Buffer` -- so it is cast once, where it is constructed, rather than widening
 * this interface until everything happens to fit.
 */
export interface RelaySocket {
  send(text: string): void
  close(code?: number, reason?: string): void
  /**
   * Drop the socket without a closing handshake, when the implementation has
   * one. A half-open socket cannot complete a close handshake, so the watchdog
   * needs this; a test stand-in may omit it and be closed with `close`.
   */
  terminate?(): void
  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'open', listener: () => void): unknown
}

/**
 * Make a close code safe to send.
 *
 * A close frame carries a code, and a few codes describe *the absence* of one:
 * 1005 is "no status received" and 1006 is "connection closed abnormally". They
 * are reported to a `close` handler but are reserved -- RFC 6455 says they must
 * never appear *in* a close frame, and `ws` throws a TypeError if you try. Since
 * a bridged socket forwards the code it was given, the far end has to be able to
 * receive one of these, and without this it takes the process down.
 *
 * Anything reserved or unknown becomes 1000: the peer learns the stream closed
 * and loses only the detail of why, which is better than losing the connection.
 *
 * @param code - the code a socket reported, if any.
 * @returns a code that is legal to send.
 */
export function saneCloseCode(code: number | undefined): number {
  if (code === undefined) return 1000
  if (code === 1000) return 1000
  // Everything RFC 6455 defines as sendable. 1004, 1005, 1006 and 1015 are
  // deliberately absent: they are reserved.
  if (code >= 1001 && code <= 1003) return code
  if (code >= 1007 && code <= 1011) return code
  if (code >= 3000 && code <= 4999) return code
  return 1000
}

/** Bytes `ws` will accept in a close frame's reason. */
const MAX_CLOSE_REASON_BYTES = 123

/**
 * Make a close reason safe to send.
 *
 * The sibling of {@link saneCloseCode}, for the same reason: `WebSocket.close()`
 * throws a `RangeError` -- synchronously, out of the frame handler -- for a
 * reason longer than 123 bytes. A conforming peer cannot produce one (a close
 * frame carries at most 125 bytes), but a relay that is a version ahead, is
 * misconfigured, or is not the one the operator thinks it is, can say anything:
 * the frame arrives as JSON, and `parseRelayFrame` narrows the envelope only.
 *
 * The cut is made on a character boundary, because a reason truncated mid
 * codepoint decodes to U+FFFD and re-encodes to three bytes, which can push the
 * result back over the limit it was cut to.
 *
 * @param reason - the reason the relay reported.
 * @returns a reason that is legal to send.
 */
export function saneCloseReason(reason: string | undefined): string {
  if (reason === undefined || reason === '') return ''
  const bytes = Buffer.from(reason, 'utf8')
  if (bytes.length <= MAX_CLOSE_REASON_BYTES) return reason

  let end = MAX_CLOSE_REASON_BYTES
  // Back up over continuation bytes (0b10xxxxxx) to the start of a character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1
  const cut = bytes.subarray(0, end).toString('utf8')
  return Buffer.byteLength(cut, 'utf8') > MAX_CLOSE_REASON_BYTES ? cut.slice(0, -1) : cut
}

/** Headers that describe one hop and must not be replayed onto the next. */
const HOP_BY_HOP = new Set([
  'connection',
  'upgrade',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
])

/**
 * Turn a relay URL into the WebSocket URL for the tunnel.
 *
 * @param url - `https://relay.example.com`, `wss://…`, or either with a path.
 * @returns the absolute tunnel URL, or `null` when the URL is unusable.
 */
export function tunnelURL(url: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  const scheme =
    parsed.protocol === 'https:' || parsed.protocol === 'wss:'
      ? 'wss:'
      : parsed.protocol === 'http:' || parsed.protocol === 'ws:'
        ? 'ws:'
        : null
  if (scheme === null) return null

  const base = parsed.pathname.replace(/\/+$/, '')
  const result = new URL(parsed.toString())
  result.protocol = scheme
  result.pathname = `${base}${TUNNEL_PATH}`
  result.search = ''
  result.hash = ''
  return result.toString()
}

/**
 * The base URL a phone should be given, for a room.
 *
 * A computer on the same LAN as its relay may dial a private address while a phone
 * has to use the public one, so this prefers `publicUrl` when it is set. With
 * neither set there is nothing to give a phone, and returning `null` beats
 * inventing a URL that will not resolve.
 *
 * @param url - the relay URL the computer dials.
 * @param publicUrl - the operator's override, or empty.
 * @param room - the room, when it is known.
 * @returns the base URL, or `null`.
 */
export function phoneBaseURL(url: string, publicUrl: string, room?: string | null): string | null {
  const source = publicUrl === '' ? url : publicUrl
  let parsed: URL
  try {
    parsed = new URL(source)
  } catch {
    return null
  }
  // A phone speaks https; the computer may have been configured with wss or ws.
  parsed.protocol =
    parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? 'https:' : 'http:'
  parsed.hash = ''
  parsed.search = ''
  const base = parsed.toString().replace(/\/+$/, '')
  return room === undefined || room === null ? base : `${base}/r/${room}`
}

/** Filter replay headers down to the ones that describe the request itself. */
function forwardable(headers: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (typeof headers !== 'object' || headers === null) return out
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value !== 'string') continue
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    out[name] = value
  }
  return out
}

/** The tunnel client. */
export class RelayClient {
  readonly #options: RelayClientOptions
  #localHost: string
  #localPort: number
  #localOrigin: string
  #socket: RelaySocket | null = null
  #stopped = false
  #attempt = 0
  #timer: NodeJS.Timeout | undefined
  /** How long silence from the relay is tolerated before a redial. */
  readonly #watchdogMs: number
  #watchdog: NodeJS.Timeout | undefined
  /** When the last frame from the relay arrived, on any clock change. */
  #lastFrameAt = 0
  /** Phone WebSockets currently bridged through this tunnel, by tunnel id. */
  readonly #streams = new Map<string, WebSocket>()
  #state: RelayClientState = { connected: false, room: null, lastError: null }

  /**
   * @param options - the configuration.
   */
  constructor(options: RelayClientOptions) {
    this.#options = options
    this.#localHost = options.localHost ?? '127.0.0.1'
    this.#localPort = options.localPort
    this.#localOrigin = `http://${this.#localHost}:${this.#localPort}`
    this.#watchdogMs = options.watchdogMs ?? 120_000
  }

  /** The relay connection's current state. */
  get state(): RelayClientState {
    return this.#state
  }

  /** The room the relay assigned, or `null` before the first welcome. */
  get room(): string | null {
    return this.#state.room
  }

  /** Connect, and keep reconnecting until {@link stop}. */
  start(): void {
    this.#stopped = false
    this.#lastFrameAt = Date.now()
    this.#armWatchdog()
    this.#connect()
  }

  /** Stop reconnecting and close the tunnel. */
  stop(): void {
    this.#stopped = true
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = undefined
    if (this.#watchdog !== undefined) clearInterval(this.#watchdog)
    this.#watchdog = undefined
    this.#closeStreams('the tunnel is shutting down')
    this.#socket?.close(1000, 'shutting down')
    this.#socket = null
    this.#setState({ connected: false })
  }

  /**
   * Redial the tunnel now, keeping the reconnect loop.
   *
   * Used when the reason to redial is known here rather than discovered by the
   * transport: the host's network changed, or the listener moved to a different
   * port. The attempt counter is reset so the next socket is tried at the base
   * delay rather than after a backoff earned by an unrelated failure.
   *
   * @param reason - why, for the operator's log.
   */
  reconnectNow(reason: string): void {
    if (this.#stopped) return
    this.#attempt = 0
    if (this.#socket === null) {
      this.#options.log(`relay: ${reason} — redialling the tunnel`)
      this.#scheduleReconnect(0)
      return
    }
    this.#options.log(`relay: ${reason} — redialling the tunnel`)
    this.#drop(reason)
  }

  /**
   * Point the replay target at a listener bound to a different port.
   *
   * Rebinding can land on a different port when the configured one was taken
   * while the listener was moving. The tunnel was constructed with the port the
   * listener had at startup; replaying to the old one would answer every phone
   * request with a connection error over a tunnel that is otherwise healthy.
   *
   * @param port - the listener's current port.
   */
  setLocalPort(port: number): void {
    if (!Number.isFinite(port) || port <= 0 || port === this.#localPort) return
    this.#localPort = port
    this.#localOrigin = `http://${this.#localHost}:${port}`
    this.#options.log(`relay: the listener moved to port ${port}`)
    this.reconnectNow('the listener moved to a different port')
  }

  /** Open a connection attempt. */
  #connect(): void {
    if (this.#stopped) return
    const url = tunnelURL(this.#options.url)
    if (url === null) {
      this.#setState({ connected: false, lastError: `not a usable relay URL: ${this.#options.url}` })
      return
    }

    const socket: RelaySocket =
      this.#options.socketFactory?.(url, this.#options.token) ??
      (new WebSocket(url, {
        headers: { authorization: `Bearer ${this.#options.token}` },
      }) as unknown as RelaySocket)
    this.#socket = socket
    this.#lastFrameAt = Date.now()

    socket.on('open', () => {
      this.#lastFrameAt = Date.now()
      this.#options.log(`relay: connected to ${url}`)
    })
    socket.on('message', (data: Buffer) => {
      this.#lastFrameAt = Date.now()
      this.#receive(data.toString('utf8'))
    })
    socket.on('error', (error: Error) => {
      this.#options.log(`relay: ${error.message}`)
    })
    socket.on('close', () => {
      // A socket this client has already replaced is not news: the watchdog and
      // `reconnectNow` both drop the old socket before scheduling the next, and
      // acting on its late close would reset the backoff they just earned.
      if (this.#socket !== socket) return
      this.#socket = null
      this.#closeStreams('the tunnel closed')
      if (this.#stopped) return
      const delay = this.#backoff()
      this.#setState({ connected: false, lastError: 'the relay connection closed' })
      this.#options.log(`relay: reconnecting in ${Math.round(delay / 1000)}s`)
      this.#scheduleReconnect(delay)
    })
  }

  /** Time one connection attempt, clearing any already pending. */
  #scheduleReconnect(delay: number): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer)
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#connect()
    }, delay)
    this.#timer.unref?.()
  }

  /**
   * Start the silence watchdog.
   *
   * The relay pings every tunnel so a computer that vanished is dropped; this is
   * the same question asked from the other side. Without it a half-open socket
   * -- a laptop that walked to another network -- stays "connected" here while
   * the relay has already forgotten the room, and nothing ever redials.
   */
  #armWatchdog(): void {
    if (this.#watchdog !== undefined || this.#watchdogMs <= 0) return
    const every = Math.max(20, Math.floor(this.#watchdogMs / 4))
    this.#watchdog = setInterval(() => this.#checkWatchdog(), every)
    this.#watchdog.unref?.()
  }

  /** Redial a tunnel the relay has stopped talking to. */
  #checkWatchdog(): void {
    if (this.#stopped || this.#socket === null) return
    const silent = Date.now() - this.#lastFrameAt
    if (silent <= this.#watchdogMs) return
    this.#options.log(
      `relay: the tunnel has been silent for ${Math.round(silent / 1000)}s — redialling it`,
    )
    this.#drop('no traffic from the relay inside the watchdog window')
  }

  /**
   * Forget the current socket and start over.
   *
   * `terminate` rather than `close` where the transport has it: a half-open
   * socket cannot complete a closing handshake, and waiting for one is how the
   * "connected" state outlives the connection. A test socket without `terminate`
   * gets the ordinary close.
   */
  #drop(reason: string): void {
    const socket = this.#socket
    this.#socket = null
    this.#closeStreams(reason)
    if (socket !== null) {
      try {
        if (typeof socket.terminate === 'function') socket.terminate()
        else socket.close(4001, reason)
      } catch {
        // The close/reconnect below is the recovery path; a throwing transport is
        // already gone.
      }
    }
    if (this.#stopped) return
    const delay = this.#backoff()
    this.#setState({ connected: false, lastError: reason })
    this.#options.log(`relay: ${reason}; reconnecting in ${Math.round(delay / 1000)}s`)
    this.#scheduleReconnect(delay)
  }

  /** Exponential backoff with jitter, so many computers do not return in lockstep. */
  #backoff(): number {
    const base = this.#options.reconnectBaseMs ?? 1_000
    const cap = this.#options.reconnectMaxMs ?? 60_000
    const raw = Math.min(cap, base * 2 ** this.#attempt)
    this.#attempt += 1
    // Full jitter. A relay restart would otherwise bring every computer back at once.
    return Math.round(raw / 2 + Math.random() * (raw / 2))
  }

  /** Merge a state change and report it. */
  #setState(patch: Partial<RelayClientState>): void {
    this.#state = { ...this.#state, ...patch }
    this.#options.onState?.(this.#state)
  }

  /** Write a frame, ignoring failures: a dead socket will be noticed by `close`. */
  #send(frame: HostToRelay): void {
    try {
      this.#socket?.send(JSON.stringify(frame))
    } catch {
      // The close handler owns recovery.
    }
  }

  /** Handle one frame from the relay. */
  #receive(text: string): void {
    const frame = parseRelayFrame(text)
    if (frame === null) return

    switch (frame.t) {
      case 'welcome': {
        // A successful welcome is the only thing that resets the backoff: a TCP
        // connect that is immediately refused would otherwise look like progress.
        this.#attempt = 0
        this.#setState({ connected: true, room: frame.room, lastError: null })
        this.#options.log(
          `relay: serving room ${frame.room} (protocol ${frame.protocolVersion}, ` +
            `this build speaks ${TUNNEL_PROTOCOL_VERSION})`,
        )
        return
      }
      case 'ping':
        this.#send({ t: 'pong', id: frame.id })
        return
      case 'req':
        // Guarded rather than `void`ed: an exception out of a method that
        // answers a phone request is an unhandled rejection in this process,
        // which Node turns into a crash, and it would leave the relay holding a
        // phone connection until its own timeout.
        void this.#replayRequest(frame).catch((error: unknown) => {
          this.#send({
            t: 'error',
            id: frame.id,
            message: `the request could not be replayed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          })
        })
        return
      case 'ws-open':
        this.#openStream(frame.id, frame.path, frame.headers)
        return
      case 'ws-msg':
        this.#streamMessage(frame)
        return
      case 'ws-close': {
        const stream = this.#streams.get(frame.id)
        this.#streams.delete(frame.id)
        if (stream === undefined) return
        // The relay forwards whatever code the phone's socket reported, and a
        // `close` handler sees reserved ones -- 1005 and 1006 describe a close
        // that carried no code and must never be sent. `ws` throws a TypeError
        // on those and a RangeError on an over-long reason, and either one used
        // to escape this handler: the plugin went down, or the local socket was
        // left open because the close it was asked for threw.
        const reason =
          typeof frame.reason === 'string' ? frame.reason : 'closed by the phone'
        try {
          stream.close(saneCloseCode(frame.code), saneCloseReason(reason))
        } catch {
          // Already gone in a way `ws` refuses to describe; the socket's own
          // handlers have already heard about it.
        }
        return
      }
      default:
        return
    }
  }

  /**
   * Replay an HTTP request against the local listener.
   *
   * The answer is always sent, including when the local listener refused or is
   * not listening at all. A relay request that never gets an answer would hold a
   * phone connection open until its timeout, and the honest answer -- 502, with
   * the reason -- is available immediately.
   */
  async #replayRequest(frame: Extract<RelayToHost, { t: 'req' }>): Promise<void> {
    try {
      // A body of the wrong type is refused rather than ignored, and refused
      // inside the guard: `parseRelayFrame` narrows the envelope and nothing
      // else, so anything at all may arrive here. Treating a broken frame as
      // "no body" would replay a POST that was meant to carry one, and the
      // caller discards this promise -- which used to mean an unhandled
      // rejection in the DSH process *and* a phone left waiting for an answer
      // that was never coming.
      if (frame.body !== undefined && frame.body !== null && typeof frame.body !== 'string') {
        this.#send({
          t: 'error',
          id: frame.id,
          message: 'the request body was not base64 text',
        })
        return
      }
      const body = typeof frame.body === 'string' ? Buffer.from(frame.body, 'base64') : undefined
      const response = await fetch(`${this.#localOrigin}${String(frame.path)}`, {
        method: typeof frame.method === 'string' ? frame.method : 'GET',
        headers: forwardable(frame.headers),
        ...(body === undefined ? {} : { body }),
        redirect: 'manual',
      })
      const payload = Buffer.from(await response.arrayBuffer())
      const headers: Record<string, string> = {}
      response.headers.forEach((value, name) => {
        if (!HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value
      })
      this.#send({
        t: 'res',
        id: frame.id,
        status: response.status,
        headers,
        body: payload.length === 0 ? null : payload.toString('base64'),
      })
    } catch (error) {
      this.#send({
        t: 'error',
        id: frame.id,
        message: `the local listener did not answer: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  /** Bridge a phone WebSocket onto a local one. */
  #openStream(id: string, path: string, headers: Readonly<Record<string, string>>): void {
    const wsURL = `${this.#localOrigin.replace(/^http/, 'ws')}${path}`
    let socket: WebSocket
    try {
      socket = new WebSocket(wsURL, { headers: forwardable(headers) })
    } catch (error) {
      this.#send({
        t: 'error',
        id,
        message: `could not open a local socket: ${error instanceof Error ? error.message : String(error)}`,
      })
      return
    }

    this.#streams.set(id, socket)

    socket.on('open', () => {
      this.#send({ t: 'ws-open-ok', id })
    })
    socket.on('message', (data: Buffer, isBinary: boolean) => {
      this.#send({
        t: 'ws-msg',
        id,
        data: (Buffer.isBuffer(data) ? data : Buffer.from(String(data))).toString('base64'),
        binary: isBinary,
      })
    })
    socket.on('close', (code: number, reason: Buffer) => {
      if (!this.#streams.delete(id)) return
      this.#send({ t: 'ws-close', id, code: saneCloseCode(code), reason: reason.toString('utf8') })
    })
    socket.on('error', (error: Error) => {
      if (!this.#streams.delete(id)) return
      this.#send({ t: 'error', id, message: error.message })
    })
  }

  /** Pass a message from the phone to the local socket. */
  #streamMessage(frame: RelayStreamMessage): void {
    const stream = this.#streams.get(frame.id)
    if (stream === undefined) return
    try {
      stream.send(Buffer.from(frame.data, 'base64'), { binary: frame.binary })
    } catch {
      // The socket's own error handler reports it; nothing to add here.
    }
  }

  /** Close every bridged stream, telling the phone why. */
  #closeStreams(reason: string): void {
    for (const [id, stream] of this.#streams) {
      this.#streams.delete(id)
      try {
        stream.close(1011, reason)
      } catch {
        // Already gone.
      }
      // No frame back to the relay: it is the one that went away.
    }
  }
}
