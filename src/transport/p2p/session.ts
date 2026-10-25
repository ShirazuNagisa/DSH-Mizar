/**
 * One session: a reliable, ordered, message-preserving channel over the shared
 * UDP socket.
 *
 * The same contract the Swift session implements, because the two have to
 * interoperate:
 *
 *  - a message is chunked to fit a datagram, and the chunks carry no offset —
 *    the receiver reassembles them in *packet number* order, which is why the
 *    sender must number them in the order it sends them;
 *  - the sender keeps the sealed bytes until an ack arrives and retransmits on
 *    a doubling timer;
 *  - the receiver acks what it delivers, buffers what arrives early (64
 *    packets) and reassembles messages from their chunks;
 *  - keepalives keep a NAT mapping warm, and silence beyond three of them is
 *    reported as degraded rather than written into a hole.
 *
 * No congestion control, on purpose: the traffic is request/response JSON at
 * human speeds, and a window would add failure modes without adding throughput
 * that matters.
 *
 * @module dsh-mizar/transport/p2p/session
 */

import { createPublicKey, type KeyObject } from 'node:crypto'
import { agree, open, seal, sessionKeys, sessionSalt, type SessionKeys } from './crypto.js'
import type { Policy } from './policy.js'
import type { Address, DatagramSocket } from './socket.js'
import {
  encodeAck,
  encodeClose,
  encodeData,
  encodeHeader,
  encodeKeepalive,
  MAX_ACKS_PER_PACKET,
  PacketType,
  parseAck,
  parseClose,
  parseData,
  parseHeader,
} from './wire.js'

/** Which side of the handshake a session was built from. Decides key direction. */
export type SessionRole = 'dialer' | 'acceptor'

/** Which kind of path a stream is carried on. */
export type PathKind = 'lan' | 'p2p' | 'relay'

/** The engine's read on a path. */
export type Health =
  | { readonly state: 'unknown' }
  | { readonly state: 'healthy'; readonly rttMilliseconds: number }
  | { readonly state: 'degraded'; readonly rttMilliseconds: number; readonly lossPercent: number }

/** A reliable, ordered, bidirectional message stream. */
export interface Stream {
  readonly pathKind: PathKind
  readonly connectionId: bigint
  readonly remoteEndpointId: string
  /**
   * Send one message.
   * @param data - the message.
   */
  send(data: Buffer): Promise<void>
  /**
   * Await the next message.
   * @returns the message, or `null` when the peer closed the session.
   */
  receive(): Promise<Buffer | null>
  /** Close the session, telling the peer. */
  close(reason?: string): Promise<void>
  /** The session's read on itself. */
  health(): Health
}

/** How long a session may hear nothing before it calls itself degraded. */
const IDLE_TIMEOUT_MS = 66_000

/** How many attempts a chunk gets before the session calls itself stalled. */
const MAX_ATTEMPTS = 8

/** How many unacked chunks a session carries before it calls itself stalled. */
const UNACKED_CAPACITY = 512

/** How many out-of-order chunks the receiver buffers. */
const REORDER_CAPACITY = 64

/** A chunk waiting for its ack. */
interface PendingPacket {
  readonly packet: Buffer
  sentAt: number
  attempts: number
}

/** A chunk that arrived before its turn. */
interface BufferedChunk {
  readonly messageLength: number
  readonly chunk: Buffer
}

/** One session on the engine's socket. */
export class Session implements Stream {
  readonly pathKind: PathKind = 'p2p'
  readonly connectionId: bigint
  readonly remoteEndpointId: string
  /** This side's ephemeral public key — what a ServerHello answers with. */
  readonly localEphemeralPublicKey: Buffer
  /**
   * Whether this session was started by a punch of ours rather than by a hello
   * we received. The engine's reconcile uses it, together with the connection
   * id, to pick the session a simultaneous open keeps.
   */
  readonly fromOwnPunch: boolean

