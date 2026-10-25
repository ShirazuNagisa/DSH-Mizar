/**
 * The engine: one socket, every session, and the punch that starts them.
 *
 * This is the desktop half of the direct path, and it mirrors the Swift
 * engine's decisions rather than its code — the two have to agree on behaviour
 * because they punch at each other:
 *
 *  - a dial adopts a session that already exists instead of punching over it;
 *  - both sides punch (the acceptor answers signaling by sending its own
 *    hello), because a restricted filter only lets a peer in after it has sent
 *    to that peer first;
 *  - a simultaneous open leaves two sessions, and the one with the smaller
 *    connection id wins — a rule both sides compute identically, with no
 *    negotiation;
 *  - a punch loop never reports a timeout while a session to that endpoint
 *    exists, because a connection that is up is not a failure.
 *
 * What it deliberately does not do: choose a fallback path. A path that
 * degrades is reported, and the layer holding the pairing decides what happens
 * next. Two components that both route will eventually disagree.
 *
 * @module dsh-mizar/transport/p2p/engine
 */

import { randomBytes, type KeyObject } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { candidate, CandidateKind, punchAddresses, sortedByPriority, type Candidate } from './candidate.js'
import { deriveIdentity, ephemeralKeyPair, verifySignature, type EndpointIdentity } from './crypto.js'
import { STANDARD_POLICY, type Policy } from './policy.js'
import { Session, type Health, type Stream } from './session.js'
import { DatagramSocket, type Address, type Datagram } from './socket.js'
import {
  bindingRequest,
  looksLikeSTUN,
  parseBindingResponse,
  randomTransactionId,
  transactionId,
} from './stun.js'
import {
  encodeHello,
  handshakeMessage,
  PacketType,
  parseHeader,
  parseHello,
} from './wire.js'

/** A failure the engine reports instead of a stream. */
export class P2PError extends Error {
  /** The Mizar error code the app layer sees. */
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'P2PError'
    this.code = code
  }
}

/** Who to dial. */
export interface Ticket {
  /** The far endpoint's id — the base64url Ed25519 public key. */
  readonly endpointId: string
  /** `ip:port` hints from the ticket, tried alongside the peer's candidates. */
  readonly direct?: readonly string[]
}

/** A dial in progress. */
interface ActiveDial {
  /** `dialer`: somebody is waiting on the result. `acceptorPunch`: a filter opener. */
  readonly kind: 'dialer' | 'acceptorPunch'
  readonly connectionId: bigint
  readonly remoteEndpointId: string
  /** Our ephemeral key for this attempt, kept so the session can be built the moment a hello answers. */
  readonly ephemeral: KeyObject
  readonly remote: readonly Address[]
  readonly deadline: number
  /** The hello, built once — every round sends the same bytes. */
  readonly hello: Buffer
}

/** How a dial ended. */
interface DialOutcome {
  readonly stream?: Stream
  readonly error?: P2PError
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, milliseconds))
  })

/** The engine. */
export class Engine {
  /** This endpoint's identity. */
  readonly identity: EndpointIdentity

  private readonly policy: Policy
  private readonly stunServers: readonly string[]

  private socket: DatagramSocket
  private hostCandidates: Candidate[] = []
  private readonly reflexiveCandidates: Candidate[] = []
  private readonly offered: Candidate[] = []

  private readonly sessions = new Map<string, Session>()
  private readonly sessionOrder: bigint[] = []
  private activeDial?: ActiveDial
  private readonly dialOutcomes = new Map<string, DialOutcome>()
  private readonly commitTimers = new Map<string, NodeJS.Timeout>()
  private readonly yielded = new Set<string>()
  private acceptorPunchStarted = false
  private intent: 'dial' | 'accept' | null = null

  private readonly incomingQueue: Stream[] = []
  private readonly incomingWaiters: Array<{ resolve: (stream: Stream) => void; reject: (error: Error) => void }> = []

  private readonly stunPending = new Map<string, string>()
  private readonly stunResults = new Map<string, Address>()

  private closed = false
  private receiveLoop?: Promise<void>

  private constructor(identity: EndpointIdentity, policy: Policy, stunServers: readonly string[], socket: DatagramSocket) {
    this.identity = identity
    this.policy = policy
    this.stunServers = stunServers
    this.socket = socket
  }

