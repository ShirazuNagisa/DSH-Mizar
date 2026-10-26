/**
 * The direct path, from the desktop's side.
 *
 * Until now the plugin served one way: relay → tunnel → loopback listener. That
 * works from anywhere and costs a detour — every byte goes phone → relay →
 * this machine, with the relay metering it and a round trip neither end can
 * remove.
 *
 * This module makes the plugin a *destination* as well: it holds a UDP socket,
 * publishes where it can be reached, and accepts punched connections. A phone
 * that gets through talks to the same listener it always did — the frames are
 * identical, because a punch changes the transport, not the protocol.
 *
 * Three pieces, and they only make sense together:
 *
 *  - **identity**, derived from the tunnel secret the pairing already trusts,
 *    so the endpoint id needs no new secret and survives a reinstall;
 *  - **the engine**, started once and accepting for the life of the process —
 *    the desktop is the side being dialled, so it cannot create one per call;
 *  - **signaling**, a WebSocket the phone reaches through the relay's room
 *    bridge, which is how the two ends learn each other's addresses.
 *
 * Nothing here decides whether to use the direct path: a phone that dials and
 * fails falls back to the relay exactly as before. Two components that both
 * route will eventually disagree.
 *
 * @module dsh-mizar/net/p2p
 */
import { createHash } from 'node:crypto'
import type { WebSocket } from 'ws'
import { candidate, CandidateKind, type Candidate } from '../transport/p2p/candidate.js'
import { deriveIdentity, type EndpointIdentity } from '../transport/p2p/crypto.js'
import { Engine } from '../transport/p2p/engine.js'
import type { PortMappingOptions } from '../transport/p2p/portmap.js'
import { STANDARD_POLICY, type Policy } from '../transport/p2p/policy.js'
import type { Stream } from '../transport/p2p/session.js'

/** The path a phone dials for signaling, behind the relay's room prefix. */
export const SIGNAL_PATH = '/mizar-net/signal'

/**
 * How long a signal channel may stay open without a device token.
 *
 * The business channel allows ten seconds for the same step; a signalling
 * channel has nothing to do before it, so the same window is generous.
 */
const SIGNAL_HANDSHAKE_MS = 10_000

/** Signalling messages one channel may send per window. */
const SIGNAL_BURST = 8

/** The window those messages are counted in. */
const SIGNAL_WINDOW_MS = 10_000

/** The patch of a p2p connection, as far as this module cares. */
export interface StreamLike {
  receive(): Promise<Buffer | null>
  send(data: Buffer): Promise<void>
  close(reason?: string): Promise<void>
}

/** The part of the engine this service uses. */
export interface P2PEngineLike {
  readonly identity: EndpointIdentity
  accept(): Promise<Stream>
  offerCandidates(candidates: readonly Candidate[]): void
  localCandidates(): Candidate[]
  close(): Promise<void>
}

/** What a signaling channel has to be able to do. */
export interface SignalChannelLike {
  send(text: string): void
  onMessage(listener: (text: string) => void): void
  onClose(listener: () => void): void
  /**
   * Close the channel, optionally with a code and a reason.
   *
   * The codes are the ones the business channel uses for the same refusals --
   * 4401 for "who are you", 4408 for "slow down" -- so a phone can tell a
   * rejected signal channel from a dropped one.
   */
  close(code?: number, reason?: string): void
}

/** One Mizar frame's worth of bytes, adapted to the listener's channel shape. */
export interface MizarChannelLike {
  readonly open: boolean
  send(text: string): void
  close(code?: number, reason?: string): void
  onMessage(listener: (data: Buffer, isBinary: boolean) => void): void
  onClose(listener: () => void): void
}

/** A candidate as it travels in signaling — the same JSON the phone writes. */
interface WireCandidate {
  readonly kind: string
  readonly address: string
  readonly port: number
  readonly priority?: number
}

/**
 * This install's endpoint identity.
 *
 * The secret is the tunnel secret: the same bytes that already decide which
 * room this computer serves. Deriving rather than generating means the endpoint
 * id is stable across reinstalls, and a phone that paired once can dial again
 * without another scan.
 *
 * @param tunnelSecret - the install's tunnel secret, base64url text.
 * @returns the identity.
 */
export function deriveEndpointIdentity(tunnelSecret: string): EndpointIdentity {
  const bytes = Buffer.from(tunnelSecret, 'base64url')
  return deriveIdentity(bytes, 'host')
}

