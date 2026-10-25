/**
 * The engine, over real UDP on loopback.
 *
 * Two engines, two sockets, one punch. Nothing is stubbed: the socket binds, the
 * hello goes out as a datagram, the responder answers, and messages travel both
 * ways through a session that would carry them across a NAT the same way.
 *
 * Loopback proves the parts — the exchange, the session, the timeout, the
 * close — and proves nothing about NAT, which is the Swift suite's matrix.
 *
 * @module dsh-mizar/test/p2p-engine
 */
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { deriveIdentity } from '../src/transport/p2p/crypto.js'
import { Engine, P2PError } from '../src/transport/p2p/engine.js'
import { candidate, CandidateKind } from '../src/transport/p2p/candidate.js'
import { STANDARD_POLICY, type Policy } from '../src/transport/p2p/policy.js'
import type { Stream } from '../src/transport/p2p/session.js'

/** Every engine a test started, closed afterwards whatever happened. */
const started: Engine[] = []

/**
 * Start an engine with no STUN server, so the test is closed and deterministic.
 * @param overrides - policy fields to change for the test.
 * @returns the started engine.
 */
async function start(overrides: Partial<Policy> = {}): Promise<Engine> {
  const engine = await Engine.create({
    identity: deriveIdentity(randomBytes(32), 'host'),
    policy: { ...STANDARD_POLICY, ...overrides },
    stunServers: [],
  })
  started.push(engine)
  return engine
}

afterEach(async () => {
  for (const engine of started.splice(0)) await engine.close()
})

/** Wait for a promise, failing the test rather than hanging forever. */
function within<T>(promise: Promise<T>, milliseconds = 3000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), milliseconds)),
  ])
}

describe('a dial', () => {
  it('punches through and carries messages both ways', async () => {
    const acceptor = await start({ punchAnswerGraceMs: 40 })
    const dialer = await start()
    const accepting = acceptor.accept()

    const stream = await within(
      dialer.dial(
        { endpointId: acceptor.identity.endpointId, direct: [`127.0.0.1:${acceptor.port}`] },
        2000,
      ),
    )
    const peer = await within(accepting)

    await stream.send(Buffer.from('ping'))
    expect((await within(peer.receive()))?.toString()).toBe('ping')

    await peer.send(Buffer.from('pong'))
    expect((await within(stream.receive()))?.toString()).toBe('pong')

    // The session knows what it is and who it is talking to.
    expect(stream.pathKind).toBe('p2p')
    expect(stream.remoteEndpointId).toBe(acceptor.identity.endpointId)
    expect(peer.remoteEndpointId).toBe(dialer.identity.endpointId)
  })

  it('reassembles a message that spans several datagrams', async () => {
    const acceptor = await start({ punchAnswerGraceMs: 40, streamChunkBytes: 512 })
    const dialer = await start({ streamChunkBytes: 512 })
    const accepting = acceptor.accept()
    const stream = await within(
      dialer.dial({ endpointId: acceptor.identity.endpointId, direct: [`127.0.0.1:${acceptor.port}`] }, 2000),
    )
    const peer = await within(accepting)

    // 3000 bytes at 512 per chunk: six datagrams, one message.
    const payload = randomBytes(3000)
    await stream.send(payload)
    const received = await within(peer.receive())
    expect(received?.length).toBe(3000)
    expect(received?.equals(payload)).toBe(true)
  })

  it('carries an empty message as a message', async () => {
    const acceptor = await start({ punchAnswerGraceMs: 40 })
    const dialer = await start()
    const accepting = acceptor.accept()
    const stream = await within(
      dialer.dial({ endpointId: acceptor.identity.endpointId, direct: [`127.0.0.1:${acceptor.port}`] }, 2000),
    )
    const peer = await within(accepting)

    await stream.send(Buffer.alloc(0))
    expect((await within(peer.receive()))?.length).toBe(0)
  })

  it('fails at the budget when nobody answers', async () => {
    const dialer = await start({ punchRounds: 2, punchIntervalMs: 20 })
    // Port 1 on loopback: bound by nothing, answered by nobody.
    const started = Date.now()
    await expect(
      dialer.dial({ endpointId: deriveIdentity(randomBytes(32), 'host').endpointId, direct: ['127.0.0.1:1'] }, 400),
    ).rejects.toBeInstanceOf(P2PError)
    expect(Date.now() - started).toBeLessThan(1200)
  })

  it('refuses to dial without a single address', async () => {
    const dialer = await start({ candidateGraceMs: 50 })
    // No hints, no offered candidates: there is nowhere to send a hello.
    await expect(
      dialer.dial({ endpointId: deriveIdentity(randomBytes(32), 'host').endpointId }, 400),
    ).rejects.toMatchObject({ code: 'P2P_FAILED' })
  })
})