  private readonly socket: DatagramSocket
  private readonly remote: Address
  private readonly keys: SessionKeys
  private readonly policy: Policy
  private readonly onClose: (connectionId: bigint) => void

  // Outgoing.
  private outgoingPacketNumber = 0
  private readonly unacked = new Map<number, PendingPacket>()

  // Incoming.
  private expectedPacketNumber = 0
  private readonly reorderBuffer = new Map<number, BufferedChunk>()
  private incomingChunks: Buffer[] = []
  private incomingLength = 0
  private incomingMessageLength: number | null = null

  // Acks.
  private readonly recentReceived: number[] = []
  private readonly receivedSet = new Set<number>()
  private ackDirty = false

  // Health.
  private smoothedRTT = 0
  private lastReceivedAt = Date.now()
  private idle = false
  private stalled = false

  // Delivery.
  private readonly queued: Buffer[] = []
  private readonly waiters: Array<(value: Buffer | null) => void> = []

  private closed = false
  private readonly timers: NodeJS.Timeout[] = []

  constructor(options: {
    role: SessionRole
    connectionId: bigint
    remote: Address
    remoteEndpointId: string
    localEphemeral: KeyObject
    remoteEphemeralPublicKey: Buffer
    localEndpointId: string
    socket: DatagramSocket
    policy: Policy
    fromOwnPunch: boolean
    onClose: (connectionId: bigint) => void
  }) {
    this.connectionId = options.connectionId
    this.remoteEndpointId = options.remoteEndpointId
    this.localEphemeralPublicKey = publicKeyOf(options.localEphemeral)
    this.fromOwnPunch = options.fromOwnPunch
    this.socket = options.socket
    this.policy = options.policy
    this.onClose = options.onClose
    this.remote = options.remote

    const sharedSecret = agree(options.localEphemeral, options.remoteEphemeralPublicKey)
    this.keys = sessionKeys(
      sharedSecret,
      sessionSalt(options.localEndpointId, options.remoteEndpointId),
      options.role === 'dialer',
    )
  }

  /** Start the timers. Called before anything can send or receive on it. */
  activate(): void {
    this.timers.push(setInterval(() => void this.flushAcksIfNeeded(), 25))
    this.timers.push(setInterval(() => void this.retransmitAndCheckIdle(), 100))
    this.timers.push(setInterval(() => void this.sendKeepalive(), this.policy.keepaliveIntervalMs))
    for (const timer of this.timers) timer.unref?.()
  }

  /**
   * Send one message.
   * @param data - the message; chunked to fit datagrams.
   */
  async send(data: Buffer): Promise<void> {
    if (this.closed) throw new Error('the stream is closed')
    if (data.length === 0) {
      await this.sendChunk(0, Buffer.alloc(0))
      return
    }
    let offset = 0
    while (offset < data.length) {
      const end = Math.min(offset + this.policy.streamChunkBytes, data.length)
      await this.sendChunk(data.length, data.subarray(offset, end))
      offset = end
    }
  }

  /**
   * Await the next message.
   * @returns the message, or `null` when the peer closed the session.
   */
  async receive(): Promise<Buffer | null> {
    const next = this.queued.shift()
    if (next !== undefined) return next
    if (this.closed) return null
    return new Promise<Buffer | null>((resolve) => this.waiters.push(resolve))
  }

  /**
   * One datagram from the engine's dispatch loop.
   *
   * The loop is sequential, which is what keeps packet order intact — and the
   * reassembly below depends on it.
   *
   * @param data - the datagram.
   */
  receiveDatagram(data: Buffer): void {
    if (this.closed) return
    this.lastReceivedAt = Date.now()
    this.idle = false
    const header = parseHeader(data)
    if (header === null) return
    switch (header.type) {
      case PacketType.Data:
        this.handleData(data)
        break
      case PacketType.Ack: {
        const parsed = parseAck(data)
        if (parsed !== null) this.processAcks(parsed.acks)
        break
      }
      case PacketType.Keepalive:
        break
      case PacketType.Close: {
        const reason = parseClose(data)?.reason ?? ''
        void this.closeInternal(`the peer closed the session: ${reason}`)
        break
      }
      default:
        // Handshakes belong to the engine; a session that sees one is hearing
        // a conversation it is not part of.
        break
    }
  }