/**
 * Turn whatever arrived over signaling into candidates, dropping what does not
 * parse.
 *
 * A signal channel is reachable by anyone holding the room, so its contents are
 * untrusted: a malformed candidate must cost that candidate, not the connection
 * or the process.
 *
 * @param value - the decoded `candidates` field.
 * @returns the usable candidates.
 */
export function readCandidates(value: unknown): Candidate[] {
  if (!Array.isArray(value)) return []
  const out: Candidate[] = []
  for (const entry of value.slice(0, 32)) {
    if (typeof entry !== 'object' || entry === null) continue
    const wire = entry as WireCandidate
    if (typeof wire.address !== 'string' || wire.address === '') continue
    if (!Number.isInteger(wire.port) || wire.port <= 0 || wire.port > 65535) continue
    const kind = wire.kind === 'serverReflexive' || wire.kind === 'relay' ? wire.kind : 'host'
    out.push(candidate(kind as CandidateKind, wire.address, wire.port))
  }
  return out
}

/**
 * Read the token out of a signalling `hello`.
 *
 * The first frame on a signal channel is the phone's, and it carries the same
 * device token the business channel authenticates with. Nothing else is accepted
 * first: a channel that opens with candidates is a channel that has not said who
 * it is.
 *
 * @param text - the raw frame.
 * @returns the token, or `null` when this is not a usable hello.
 */
export function readSignalHello(text: string): string | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const message = value as { v?: unknown; type?: unknown; token?: unknown }
  if (message.v !== 1 || message.type !== 'hello') return null
  if (typeof message.token !== 'string' || message.token === '') return null
  return message.token
}

/**
 * Whether an address is one the host should not punch at.
 *
 * Loopback, "this network", broadcast, multicast and link-local are never a
 * phone on the other side of a NAT: punching at them only turns the host into a
 * probe and a reflector for whoever asked. Private ranges stay, because a phone
 * on the same LAN is exactly what the direct path is for.
 *
 * @param address - a candidate address, IPv4 or IPv6.
 * @returns true when the address is not worth a packet.
 */
export function unroutable(address: string): boolean {
  const value = address.trim().toLowerCase().replace(/^\[|\]$/g, '')
  if (value === '') return true
  if (value === '::' || value === '::1') return true
  // IPv6 link-local and multicast.
  if (value.startsWith('fe80:') || value.startsWith('ff')) return true
  const parts = value.split('.')
  if (parts.length !== 4) return false
  const octets = parts.map((part) => Number(part))
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false
  const first = octets[0]
  const second = octets[1]
  if (first === undefined || second === undefined) return false
  if (first === 0 || first === 127) return true
  if (first === 255 || first >= 224) return true
  if (first === 169 && second === 254) return true
  return false
}

/** Everything the service needs to start. */
export interface P2PServiceOptions {
  /** The install's tunnel secret, base64url. */
  readonly tunnelSecret: string
  /** STUN servers to ask. Empty means host candidates and a port mapping only. */
  readonly stunServers?: readonly string[]
  /** Ask the router for a forwarded port. */
  readonly portMapping?: Omit<PortMappingOptions, 'internalPort'>
  /** The numbers. */
  readonly policy?: Policy
  /** Where to report what happened. */
  readonly log?: (message: string) => void
}

/**
 * The desktop's direct-path service: one engine, one accept loop, one signaling
 * channel per phone.
 */
export class P2PService {
  /** This install's endpoint id — what a phone dials and `host.info` advertises. */
  readonly endpointId: string

  private readonly engine: P2PEngineLike
  private readonly log: (message: string) => void
  private accepts = 0
  private running = true
  private streamListeners: Array<(channel: MizarChannelLike, remote: string) => void> = []
  private readonly signals = new Set<SignalChannelLike>()
  /** Signalling budget per channel, dropped with the channel. */
  private readonly signalSpend = new WeakMap<SignalChannelLike, { at: number; count: number }>()

  /**
   * A service around an engine.
   *
   * Prefer ``P2PService.start``: it derives the identity and starts the accept
   * loop. This constructor exists so a test can supply its own engine, which is
   * the only way to exercise the signaling vocabulary without a socket.
   *
   * @param engine - the engine to serve with.
   * @param log - where to report what happened.
   */
  constructor(engine: P2PEngineLike, log: (message: string) => void) {
    this.engine = engine
    this.endpointId = engine.identity.endpointId
    this.log = log
  }