describe('a session', () => {
  it('tells the peer when it closes', async () => {
    const acceptor = await start({ punchAnswerGraceMs: 40 })
    const dialer = await start()
    const accepting = acceptor.accept()
    const stream = await within(
      dialer.dial({ endpointId: acceptor.identity.endpointId, direct: [`127.0.0.1:${acceptor.port}`] }, 2000),
    )
    const peer = await within(accepting)

    await stream.close()
    // `null` is the stream's word for "the peer is gone", not an error.
    expect(await within(peer.receive())).toBeNull()
  })

  it('is healthy once a round trip has been measured', async () => {
    const acceptor = await start({ punchAnswerGraceMs: 40 })
    const dialer = await start()
    const accepting = acceptor.accept()
    const stream = await within(
      dialer.dial({ endpointId: acceptor.identity.endpointId, direct: [`127.0.0.1:${acceptor.port}`] }, 2000),
    )
    await within(accepting)

    await stream.send(Buffer.from('ping'))
    // Let the ack land: the health report is derived from measured RTT, and a
    // path with no measurement is `unknown`, not healthy.
    const deadline = Date.now() + 1000
    while (dialer.health().state === 'unknown' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(dialer.health().state).toBe('healthy')
  })
})

describe('a simultaneous open', () => {
  it('leaves one session on each side when both sides punch', async () => {
    // The shape signaling produces: each side learns the other's candidates
    // before dialling, so both punch and both see two session candidates.
    const acceptor = await start({ punchAnswerGraceMs: 150 })
    const dialer = await start({ punchAnswerGraceMs: 150 })
    const acceptorCandidates = acceptor.localCandidates()
    const dialerCandidates = dialer.localCandidates()

    dialer.noteIntent('dial')
    dialer.offerCandidates(acceptorCandidates)
    acceptor.offerCandidates(dialerCandidates)
    const accepting = acceptor.accept()
    const stream = await within(dialer.dial({ endpointId: acceptor.identity.endpointId }, 3000), 4000)
    const peer = await within(accepting)

    // Whichever session survived, it is the same pair and it carries traffic.
    await stream.send(Buffer.from('after the reconcile'))
    expect((await within(peer.receive()))?.toString()).toBe('after the reconcile')

    // And the survivor is the smaller connection id — the rule both sides can
    // compute without negotiating.
    expect(stream.connectionId).toBe(peer.connectionId)
  })
})

describe('candidates', () => {
  it('offers host addresses at the engine\'s own port', async () => {
    const engine = await start()
    const local = engine.localCandidates()
    expect(local.length).toBeGreaterThan(0)
    expect(local.every((entry) => entry.port === engine.port)).toBe(true)
    expect(local.some((entry) => entry.address === '127.0.0.1')).toBe(true)
  })

  it('is enough to punch without a ticket hint', async () => {
    const acceptor = await start({ punchAnswerGraceMs: 40 })
    const dialer = await start()
    dialer.noteIntent('dial')
    // The only route the dialer knows is what "signaling" handed it.
    dialer.offerCandidates([candidate(CandidateKind.Host, '127.0.0.1', acceptor.port)])
    const accepting = acceptor.accept()
    const stream = await within(dialer.dial({ endpointId: acceptor.identity.endpointId }, 2000))
    const peer = await within(accepting)

    await stream.send(Buffer.from('hint-free'))
    expect((await within(peer.receive()))?.toString()).toBe('hint-free')
  })
})
