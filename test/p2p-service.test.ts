/**
 * The desktop half of the direct path.
 *
 * Three things are worth pinning here, and they are the three that would fail
 * silently in production: the endpoint id must be the same one the phone
 * derives from the same secret (otherwise a dial goes to nobody), signaling must
 * survive junk (it is reachable by anyone holding the room), and a punched
 * stream must deliver whole frames (otherwise the protocol sees half a JSON
 * object and answers nothing).
 *
 * @module dsh-mizar/test/p2p-service
 */
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  deriveEndpointIdentity,
  P2PService,
  readCandidates,
  readSignalHello,
  StreamChannel,
  unroutable,
  type P2PEngineLike,
  type SignalChannelLike,
  type StreamLike,
} from '../src/net/p2p.js'
import { candidate, CandidateKind, type Candidate } from '../src/transport/p2p/candidate.js'
import { deriveIdentity } from '../src/transport/p2p/crypto.js'
import { Engine } from '../src/transport/p2p/engine.js'
import { STANDARD_POLICY } from '../src/transport/p2p/policy.js'

/** A p2p stream with something on the other end, for testing the adapter. */
class FakeStream implements StreamLike {
  readonly sent: Buffer[] = []
  closed = false
  closeCode: number | undefined
  private readonly inbound: Buffer[] = []
  private waiter: ((value: Buffer | null) => void) | null = null

  push(text: string): void {
    const data = Buffer.from(text, 'utf8')
    if (this.waiter !== null) {
      const waiter = this.waiter
      this.waiter = null
      waiter(data)
      return
    }
    this.inbound.push(data)
  }

  async receive(): Promise<Buffer | null> {
    const next = this.inbound.shift()
    if (next !== undefined) return next
    if (this.closed) return null
    return new Promise<Buffer | null>((resolve) => {
      this.waiter = resolve
    })
  }

  async send(data: Buffer): Promise<void> {
    this.sent.push(data)
  }

  async close(): Promise<void> {
    this.closed = true
    const waiter = this.waiter
    this.waiter = null
    waiter?.(null)
  }
}

/** A signal channel that records what it was sent. */
class FakeSignal implements SignalChannelLike {
  readonly sent: string[] = []
  closed = false
  private message: ((text: string) => void) | null = null
  private closeListener: (() => void) | null = null

  send(text: string): void {
    this.sent.push(text)
  }

  onMessage(listener: (text: string) => void): void {
    this.message = listener
  }

  onClose(listener: () => void): void {
    this.closeListener = listener
  }

  close(code?: number): void {
    this.closed = true
    this.closeCode = code
    this.closeListener?.()
  }

  deliver(text: string): void {
    this.message?.(text)
  }

  /** The messages sent so far, parsed. */
  messages(): Array<Record<string, unknown>> {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>)
  }
}

/** An engine stand-in that records what signaling told it. */
class StubEngine implements P2PEngineLike {
  readonly identity = deriveIdentity(randomBytes(32), 'host')
  readonly offered: string[] = []
  closed = false

  async accept(): Promise<never> {
    // Never resolves: the service's accept loop has nothing to accept in these
    // tests, which is exactly what a quiet network looks like.
    return new Promise<never>(() => undefined)
  }

  offerCandidates(candidates: readonly { address: string; port: number }[]): void {
    for (const entry of candidates) this.offered.push(`${entry.address}:${entry.port}`)
  }

  localCandidates(): Candidate[] {
    return [candidate(CandidateKind.Host, '10.0.0.5', 51000)]
  }

  async close(): Promise<void> {
    this.closed = true
  }
}

describe('the endpoint identity', () => {
  it('is derived from the tunnel secret, and stable', () => {
    const secret = randomBytes(32).toString('base64url')
    const first = deriveEndpointIdentity(secret)
    const second = deriveEndpointIdentity(secret)
    expect(first.endpointId).toBe(second.endpointId)
    expect(first.endpointId).toHaveLength(43)
    // The same derivation the phone does for its own key: purpose first, then
    // the secret. A different purpose is a different endpoint.
    expect(first.endpointId).toBe(deriveIdentity(Buffer.from(secret, 'base64url'), 'host').endpointId)
    expect(deriveEndpointIdentity(randomBytes(32).toString('base64url')).endpointId).not.toBe(first.endpointId)
  })
})

describe('candidates from the wire', () => {
  it('reads what the phone sends', () => {
    const parsed = readCandidates([
      { kind: 'host', address: '192.168.1.4', port: 5000, priority: 1 },
      { kind: 'serverReflexive', address: '203.0.113.9', port: 6000 },
    ])
    expect(parsed.map((entry) => `${entry.kind}:${entry.address}:${entry.port}`)).toEqual([
      'host:192.168.1.4:5000',
      'serverReflexive:203.0.113.9:6000',
    ])
  })

  it('drops junk instead of failing the connection', () => {
    // A signal channel is reachable by anyone holding the room; a malformed
    // candidate must cost that candidate and nothing else.
    expect(readCandidates(undefined)).toEqual([])
    expect(readCandidates('nope')).toEqual([])
    expect(
      readCandidates([
        null,
        { address: '', port: 1 },
        { address: 'x', port: 0 },
        { address: 'x', port: 70000 },
        { address: 'ok', port: 1234 },
      ]).map((entry) => entry.address),
    ).toEqual(['ok'])
  })
})