  /**
   * Start an engine: bind a socket, learn its addresses, ask STUN what it looks
   * like from outside.
   *
   * @param options - identity, policy, the STUN servers to ask (`host:port`).
   *   An empty list means host candidates only — the LAN case, and what a test
   *   that deliberately wants no outside help passes.
   * @returns the started engine.
   */
  static async create(options: {
    identity: EndpointIdentity
    policy?: Policy
    stunServers?: readonly string[]
    socket?: DatagramSocket
  }): Promise<Engine> {
    const policy = options.policy ?? STANDARD_POLICY
    const socket = options.socket ?? (await DatagramSocket.bind(0))
    const engine = new Engine(options.identity, policy, options.stunServers ?? [], socket)
    engine.hostCandidates = DatagramSocket.hostAddresses().map((address) =>
      candidate(CandidateKind.Host, address, socket.localPort),
    )
    engine.receiveLoop = engine.runReceiveLoop()
    await engine.gatherReflexiveCandidates()
    return engine
  }

  /** The UDP port this engine is bound to — what a ticket or a test dials. */
  get port(): number {
    return this.socket.localPort
  }

  /** The candidates this endpoint can offer a peer. */
  localCandidates(): Candidate[] {
    return sortedByPriority([...this.hostCandidates, ...this.reflexiveCandidates])
  }

  /**
   * Candidates the peer announced over signaling.
   *
   * On the side being dialled this is also the moment to punch back: the
   * dialer's first hello is already on its way, and a restricted filter will
   * only let it in if this side has sent to that address first.
   *
   * @param candidates - what the peer offered.
   */
  offerCandidates(candidates: readonly Candidate[]): void {
    for (const entry of candidates) {
      if (this.offered.length >= 32) break
      if (!this.offered.some((existing) => sameCandidate(existing, entry))) this.offered.push(entry)
    }
    this.startAcceptorPunchIfNeeded()
  }

  /**
   * Say what this engine is for.
   *
   * An engine that has not been told does not punch back: an acceptor punch is
   * a filter opener, and punching on a side that is itself dialling would race
   * its own dial.
   *
   * @param intent - dialling or waiting to be dialled.
   */
  noteIntent(intent: 'dial' | 'accept'): void {
    this.intent = intent
  }

  /**
   * Dial a peer.
   * @param ticket - who to dial, plus any direct hints.
   * @param timeoutMs - the budget; defaults to the policy's.
   * @returns the connected stream.
   */
  async dial(ticket: Ticket, timeoutMs?: number): Promise<Stream> {
    if (this.closed) throw new P2PError('P2P_NOT_STARTED', 'the engine is closed')
    const deadline = Date.now() + (timeoutMs ?? this.policy.punchBudgetMs)

    // The far side's punch may already have arrived — it is sent the moment
    // signaling hands it our candidates. That session *is* the connection.
    const already = this.adoptExistingSession(ticket.endpointId)
    if (already !== null) return already

    // Candidates travel over signaling, so the list can legitimately be empty
    // for a few milliseconds after the app decided to dial.
    let remote = punchAddresses(this.offered, ticket.direct ?? [])
    if (remote.length === 0) {
      const graceEnd = Math.min(deadline, Date.now() + this.policy.candidateGraceMs)
      while (remote.length === 0 && Date.now() < graceEnd) {
        await sleep(20)
        remote = punchAddresses(this.offered, ticket.direct ?? [])
      }
    }
    if (remote.length === 0) throw new P2PError('P2P_FAILED', 'no candidate addresses to dial')

    const connectionId = randomConnectionId()
    const ephemeral = ephemeralKeyPair()
    const hello = this.buildHello(connectionId, ephemeral.publicKey)
    this.activeDial = {
      kind: 'dialer',
      connectionId,
      remoteEndpointId: ticket.endpointId,
      ephemeral: ephemeral.privateKey,
      remote,
      deadline,
      hello,
    }
    void this.punch(connectionId)
    try {
      while (Date.now() < deadline) {
        const session = this.adoptExistingSession(ticket.endpointId)
        if (session !== null) return session
        const outcome = this.takeOutcome(connectionId)
        if (outcome !== null) return unwrap(outcome)
        await sleep(20)
      }
      const session = this.adoptExistingSession(ticket.endpointId)
      if (session !== null) return session
      const outcome = this.takeOutcome(connectionId)
      if (outcome !== null) return unwrap(outcome)
      throw new P2PError('P2P_TIMEOUT', 'the dial budget ran out')
    } finally {
      this.cleanupDial(connectionId)
    }
  }