  /** The session's read on itself. */
  health(): Health {
    const rtt = Math.round(this.smoothedRTT * 1000)
    if (this.closed || this.stalled || this.idle) return { state: 'degraded', rttMilliseconds: rtt, lossPercent: 100 }
    if (this.unacked.size > 8) return { state: 'degraded', rttMilliseconds: rtt, lossPercent: 50 }
    if (this.smoothedRTT <= 0) return { state: 'unknown' }
    return { state: 'healthy', rttMilliseconds: rtt }
  }

  /** Close the session, telling the peer. */
  async close(reason = 'closed locally'): Promise<void> {
    await this.closeInternal(reason)
  }

  // MARK: - Sending

  private async sendChunk(messageLength: number, chunk: Buffer): Promise<void> {
    const packetNumber = this.outgoingPacketNumber
    this.outgoingPacketNumber += 1

    const acks = this.piggybackedAcks()
    // The header's length field is inside the authenticated data, so the
    // layout is computed first and the seal happens against exactly the
    // header the wire will carry.
    const payloadLength = 4 + 1 + acks.length * 4 + 4 + chunk.length + 16
    const header = encodeHeader(PacketType.Data, this.connectionId, payloadLength)
    const authenticated = Buffer.alloc(8)
    authenticated.writeUInt32BE(packetNumber, 0)
    authenticated.writeUInt32BE(messageLength, 4)
    const sealed = seal(chunk, this.keys.seal, packetNumber, Buffer.concat([header, authenticated]))
    const packet = encodeData(this.connectionId, packetNumber, acks, messageLength, sealed)
    await this.socket.send(packet, this.remote)
    this.unacked.set(packetNumber, { packet, sentAt: Date.now(), attempts: 0 })
  }

  // MARK: - Receiving

  private handleData(data: Buffer): void {
    const packet = parseData(data)
    if (packet === null) return
    this.processAcks(packet.acks)
    const chunk = open(packet.sealed, this.keys.open, packet.packetNumber, packet.authenticatedData)
    if (chunk === null) return

    this.recordReceived(packet.packetNumber)
    if (packet.packetNumber === this.expectedPacketNumber) {
      this.acceptChunk(packet.messageLength, chunk)
      this.expectedPacketNumber += 1
      while (true) {
        const buffered = this.reorderBuffer.get(this.expectedPacketNumber)
        if (buffered === undefined) break
        this.reorderBuffer.delete(this.expectedPacketNumber)
        this.acceptChunk(buffered.messageLength, buffered.chunk)
        this.expectedPacketNumber += 1
      }
    } else if (packet.packetNumber > this.expectedPacketNumber && this.reorderBuffer.size < REORDER_CAPACITY) {
      this.reorderBuffer.set(packet.packetNumber, { messageLength: packet.messageLength, chunk })
    }
    // Below the expected number: already delivered, the sender has not seen
    // our ack yet. Recorded, so the ack goes out again.
  }

  private acceptChunk(messageLength: number, chunk: Buffer): void {
    if (this.incomingMessageLength === null) this.incomingMessageLength = messageLength
    this.incomingChunks.push(chunk)
    this.incomingLength += chunk.length
    const total = this.incomingMessageLength
    if (total === null || this.incomingLength < total) return
    const whole = Buffer.concat(this.incomingChunks)
    this.deliver(whole.subarray(0, total))
    const rest = whole.subarray(total)
    this.incomingChunks = rest.length > 0 ? [rest] : []
    this.incomingLength = rest.length
    this.incomingMessageLength = null
  }