  /**
   * Start the engine and the accept loop.
   * @param options - identity source, network hints, policy.
   * @returns the running service.
   */
  static async start(options: P2PServiceOptions): Promise<P2PService> {
    const identity = deriveEndpointIdentity(options.tunnelSecret)
    const engine = await Engine.create({
      identity,
      policy: options.policy ?? STANDARD_POLICY,
      // No default here on purpose: this is the seam a test uses to stay
      // offline, and the production caller passes what `resolveStunServers`
      // worked out from its config. An empty list is a supported answer -- host
      // candidates only, which is the LAN case, with the relay carrying every
      // remote session the way it always did.
      stunServers: options.stunServers ?? [],
      ...(options.portMapping === undefined ? {} : { portMapping: options.portMapping }),
    })
    const service = new P2PService(engine, options.log ?? (() => undefined))
    void service.acceptLoop()
    return service
  }

  /** Where this endpoint can be reached right now. */
  candidates(): Candidate[] {
    return this.engine.localCandidates()
  }

  /**
   * Register the consumer of accepted connections.
   *
   * One listener, not a queue: the plugin has exactly one frame-serving path,
   * and a second consumer would split connections by timing.
   *
   * @param listener - called with a channel and the remote's description.
   */
  onStream(listener: (channel: MizarChannelLike, remote: string) => void): void {
    this.streamListeners.push(listener)
  }

  /**
   * Attach a signaling channel — one per phone.
   *
   * Both sides say hello on connect: the phone because it is about to dial, the
   * desktop because the dialer needs somewhere to aim. Candidates learned from
   * the phone go straight into the engine, whose acceptor punch is what opens
   * this side's filter.
   *
   * @param channel - the phone's signal channel.
   */
  attachSignal(channel: SignalChannelLike, authorize: (token: string) => boolean): void {
    // The channel is anonymous until the first frame says otherwise, and nothing
    // about this machine leaves it before then. Announcing first -- as this used
    // to -- handed the endpoint id, every local address and the STUN-reflexive
    // one to anyone who could reach the port.
    let admitted = false
    const deadline = setTimeout(() => {
      if (!admitted) channel.close(4401, 'unauthenticated')
    }, SIGNAL_HANDSHAKE_MS)
    deadline.unref?.()

    channel.onMessage((text) => {
      if (!admitted) {
        const token = readSignalHello(text)
        if (token === null) {
          channel.close(4401, 'hello required')
          return
        }
        if (!authorize(token)) {
          channel.close(4401, 'unauthenticated')
          return
        }
        admitted = true
        clearTimeout(deadline)
        this.signals.add(channel)
        // Now the announcement is owed: the phone has shown it is ours, and it
        // may already be dialling.
        channel.send(
          JSON.stringify({ v: 1, type: 'hello', endpointId: this.endpointId, candidates: this.candidates() }),
        )
        return
      }
      this.handleSignal(channel, text)
    })
    channel.onClose(() => {
      clearTimeout(deadline)
      this.signals.delete(channel)
    })
  }

  /** Stop accepting, drop every stream, and close the engine. */
  async close(): Promise<void> {
    this.running = false
    for (const channel of this.signals) channel.close()
    this.signals.clear()
    await this.engine.close()
  }

  /**
   * Charge one signalling message to the channel's budget.
   *
   * A burst, not a rate: a real handshake is two or three messages, and the
   * point is to stop a loop rather than to police a slow link.
   *
   * @param channel - the channel the message arrived on.
   * @returns false when the channel has spent its window.
   */
  private spendSignal(channel: SignalChannelLike): boolean {
    const now = Date.now()
    const spent = this.signalSpend.get(channel)
    if (spent === undefined || now - spent.at >= SIGNAL_WINDOW_MS) {
      this.signalSpend.set(channel, { at: now, count: 1 })
      return true
    }
    if (spent.count >= SIGNAL_BURST) return false
    spent.count += 1
    return true
  }

  /**
   * Whether a candidate is worth a punch.
   *
   * The engine will happily aim anywhere it is told; this is the only place that
   * decides where "anywhere" stops. Our own addresses are excluded because
   * punching at yourself is the cheapest way to make the host emit packets.
   *
   * @param entry - a candidate from the phone.
   * @returns true when the host may aim at it.
   */
  private punchable(entry: Candidate): boolean {
    if (unroutable(entry.address)) return false
    const own = this.engine.localCandidates()
    return !own.some((mine) => mine.address === entry.address)
  }