describe('signaling', () => {
  /** The token the stub store knows. */
  const admit = (token: string): boolean => token === 'device-token'

  /** Attach a channel and let the phone through the door. */
  const open = (service: P2PService, signal: FakeSignal): void => {
    service.attachSignal(signal, admit)
    signal.deliver(JSON.stringify({ v: 1, type: 'hello', token: 'device-token' }))
  }

  it('says nothing about this machine before the phone presents a token', () => {
    const engine = new StubEngine()
    const service = new P2PService(engine, () => undefined)
    const signal = new FakeSignal()

    service.attachSignal(signal, admit)

    // No endpoint id, no addresses, no STUN-reflexive candidate: the port is
    // reachable by anyone who can route to it, and none of that is theirs yet.
    expect(signal.sent).toEqual([])
  })

  it('closes a channel whose first frame is not a hello', () => {
    const engine = new StubEngine()
    const service = new P2PService(engine, () => undefined)
    const signal = new FakeSignal()
    service.attachSignal(signal, admit)

    signal.deliver(
      JSON.stringify({ v: 1, type: 'candidates', candidates: [{ address: '198.51.100.9', port: 1234 }] }),
    )

    expect(signal.closed).toBe(true)
    expect(signal.closeCode).toBe(4401)
    expect(engine.offered).toEqual([])
  })

  it('closes a channel whose token is not one of ours', () => {
    const engine = new StubEngine()
    const service = new P2PService(engine, () => undefined)
    const signal = new FakeSignal()
    service.attachSignal(signal, admit)

    signal.deliver(JSON.stringify({ v: 1, type: 'hello', token: 'someone-else' }))

    expect(signal.closed).toBe(true)
    expect(signal.sent).toEqual([])
  })

  it('says hello with its own candidates once admitted', () => {
    const engine = new StubEngine()
    const service = new P2PService(engine, () => undefined)
    const signal = new FakeSignal()
    open(service, signal)

    const hello = signal.messages()[0]
    expect(hello?.['v']).toBe(1)
    expect(hello?.['type']).toBe('hello')
    expect(hello?.['endpointId']).toBe(engine.identity.endpointId)
    // Priority is (type preference << 24) + 1 here: host is 126, and nothing
    // else in the formula is set for a plain host candidate.
    expect(hello?.['candidates']).toEqual([
      { kind: 'host', address: '10.0.0.5', port: 51000, priority: 2113929217 },
    ])
  })

  it('feeds the peer candidates to the engine and answers with its own', () => {
    const engine = new StubEngine()
    const service = new P2PService(engine, () => undefined)
    const signal = new FakeSignal()
    open(service, signal)

    signal.deliver(
      JSON.stringify({
        v: 1,
        type: 'candidates',
        candidates: [{ kind: 'serverReflexive', address: '198.51.100.7', port: 40000 }],
      }),
    )

    expect(engine.offered).toEqual(['198.51.100.7:40000'])
    const answer = signal.messages().at(-1)
    expect(answer?.['type']).toBe('candidates')
    expect(answer?.['candidates']).toEqual([
      { kind: 'host', address: '10.0.0.5', port: 51000, priority: 2113929217 },
    ])
  })

  it('refuses to aim at loopback, at our own address, or at multicast', () => {
    const engine = new StubEngine()
    const service = new P2PService(engine, () => undefined)
    const signal = new FakeSignal()
    open(service, signal)

    signal.deliver(
      JSON.stringify({
        v: 1,
        type: 'candidates',
        candidates: [
          { kind: 'host', address: '127.0.0.1', port: 53315 },
          { kind: 'host', address: '10.0.0.5', port: 51000 },
          { kind: 'host', address: '224.0.0.1', port: 1900 },
          { kind: 'host', address: '10.0.0.9', port: 42000 },
        ],
      }),
    )

    // The LAN candidate survives: a phone on the same network is the point.
    expect(engine.offered).toEqual(['10.0.0.9:42000'])
  })

  it('closes a channel that keeps signalling past its budget', () => {
    const engine = new StubEngine()
    const service = new P2PService(engine, () => undefined)
    const signal = new FakeSignal()
    open(service, signal)

    const burst = JSON.stringify({
      v: 1,
      type: 'candidates',
      candidates: [{ kind: 'host', address: '198.51.100.7', port: 40000 }],
    })
    for (let index = 0; index < 20; index += 1) signal.deliver(burst)

    expect(signal.closed).toBe(true)
    expect(signal.closeCode).toBe(4408)
    // Bounded: the channel spent its window and stopped, rather than the engine
    // punching on every message.
    expect(engine.offered.length).toBeLessThan(20)
  })

  it('ignores junk, the wrong version and unknown types', () => {
    const engine = new StubEngine()
    const service = new P2PService(engine, () => undefined)
    const signal = new FakeSignal()
    open(service, signal)

    signal.deliver('not json')
    signal.deliver(JSON.stringify({ v: 2, type: 'hello', candidates: [{ address: 'a', port: 1 }] }))
    signal.deliver(JSON.stringify({ v: 1, type: 'bye', reason: 'later' }))
    signal.deliver(JSON.stringify({ v: 1, type: 'candidates', candidates: [] }))

    expect(engine.offered).toEqual([])
    // Only the admission hello was sent: nothing above deserved an answer.
    expect(signal.sent).toHaveLength(1)
  })
})

