/**
 * One Mac's tunnel, and the rooms they live in.
 *
 * A tunnel is a single outbound WebSocket carrying every phone request that Mac
 * is serving. The multiplexing is deliberately thin -- an id, a promise, a timer
 * -- because the alternative, a real stream protocol with windows and flow
 * control, buys nothing for a workload that is request/response JSON.
 *
 * The behaviour that matters is what happens when the Mac goes away. A dropped
 * tunnel must fail every in-flight request *immediately*: a phone showing a
 * spinner for thirty seconds and then a timeout is indistinguishable from a
 * broken app, and the honest answer ("the Mac is not connected") is available
 * the moment the socket closes.
 *
 * @module dsh-mizar-relay/tunnel
 */
import type { WebSocket } from 'ws'
import { TUNNEL_PROTOCOL_VERSION, parseHostFrame } from './protocol.js'

/** What a caller gets back from a successful request. */
export interface ReplayResult {
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  /** Base64 body, or `null`. */
  readonly body: string | null
}

/** Callbacks a phone WebSocket provides while it is bridged through a tunnel. */
export interface StreamHandlers {
  /** The Mac accepted the upgrade; the phone socket may now be accepted. */
  readonly onOpened: () => void
  /** A message from the Mac. */
  readonly onMessage: (data: Buffer, binary: boolean) => void
  /** The Mac closed the stream. */
  readonly onClose: (code: number, reason: string) => void
  /** The tunnel failed before or during the stream. */
  readonly onError: (message: string) => void
}

/** A stream opened through the tunnel. */
export interface TunnelStream {
  /** Send one message toward the Mac. */
  send(data: Buffer, binary: boolean): void
  /** Close the stream toward the Mac. */
  close(code?: number, reason?: string): void
}

/** One in-flight request. */
interface PendingRequest {
  readonly resolve: (result: ReplayResult) => void
  readonly reject: (error: Error) => void
  readonly timer: NodeJS.Timeout
}

/** One open stream. */
interface PendingStream extends StreamHandlers {
  readonly timer: NodeJS.Timeout
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

/** A tunnel that is not connected cannot serve anything. */
export class TunnelGoneError extends Error {
  constructor(message = 'the Mac is not connected to the relay') {
    super(message)
    this.name = 'TunnelGoneError'
  }
}

/** A request that outlived its deadline. */
export class TunnelTimeoutError extends Error {
  constructor(message = 'the Mac did not answer in time') {
    super(message)
    this.name = 'TunnelTimeoutError'
  }
}

/** The transport a room speaks to its Mac over. */
export interface TunnelSocket {
  send(text: string): void
  close(code?: number, reason?: string): void
  on(event: 'message', listener: (data: Buffer) => void): void
  on(event: 'close', listener: () => void): void
  on(event: 'error', listener: (error: Error) => void): void
  readonly bufferedAmount: number
}

/** One Mac's tunnel. */
export class Tunnel {
  readonly #socket: TunnelSocket
  readonly #requestTimeoutMs: number
  readonly #maxBufferedBytes: number
  readonly #pendingRequests = new Map<string, PendingRequest>()
  readonly #pendingStreams = new Map<string, PendingStream>()
  #nextId = 0
  #closed = false
  #lastPong = Date.now()