  private handleSignal(channel: SignalChannelLike, text: string): void {
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return
    }
    if (typeof value !== 'object' || value === null) return
    const message = value as { v?: unknown; type?: unknown; candidates?: unknown }
    // Version mismatches are dropped rather than argued with: the same
    // tolerance the Mizar protocol has for frames it does not know.
    if (message.v !== 1) return
    if (message.type !== 'hello' && message.type !== 'candidates') return
    if (!this.spendSignal(channel)) {
      // A channel that keeps talking after its budget is gone is not a phone
      // finishing a handshake; closing it costs an honest client one reconnect.
      channel.close(4408, 'signalling too fast')
      return
    }
    const candidates = readCandidates(message.candidates).filter((entry) => this.punchable(entry))
    if (candidates.length === 0) return
    this.engine.offerCandidates(candidates)
    // Answer with ours, so a phone that dialled first learns where to punch
    // after its own candidates arrived.
    channel.send(JSON.stringify({ v: 1, type: 'candidates', candidates: this.candidates() }))
  }

  private async acceptLoop(): Promise<void> {
    while (this.running) {
      let stream: Stream
      try {
        stream = await this.engine.accept()
      } catch {
        // `accept` rejects only when the engine is closing.
        return
      }
      this.accepts += 1
      const label = `p2p/${this.accepts}`
      this.log(`accepted a direct connection (${label})`)
      const channel = new StreamChannel(stream)
      for (const listener of this.streamListeners) listener(channel, label)
    }
  }
}

/**
 * A p2p stream, wearing the shape the listener serves.
 *
 * The listener speaks WebSocket frames; a punched connection carries bytes. The
 * translation is one message per frame, which is what the phone's own transport
 * does in the other direction (`P2PWebSocketTransport`).
 */
export class StreamChannel implements MizarChannelLike {
  private readonly stream: StreamLike
  private readonly messageListeners: Array<(data: Buffer, isBinary: boolean) => void> = []
  private readonly closeListeners: Array<() => void> = []
  private pumping = false
  private finished = false

  constructor(stream: StreamLike) {
    this.stream = stream
  }

  get open(): boolean {
    return !this.finished
  }

  onMessage(listener: (data: Buffer, isBinary: boolean) => void): void {
    this.messageListeners.push(listener)
    void this.pump()
  }

  onClose(listener: () => void): void {
    this.closeListeners.push(listener)
  }

  send(text: string): void {
    if (this.finished) return
    void this.stream.send(Buffer.from(text, 'utf8')).catch(() => this.finish())
  }

  close(_code?: number, reason?: string): void {
    if (this.finished) return
    void this.stream.close(reason).catch(() => undefined)
    this.finish()
  }

  private async pump(): Promise<void> {
    // One reader per channel: two would split frames by timing.
    if (this.pumping) return
    this.pumping = true
    while (!this.finished) {
      const message = await this.stream.receive().catch(() => null)
      if (message === null) {
        this.finish()
        return
      }
      for (const listener of this.messageListeners) {
        try {
          listener(message, false)
        } catch {
          // A handler that throws is a bug in the handler; the channel stays up
          // so the next frame still gets its chance.
        }
      }
    }
  }

  private finish(): void {
    if (this.finished) return
    this.finished = true
    for (const listener of this.closeListeners) listener()
  }
}

/**
 * A WebSocket, wearing the shape a signaling channel needs.
 *
 * The listener owns the upgrade; this only translates. Text in, text out — the
 * signal vocabulary is JSON and nothing here parses it.
 *
 * @param socket - the accepted socket.
 * @returns the channel.
 */
export function adaptSignalSocket(socket: WebSocket): SignalChannelLike {
  return {
    send: (text) => {
      if (socket.readyState === socket.OPEN) socket.send(text)
    },
    onMessage: (listener) =>
      socket.on('message', (data) => listener(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))),
    onClose: (listener) => {
      socket.on('close', listener)
      socket.on('error', listener)
    },
    close: (code, reason) => socket.close(code, reason),
  }
}

/**
 * A digest of a tunnel secret, for logs.
 *
 * Prints eight characters of a SHA-256 — enough to tell two installs apart in a
 * support conversation, useless for impersonating one.
 *
 * @param tunnelSecret - the raw secret.
 * @returns the short form.
 */
export function shortSecret(tunnelSecret: string): string {
  return createHash('sha256').update(tunnelSecret).digest('hex').slice(0, 8)
}