  /**
   * Wait for a peer to dial this endpoint.
   * @returns the stream the peer dialled in on.
   */
  accept(): Promise<Stream> {
    if (this.closed) return Promise.reject(new P2PError('P2P_NOT_STARTED', 'the engine is closed'))
    this.intent = 'accept'
    const queued = this.incomingQueue.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise<Stream>((resolve, reject) => this.incomingWaiters.push({ resolve, reject }))
  }

  /** The engine's read on its path. */
  health(): Health {
    const last = this.sessionOrder[this.sessionOrder.length - 1]
    if (last === undefined) return { state: 'unknown' }
    const session = this.sessions.get(last.toString())
    return session?.health() ?? { state: 'unknown' }
  }

  /** Close the engine: every session, then the socket. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const timer of this.commitTimers.values()) clearInterval(timer)
    this.commitTimers.clear()
    for (const session of [...this.sessions.values()]) await session.close('the engine shut down')
    this.sessions.clear()
    this.sessionOrder.length = 0
    for (const waiter of this.incomingWaiters.splice(0)) {
      waiter.reject(new P2PError('SOCKET_CLOSED', 'the engine shut down'))
    }
    await this.socket.close()
    await this.receiveLoop
  }

  // MARK: - Receive

  private async runReceiveLoop(): Promise<void> {
    for await (const datagram of this.socket.events()) {
      if (this.closed) return
      try {
        this.handleDatagram(datagram)
      } catch {
        // One malformed or hostile datagram must not end the loop that every
        // session depends on. The packet is dropped, the engine keeps going.
      }
    }
  }

  private handleDatagram(datagram: Datagram): void {
    if (looksLikeSTUN(datagram.data)) {
      this.handleSTUNResponse(datagram.data)
      return
    }
    const header = parseHeader(datagram.data)
    if (header === null) return
    switch (header.type) {
      case PacketType.ClientHello:
        this.handleClientHello(datagram, header.connectionId)
        break
      case PacketType.ServerHello:
        this.handleServerHello(datagram, header.connectionId)
        break
      default:
        this.sessions.get(header.connectionId.toString())?.receiveDatagram(datagram.data)
        break
    }
  }

  /**
   * A peer dialled us.
   *
   * The signature is the whole admission check: it proves the sender holds the
   * private half of the endpoint id it claims, which is the trust the pairing
   * established. There is no allow-list, because the session key is bound to
   * *these two* endpoint ids and the Mizar protocol's own device check runs on
   * top of it anyway.
   */
  private handleClientHello(datagram: Datagram, connectionId: bigint): void {
    const parsed = parseHello(datagram.data)
    if (parsed === null || parsed.header.type !== PacketType.ClientHello) return
    const handshake = parsed.handshake
    const message = handshakeMessage(PacketType.ClientHello, connectionId, handshake.ephemeralPublicKey, handshake.endpointId)
    if (!verifySignature(handshake.signature, message, handshake.endpointId)) return

    // A retransmitted hello for a session we already have: answer it again so
    // the dialer completes even though the first answer was lost.
    const existing = this.sessions.get(connectionId.toString())
    if (existing !== undefined) {
      void this.answerHello(connectionId, datagram.from, existing.localEphemeralPublicKey)
      return
    }

    const session = new Session({
      role: 'acceptor',
      connectionId,
      remote: datagram.from,
      remoteEndpointId: handshake.endpointId,
      localEphemeral: ephemeralKeyPair().privateKey,
      remoteEphemeralPublicKey: handshake.ephemeralPublicKey,
      localEndpointId: this.identity.endpointId,
      socket: this.socket,
      policy: this.policy,
      fromOwnPunch: false,
      onClose: (id) => this.removeSession(id),
    })
    this.sessions.set(connectionId.toString(), session)
    this.sessionOrder.push(connectionId)
    // Registered before anything can await: a commit is a promise that this
    // session is on its way to a caller, and the punch loop reads that promise
    // to know it must not declare a timeout.
    this.scheduleCommit(handshake.endpointId)
    session.activate()
    void this.answerHello(connectionId, datagram.from, session.localEphemeralPublicKey)
  }