  /**
   * @param socket - the host's WebSocket, already authenticated.
   * @param requestTimeoutMs - how long a request may wait for the Mac.
   * @param maxBufferedBytes - drop rather than queue past this, so one slow Mac
   *   cannot grow the relay's memory without bound.
   */
  constructor(socket: TunnelSocket, requestTimeoutMs: number, maxBufferedBytes = 8 * 1024 * 1024) {
    this.#socket = socket
    this.#requestTimeoutMs = requestTimeoutMs
    this.#maxBufferedBytes = maxBufferedBytes

    socket.on('message', (data: Buffer) => this.#receive(data.toString('utf8')))
    socket.on('close', () => this.#failEverything('the tunnel closed'))
    socket.on('error', () => this.#failEverything('the tunnel errored'))
  }

  /** Whether this tunnel can still carry traffic. */
  get alive(): boolean {
    return !this.#closed
  }

  /** How many phone requests are waiting on the Mac right now. */
  get inFlight(): number {
    return this.#pendingRequests.size + this.#pendingStreams.size
  }

  /**
   * Ask the Mac to prove it is still there.
   *
   * A tunnel can be half-open -- the Mac's process is gone, or a NAT mapping
   * expired, and nothing has noticed because no traffic was flowing. Without
   * this the relay would keep routing to a socket that accepts writes and never
   * answers, and every phone request would spend its full timeout learning that.
   *
   * @param id - a correlation id echoed in the pong.
   */
  ping(id: string): void {
    this.#write({ t: 'ping', id })
  }

  /**
   * Whether the Mac has answered recently enough to keep serving.
   * @param idleMs - how long silence is tolerated.
   * @returns whether the tunnel is still considered live.
   */
  responsiveWithin(idleMs: number): boolean {
    return Date.now() - this.#lastPong <= idleMs
  }

  /**
   * Send one request to the Mac and wait for its answer.
   *
   * @param method - the HTTP method.
   * @param path - the Mizar path, including its `/mizar/v1` prefix.
   * @param headers - request headers to carry through.
   * @param body - base64 body, or `null`.
   * @returns the Mac's answer.
   * @throws {TunnelGoneError} when the tunnel is not connected.
   * @throws {TunnelTimeoutError} when the Mac does not answer in time.
   */
  async request(
    method: string,
    path: string,
    headers: Readonly<Record<string, string>>,
    body: string | null,
  ): Promise<ReplayResult> {
    if (this.#closed) throw new TunnelGoneError()

    const id = this.#allocate()
    return await new Promise<ReplayResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pendingRequests.delete(id)
        reject(new TunnelTimeoutError())
      }, this.#requestTimeoutMs)
      timer.unref?.()

      this.#pendingRequests.set(id, { resolve, reject, timer })

      if (!this.#write({ t: 'req', id, method, path, headers, body })) {
        clearTimeout(timer)
        this.#pendingRequests.delete(id)
        reject(new TunnelGoneError('the tunnel is congested'))
      }
    })
  }

  /**
   * Open a stream -- a phone WebSocket -- through the tunnel.
   *
   * @param path - the Mizar path.
   * @param headers - upgrade headers to carry through.
   * @param handlers - where the stream's events go.
   * @returns a handle for sending and closing, or `null` when the tunnel is gone.
   */
  openStream(
    path: string,
    headers: Readonly<Record<string, string>>,
    handlers: StreamHandlers,
  ): TunnelStream | null {
    if (this.#closed) return null

    const id = this.#allocate()
    const timer = setTimeout(() => {
      if (this.#pendingStreams.delete(id)) {
        handlers.onError('the Mac did not accept the stream in time')
      }
    }, this.#requestTimeoutMs)
    timer.unref?.()

    this.#pendingStreams.set(id, { ...handlers, timer })

    if (!this.#write({ t: 'ws-open', id, path, headers })) {
      clearTimeout(timer)
      this.#pendingStreams.delete(id)
      handlers.onError('the tunnel is congested')
      return null
    }

    return {
      send: (data, binary) => {
        this.#write({ t: 'ws-msg', id, data: data.toString('base64'), binary })
      },
      close: (code, reason) => {
        const safe = saneCloseCode(code)
        this.#write({
          t: 'ws-close',
          id,
          code: safe,
          ...(reason === undefined ? {} : { reason }),
        })
        this.#dropStream(id, safe, reason ?? '')
      },
    }
  }

  /** Close the tunnel. In-flight work fails rather than hanging. */
  close(code = 1000, reason = 'relay shutting down'): void {
    this.#socket.close(code, reason)
    this.#failEverything(reason)
  }

  /** A fresh id. Prefixed so a log line says which tunnel it came from. */
  #allocate(): string {
    this.#nextId += 1
    return `r${this.#nextId}`
  }