  private deliver(message: Buffer): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(message)
    else this.queued.push(message)
  }

  private recordReceived(packetNumber: number): void {
    if (this.receivedSet.has(packetNumber)) return
    this.receivedSet.add(packetNumber)
    this.recentReceived.push(packetNumber)
    if (this.recentReceived.length > 64) {
      const dropped = this.recentReceived.shift()
      if (dropped !== undefined) this.receivedSet.delete(dropped)
    }
    this.ackDirty = true
  }

  /**
   * The acks to ride along on a data packet.
   *
   * Deliberately does *not* clear the dirty flag: if the packet carrying them
   * is lost, the standalone ack timer still owes the peer those numbers, and a
   * sender that never hears them retransmits until the session stalls.
   */
  private piggybackedAcks(): number[] {
    if (!this.ackDirty) return []
    return this.recentReceived.slice(-MAX_ACKS_PER_PACKET)
  }

  private processAcks(acks: readonly number[]): void {
    const now = Date.now()
    for (const packetNumber of acks) {
      const pending = this.unacked.get(packetNumber)
      if (pending === undefined) continue
      this.unacked.delete(packetNumber)
      const sample = (now - pending.sentAt) / 1000
      this.smoothedRTT = this.smoothedRTT === 0 ? sample : 0.875 * this.smoothedRTT + 0.125 * sample
    }
  }

  // MARK: - Timers

  private async flushAcksIfNeeded(): Promise<void> {
    if (this.closed || !this.ackDirty) return
    this.ackDirty = false
    const acks = this.recentReceived.slice(-MAX_ACKS_PER_PACKET)
    try {
      await this.socket.send(encodeAck(this.connectionId, acks), this.remote)
    } catch {
      // A failed ack is an ack the retransmit timer will make unnecessary
      // anyway: the sender resends, and the next ack opportunity is 25ms away.
    }
  }

  private async retransmitAndCheckIdle(): Promise<void> {
    if (this.closed) return
    const now = Date.now()
    if (now - this.lastReceivedAt > IDLE_TIMEOUT_MS) this.idle = true
    if (this.unacked.size > UNACKED_CAPACITY) this.stalled = true

    const expired = [...this.unacked.entries()]
      .filter(([, pending]) => now - pending.sentAt > rto(pending.attempts))
      .sort(([left], [right]) => left - right)
    for (const [packetNumber, pending] of expired) {
      if (pending.attempts >= MAX_ATTEMPTS) {
        this.stalled = true
        continue
      }
      try {
        await this.socket.send(pending.packet, this.remote)
      } catch {
        continue
      }
      this.unacked.set(packetNumber, { packet: pending.packet, sentAt: now, attempts: pending.attempts + 1 })
    }
  }

  private async sendKeepalive(): Promise<void> {
    if (this.closed) return
    try {
      await this.socket.send(encodeKeepalive(this.connectionId), this.remote)
    } catch {
      // Nothing to do: the retransmit timer and the health report both notice
      // a path that stopped working.
    }
  }

  private async closeInternal(reason: string): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers.length = 0
    try {
      await this.socket.send(encodeClose(this.connectionId, reason), this.remote)
    } catch {
      // The peer is going to notice the silence either way.
    }
    for (const waiter of this.waiters.splice(0)) waiter(null)
    this.queued.length = 0
    this.onClose(this.connectionId)
  }
}

/**
 * The retransmit timeout for the nth attempt: 300ms, doubling, capped at 2s.
 * The floor is above a Wi-Fi RTT, so a single loss never causes a retransmit.
 * @param attempts - how many times this chunk has been sent.
 * @returns the timeout in milliseconds.
 */
function rto(attempts: number): number {
  if (attempts <= 0) return 300
  return Math.min(300 * (1 << Math.min(attempts, 4)), 2000)
}

/**
 * Read the raw public key out of a private X25519 key.
 * @param key - the key object.
 * @returns the 32-byte public key.
 */
function publicKeyOf(key: KeyObject): Buffer {
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' })
  return Buffer.from(der).subarray(-32)
}