  /** The far end answered our hello. */
  private handleServerHello(datagram: Datagram, connectionId: bigint): void {
    const dial = this.activeDial
    if (dial === undefined || dial.connectionId !== connectionId) return
    const parsed = parseHello(datagram.data)
    if (parsed === null || parsed.header.type !== PacketType.ServerHello) return
    const handshake = parsed.handshake
    const message = handshakeMessage(PacketType.ServerHello, connectionId, handshake.ephemeralPublicKey, handshake.endpointId)
    if (!verifySignature(handshake.signature, message, handshake.endpointId)) {
      this.dialOutcomes.set(connectionId.toString(), {
        error: new P2PError('P2P_FAILED', "the far signature did not verify"),
      })
      return
    }

    const session = new Session({
      role: 'dialer',
      connectionId,
      remote: datagram.from,
      remoteEndpointId: handshake.endpointId,
      localEphemeral: dial.ephemeral,
      remoteEphemeralPublicKey: handshake.ephemeralPublicKey,
      localEndpointId: this.identity.endpointId,
      socket: this.socket,
      policy: this.policy,
      fromOwnPunch: true,
      onClose: (id) => this.removeSession(id),
    })
    this.sessions.set(connectionId.toString(), session)
    this.sessionOrder.push(connectionId)
    this.scheduleCommit(handshake.endpointId)
    session.activate()
  }

  // MARK: - Commit

  /**
   * Route an endpoint's surviving session to whoever is waiting for it.
   *
   * The wait ends the moment both kinds of session exist — the common case,
   * costing milliseconds — or when the grace expires. The symmetric-acceptor
   * case arrives through the same door: only the punch-back session exists,
   * the grace expires, and it becomes the connection.
   */
  private scheduleCommit(endpointId: string): void {
    if (this.commitTimers.has(endpointId)) return
    const deadline = Date.now() + this.policy.punchAnswerGraceMs
    const tick = (): void => {
      if (this.closed) {
        this.clearCommit(endpointId)
        return
      }
      if (this.hasBothKinds(endpointId) || Date.now() >= deadline) {
        this.clearCommit(endpointId)
        this.commit(endpointId)
      }
    }
    const timer = setInterval(tick, 10)
    timer.unref?.()
    this.commitTimers.set(endpointId, timer)
  }

  private clearCommit(endpointId: string): void {
    const timer = this.commitTimers.get(endpointId)
    if (timer !== undefined) clearInterval(timer)
    this.commitTimers.delete(endpointId)
  }

  private hasBothKinds(endpointId: string): boolean {
    const toThisEndpoint = this.sessionsTo(endpointId)
    return toThisEndpoint.some((session) => session.fromOwnPunch) && toThisEndpoint.some((session) => !session.fromOwnPunch)
  }

  private commit(endpointId: string): void {
    const keeper = this.reconcile(endpointId)
    if (keeper === undefined) return
    const dial = this.activeDial
    if (dial?.kind === 'dialer' && dial.remoteEndpointId === endpointId) {
      this.dialOutcomes.set(dial.connectionId.toString(), { stream: keeper })
    } else if (this.intent !== 'dial' && !this.yielded.has(endpointId)) {
      // One stream per endpoint: a second accept() must wait for a second
      // connection, not receive a duplicate of this one.
      this.yielded.add(endpointId)
      this.deliverIncoming(keeper)
    }
    // A side that is dialling — or has not decided yet — keeps the session
    // where it is. `dial` adopts it; handing it to the incoming queue would
    // put it in a queue nobody on a dialler reads.
  }

  /**
   * One session per endpoint: the smaller connection id wins.
   *
   * Both sides of a simultaneous open hold the same two connection ids — each
   * side's own punch and the hello it received — so both close the same loser
   * without a word between them.
   */
  private reconcile(endpointId: string): Session | undefined {
    const toThisEndpoint = this.sessionsTo(endpointId)
    if (toThisEndpoint.length === 0) return undefined
    const keeper = toThisEndpoint.reduce((best, current) =>
      current.connectionId < best.connectionId ? current : best,
    )
    for (const session of toThisEndpoint) {
      if (session.connectionId === keeper.connectionId) continue
      void session.close('a simultaneous open kept the other session')
    }
    return keeper
  }