  /** Write a frame, refusing rather than queueing past the buffer cap. */
  #write(frame: unknown): boolean {
    if (this.#closed) return false
    if (this.#socket.bufferedAmount > this.#maxBufferedBytes) return false
    try {
      this.#socket.send(JSON.stringify(frame))
      return true
    } catch {
      return false
    }
  }

  /** Route one frame from the Mac. */
  #receive(text: string): void {
    const frame = parseHostFrame(text)
    if (frame === null) return
    const id = (frame as { id?: unknown }).id
    if (typeof id !== 'string') return

    switch (frame.t) {
      case 'res': {
        const pending = this.#pendingRequests.get(id)
        if (pending === undefined) return // a late answer to a timed-out request
        clearTimeout(pending.timer)
        this.#pendingRequests.delete(id)
        pending.resolve({
          status: frame.status,
          headers: frame.headers,
          body: frame.body,
        })
        return
      }
      case 'ws-open-ok': {
        const stream = this.#pendingStreams.get(id)
        if (stream === undefined) return
        clearTimeout(stream.timer)
        stream.onOpened()
        return
      }
      case 'ws-msg': {
        const stream = this.#pendingStreams.get(id)
        if (stream === undefined) return
        stream.onMessage(Buffer.from(frame.data, 'base64'), frame.binary)
        return
      }
      case 'ws-close': {
        this.#dropStream(id, frame.code ?? 1000, frame.reason ?? '')
        return
      }
      case 'error': {
        const request = this.#pendingRequests.get(id)
        if (request !== undefined) {
          clearTimeout(request.timer)
          this.#pendingRequests.delete(id)
          request.reject(new Error(frame.message))
          return
        }
        const stream = this.#pendingStreams.get(id)
        if (stream !== undefined) {
          clearTimeout(stream.timer)
          this.#pendingStreams.delete(id)
          stream.onError(frame.message)
        }
        return
      }
      case 'pong':
        this.#lastPong = Date.now()
        return
      default:
        return
    }
  }

  /** Forget a stream and tell its phone socket. */
  #dropStream(id: string, code: number, reason: string): void {
    const stream = this.#pendingStreams.get(id)
    if (stream === undefined) return
    clearTimeout(stream.timer)
    this.#pendingStreams.delete(id)
    stream.onClose(code, reason)
  }

  /**
   * Fail everything outstanding.
   *
   * Called on close and on error. Every waiter is settled here rather than left
   * to its own timer, because "the Mac disconnected" is known now and a phone
   * should not spend the next thirty seconds learning it.
   *
   * @param reason - what to tell the waiters.
   */
  #failEverything(reason: string): void {
    if (this.#closed) return
    this.#closed = true

    for (const [, pending] of this.#pendingRequests) {
      clearTimeout(pending.timer)
      pending.reject(new TunnelGoneError(reason))
    }
    this.#pendingRequests.clear()

    for (const [id, stream] of this.#pendingStreams) {
      clearTimeout(stream.timer)
      this.#pendingStreams.delete(id)
      stream.onError(reason)
    }
  }
}

/** The rooms currently served, keyed by room id. */
export class RoomRegistry {
  readonly #rooms = new Map<string, Tunnel>()

  /** How many Macs are connected. */
  get size(): number {
    return this.#rooms.size
  }

  /** The room ids currently served. */
  get rooms(): readonly string[] {
    return [...this.#rooms.keys()]
  }

  /** Phone requests waiting on a Mac right now, across every room. */
  get inFlight(): number {
    let total = 0
    for (const tunnel of this.#rooms.values()) total += tunnel.inFlight
    return total
  }

  /**
   * Attach a tunnel to a room, replacing any previous one.
   *
   * A Mac that reconnects after a network blip arrives as a new socket while the
   * old one may still be half-open. Replacing is right: the newer connection is
   * the one the Mac is listening on, and keeping both would split phone requests
   * across two sockets where only one is read.
   *
   * @param room - the room id.
   * @param tunnel - the tunnel to serve it.
   * @returns the tunnel that was displaced, if any.
   */
  register(room: string, tunnel: Tunnel): Tunnel | undefined {
    const previous = this.#rooms.get(room)
    this.#rooms.set(room, tunnel)
    return previous
  }

  /**
   * Detach a tunnel, if it is still the current one.
   *
   * The identity check matters: a stale socket closing after its replacement
   * registered must not evict the live tunnel.
   *
   * @param room - the room id.
   * @param tunnel - the tunnel that is going away.
   * @returns whether it was the current one.
   */
  remove(room: string, tunnel: Tunnel): boolean {
    if (this.#rooms.get(room) !== tunnel) return false
    this.#rooms.delete(room)
    return true
  }

  /** The tunnel serving a room, if any. */
  get(room: string): Tunnel | undefined {
    return this.#rooms.get(room)
  }

  /** Close every tunnel. */
  closeAll(): void {
    for (const tunnel of this.#rooms.values()) tunnel.close()
    this.#rooms.clear()
  }
}

export { TUNNEL_PROTOCOL_VERSION }