describe('what a signal hello may say', () => {
  it('takes a token and nothing else as an introduction', () => {
    expect(readSignalHello(JSON.stringify({ v: 1, type: 'hello', token: 'abc' }))).toBe('abc')
    expect(readSignalHello(JSON.stringify({ v: 1, type: 'hello', token: '' }))).toBeNull()
    expect(readSignalHello(JSON.stringify({ v: 1, type: 'hello' }))).toBeNull()
    expect(readSignalHello(JSON.stringify({ v: 2, type: 'hello', token: 'abc' }))).toBeNull()
    expect(readSignalHello(JSON.stringify({ v: 1, type: 'candidates', token: 'abc' }))).toBeNull()
    expect(readSignalHello('nope')).toBeNull()
  })
})

describe('addresses not worth a packet', () => {
  it('refuses the ones that are never a phone behind a NAT', () => {
    expect(unroutable('127.0.0.1')).toBe(true)
    expect(unroutable('0.0.0.0')).toBe(true)
    expect(unroutable('255.255.255.255')).toBe(true)
    expect(unroutable('224.0.0.1')).toBe(true)
    expect(unroutable('169.254.10.1')).toBe(true)
    expect(unroutable('::1')).toBe(true)
    expect(unroutable('fe80::1')).toBe(true)
    expect(unroutable('ff02::1')).toBe(true)
    expect(unroutable('')).toBe(true)
  })

  it('keeps the LAN and the public internet', () => {
    expect(unroutable('10.0.0.9')).toBe(false)
    expect(unroutable('192.168.1.20')).toBe(false)
    expect(unroutable('172.16.4.4')).toBe(false)
    expect(unroutable('198.51.100.7')).toBe(false)
  })
})

describe('a punched stream', () => {
  it('delivers frames whole and in order', async () => {
    const stream = new FakeStream()
    const channel = new StreamChannel(stream)
    const received: string[] = []
    channel.onMessage((data) => received.push(data.toString('utf8')))

    stream.push('{"v":1,"type":"hello","token":"a"}')
    stream.push('{"id":"1","type":"session.list"}')
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(received).toEqual(['{"v":1,"type":"hello","token":"a"}', '{"id":"1","type":"session.list"}'])

    channel.send('{"v":1,"type":"welcome"}')
    expect(stream.sent.map((entry) => entry.toString('utf8'))).toEqual(['{"v":1,"type":"welcome"}'])
  })

  it('reports the end when the stream does', async () => {
    const stream = new FakeStream()
    const channel = new StreamChannel(stream)
    let closed = 0
    channel.onClose(() => {
      closed += 1
    })
    channel.onMessage(() => undefined)

    await stream.close()
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(closed).toBe(1)
    expect(channel.open).toBe(false)
  })

  it('carries a real Mizar frame over a real punch', async () => {
    // The service and a phone-ish engine, over UDP on loopback. This is the
    // adapter's whole reason to exist: the bytes are a frame, and they arrive
    // as one.
    const acceptor = await Engine.create({
      identity: deriveIdentity(randomBytes(32), 'host'),
      policy: { ...STANDARD_POLICY, punchAnswerGraceMs: 40 },
      stunServers: [],
    })
    const dialer = await Engine.create({
      identity: deriveIdentity(randomBytes(32), 'device'),
      policy: STANDARD_POLICY,
      stunServers: [],
    })
    try {
      const accepting = acceptor.accept()
      const dialerStream = await dialer.dial(
        { endpointId: acceptor.identity.endpointId, direct: [`127.0.0.1:${acceptor.port}`] },
        2000,
      )
      const peerStream = await accepting

      const channel = new StreamChannel(peerStream)
      const frames: string[] = []
      channel.onMessage((data) => frames.push(data.toString('utf8')))

      const frame = '{"v":1,"type":"hello","token":"mz_test"}'
      await dialerStream.send(Buffer.from(frame, 'utf8'))
      await new Promise((resolve) => setTimeout(resolve, 60))
      expect(frames).toEqual([frame])
    } finally {
      await dialer.close()
      await acceptor.close()
    }
  })
})