  private adoptExistingSession(endpointId: string): Session | null {
    if (this.sessionsTo(endpointId).length === 0) return null
    return this.reconcile(endpointId) ?? null
  }

  private sessionsTo(endpointId: string): Session[] {
    return [...this.sessions.values()].filter((session) => session.remoteEndpointId === endpointId)
  }

  private deliverIncoming(stream: Stream): void {
    const waiter = this.incomingWaiters.shift()
    if (waiter !== undefined) waiter.resolve(stream)
    else this.incomingQueue.push(stream)
  }

  // MARK: - Punching

  private startAcceptorPunchIfNeeded(): void {
    if (this.intent === 'dial') return
    if (this.acceptorPunchStarted || this.activeDial !== undefined) return
    if (this.sessions.size > 0 || this.offered.length === 0) return
    const remote = punchAddresses(this.offered, [])
    if (remote.length === 0) return
    this.acceptorPunchStarted = true
    const connectionId = randomConnectionId()
    const ephemeral = ephemeralKeyPair()
    const hello = this.buildHello(connectionId, ephemeral.publicKey)
    this.activeDial = {
      kind: 'acceptorPunch',
      connectionId,
      remoteEndpointId: '',
      ephemeral: ephemeral.privateKey,
      remote,
      deadline: Date.now() + this.policy.acceptorPunchWindowMs,
      hello,
    }
    void this.punch(connectionId)
  }

  /**
   * Send the hello to every candidate, several times.
   *
   * Rounds rather than a shared clock: two peers that started dialling
   * milliseconds apart are absorbed by repetition, and neither needs to know
   * when the other began.
   */
  private async punch(connectionId: bigint): Promise<void> {
    const dial = this.activeDial
    if (dial === undefined || dial.connectionId !== connectionId) return
    let round = 0
    while (round < this.policy.punchRounds && Date.now() < dial.deadline) {
      const done =
        dial.kind === 'acceptorPunch' ? this.sessions.size > 0 : this.sessionsTo(dial.remoteEndpointId).length > 0
      if (done) break
      for (const address of dial.remote) {
        try {
          await this.socket.send(dial.hello, address)
        } catch {
          // An unreachable candidate is not a failed punch: the other
          // candidates are still in the list for a reason.
        }
      }
      round += 1
      const pause = Math.min(this.policy.punchIntervalMs, dial.deadline - Date.now())
      if (pause > 0) await sleep(pause)
    }

    // Only the loop that still owns the dial may fail it, and never while a
    // session to that endpoint — or a commit still choosing between two —
    // exists. Writing a timeout there would beat the commit to the dial and
    // turn a connection that is already up into a reported failure.
    if (this.activeDial?.connectionId !== connectionId) return
    if (this.dialOutcomes.has(connectionId.toString())) return
    if (this.commitTimers.has(dial.remoteEndpointId)) return
    if (dial.kind === 'acceptorPunch') {
      // Nobody dialled in through our punch. The flag is released so a later
      // hello over signaling can start a fresh attempt.
      this.acceptorPunchStarted = false
      this.cleanupDial(connectionId)
      return
    }
    if (this.sessionsTo(dial.remoteEndpointId).length > 0) return
    this.dialOutcomes.set(connectionId.toString(), {
      error: new P2PError('P2P_TIMEOUT', 'the punch found no answering peer'),
    })
  }

  private buildHello(connectionId: bigint, ephemeralPublicKey: Buffer): Buffer {
    const message = handshakeMessage(PacketType.ClientHello, connectionId, ephemeralPublicKey, this.identity.endpointId)
    return encodeHello(
      PacketType.ClientHello,
      connectionId,
      this.identity.endpointId,
      ephemeralPublicKey,
      this.identity.sign(message),
    )
  }

  private async answerHello(connectionId: bigint, to: Address, ephemeralPublicKey: Buffer): Promise<void> {
    const message = handshakeMessage(PacketType.ServerHello, connectionId, ephemeralPublicKey, this.identity.endpointId)
    const packet = encodeHello(
      PacketType.ServerHello,
      connectionId,
      this.identity.endpointId,
      ephemeralPublicKey,
      this.identity.sign(message),
    )
    try {
      await this.socket.send(packet, to)
    } catch {
      // The dialer retransmits its hello; this answer gets another chance.
    }
  }

  private cleanupDial(connectionId: bigint): void {
    if (this.activeDial?.connectionId === connectionId) this.activeDial = undefined
    this.dialOutcomes.delete(connectionId.toString())
  }

  private takeOutcome(connectionId: bigint): DialOutcome | null {
    const key = connectionId.toString()
    const outcome = this.dialOutcomes.get(key)
    if (outcome === undefined) return null
    this.dialOutcomes.delete(key)
    return outcome
  }

  // MARK: - STUN

  private async gatherReflexiveCandidates(): Promise<void> {
    const deadline = Date.now() + this.policy.stunBudgetMs
    for (const server of this.stunServers) {
      if (Date.now() >= deadline) continue
      this.stunResults.delete(server)
      const resolved = await resolveHostPort(server)
      if (resolved === null) continue
      const id = randomTransactionId()
      this.stunPending.set(id.toString('hex'), server)
      try {
        await this.socket.send(bindingRequest(id), resolved)
      } catch {
        this.stunPending.delete(id.toString('hex'))
        continue
      }
      while (!this.stunResults.has(server) && Date.now() < deadline) await sleep(20)
      const mapped = this.stunResults.get(server)
      this.stunResults.delete(server)
      if (mapped === undefined) continue
      const entry = candidate(CandidateKind.ServerReflexive, mapped.address, mapped.port)
      if (!this.reflexiveCandidates.some((existing) => sameCandidate(existing, entry))) {
        this.reflexiveCandidates.push(entry)
      }
    }
  }

  private handleSTUNResponse(data: Buffer): void {
    const key = transactionId(data).toString('hex')
    const server = this.stunPending.get(key)
    if (server === undefined) return
    this.stunPending.delete(key)
    const mapped = parseBindingResponse(data, transactionId(data))
    if (mapped === null) return
    this.stunResults.set(server, { address: mapped.ip, port: mapped.port })
  }

  // MARK: - Sessions

  private removeSession(connectionId: bigint): void {
    this.sessions.delete(connectionId.toString())
    const index = this.sessionOrder.findIndex((entry) => entry === connectionId)
    if (index >= 0) this.sessionOrder.splice(index, 1)
  }
}

/**
 * A fresh 64-bit connection id.
 * @returns the id, as a bigint because it does not fit a number.
 */
function randomConnectionId(): bigint {
  return randomBytes(8).readBigUInt64BE(0)
}

/**
 * Whether two candidates name the same address.
 * @param left - one candidate.
 * @param right - the other.
 * @returns whether they are the same place.
 */
function sameCandidate(left: Candidate, right: Candidate): boolean {
  return left.address === right.address && left.port === right.port
}

/**
 * Turn a dial outcome into a value or a throw.
 * @param outcome - the outcome to unwrap.
 * @returns the stream.
 */
function unwrap(outcome: DialOutcome): Stream {
  if (outcome.error !== undefined) throw outcome.error
  if (outcome.stream !== undefined) return outcome.stream
  throw new P2PError('P2P_FAILED', 'the dial ended without a stream')
}

/**
 * Resolve `host:port`, falling back to the literal when it is already an IP.
 * @param text - the `host:port` string.
 * @returns the address, or `null` when it cannot be resolved.
 */
async function resolveHostPort(text: string): Promise<Address | null> {
  const separator = text.lastIndexOf(':')
  if (separator <= 0) return null
  const port = Number(text.slice(separator + 1))
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  const host = text.slice(0, separator)
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return { address: host, port }
  try {
    const result = await lookup(host, { family: 4 })
    return { address: result.address, port }
  } catch {
    return null
  }
}

/** The identity a desktop derives from its host secret. */
export function hostIdentity(hostSecret: Buffer): EndpointIdentity {
  return deriveIdentity(hostSecret, 'host')
}

/** The identity a phone derives from its device token. */
export function deviceIdentity(deviceTokenDigest: Buffer): EndpointIdentity {
  return deriveIdentity(deviceTokenDigest, 'device')
}
