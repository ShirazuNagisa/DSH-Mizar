/**
 * The signalling channel, over a real socket.
 *
 * `p2p-service.test.ts` covers the gate with a fake channel; this covers the
 * wiring that decides *whether the gate runs at all* — the listener's upgrade
 * branch. The audit that found the hole (M-1 in `mizar-0.8.12-漏洞测试.md`) found
 * it with a raw upgrade request, so the regression test is a raw upgrade request
 * too: an unauthenticated socket must not be handed to the engine, and must not
 * be told anything about this machine.
 *
 * @module dsh-mizar/test/signal-auth
 */
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createDeviceRecord, issueToken } from '../src/auth/devices.js'
import { MizarStore } from '../src/auth/store.js'
import type { BindPlan } from '../src/net/interfaces.js'
import { adaptSignalSocket, P2PService, type P2PEngineLike } from '../src/net/p2p.js'
import { MizarListener } from '../src/server/listener.js'
import type { Candidate } from '../src/transport/p2p/candidate.js'
import { deriveIdentity } from '../src/transport/p2p/crypto.js'
import type { Stream } from '../src/transport/p2p/session.js'

/** An engine that records what it was asked to punch at. */
class StubEngine implements P2PEngineLike {
  readonly identity = deriveIdentity(randomBytes(32), 'host')
  readonly offered: string[] = []

  async accept(): Promise<never> {
    return new Promise<never>(() => undefined)
  }

  offerCandidates(candidates: readonly Candidate[]): void {
    for (const entry of candidates) this.offered.push(`${entry.address}:${entry.port}`)
  }

  localCandidates(): Candidate[] {
    return [{ kind: 'host', address: '10.0.0.5', port: 51000, priority: 1 } as unknown as Candidate]
  }

  async close(): Promise<void> {
    return undefined
  }
}

let dir: string
let listener: MizarListener | undefined
let engine: StubEngine
let token: string

const plan: BindPlan = { addresses: ['127.0.0.1'], mode: 'addresses', fellBack: false, reason: 'test' }

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mizar-signal-'))
  const store = await MizarStore.open(dir)
  const issued = issueToken()
  token = issued.token
  await store.mutate((state) => ({
    ...state,
    devices: [...state.devices, createDeviceRecord(issued, { name: 'phone' }, Date.now())],
  }))

  engine = new StubEngine()
  const service = new P2PService(engine, () => undefined)
  listener = await MizarListener.start({
    plan,
    port: 0,
    portFallback: false,
    store,
    pairingTtlSeconds: 300,
    maxAttemptsPerMinute: 5,
    heartbeatMs: 15_000,
    pongTimeoutMs: 20_000,
    log: () => {},
    p2p: {
      attachSignal: (socket, authorize) => service.attachSignal(adaptSignalSocket(socket), authorize),
    },
  })
})

afterEach(async () => {
  await listener?.stop()
  listener = undefined
  await rm(dir, { recursive: true, force: true })
})

/** Open a signal socket and collect what it says and why it closed. */
function dial(): Promise<{
  socket: WebSocket
  frames: string[]
  closed: Promise<{ code: number }>
}> {
  const port = listener?.port ?? 0
  const socket = new WebSocket(`ws://127.0.0.1:${port}/mizar-net/signal`)
  const frames: string[] = []
  socket.on('message', (data) => frames.push(String(data)))
  const closed = new Promise<{ code: number }>((resolve) => {
    socket.on('close', (code) => resolve({ code }))
  })
  return new Promise((resolve, reject) => {
    socket.on('open', () => resolve({ socket, frames, closed }))
    socket.on('error', reject)
  })
}

describe('the signal channel over a socket', () => {
  it('says nothing, and closes, when the first frame is candidates', async () => {
    const { socket, frames, closed } = await dial()

    socket.send(JSON.stringify({ v: 1, type: 'candidates', candidates: [{ address: '198.51.100.7', port: 40000 }] }))
    const { code } = await closed

    // 4401: the same "who are you" the business channel answers with.
    expect(code).toBe(4401)
    // Nothing about this machine crossed: no endpoint id, no addresses.
    expect(frames).toEqual([])
    expect(engine.offered).toEqual([])
  })

  it('says nothing, and closes, when the token is not one of ours', async () => {
    const { socket, frames, closed } = await dial()

    socket.send(JSON.stringify({ v: 1, type: 'hello', token: 'not-a-token' }))
    const { code } = await closed

    expect(code).toBe(4401)
    expect(frames).toEqual([])
    expect(engine.offered).toEqual([])
  })

  it('announces itself once the token is ours, and only then', async () => {
    const { socket, frames } = await dial()

    socket.send(JSON.stringify({ v: 1, type: 'hello', token }))
    // One frame back: the desktop's own hello.
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(frames).toHaveLength(1)
    const hello = JSON.parse(frames[0] ?? '{}') as Record<string, unknown>
    expect(hello['type']).toBe('hello')
    expect(hello['endpointId']).toBe(engine.identity.endpointId)
    socket.close()
  })

  it('will not aim at loopback even when the phone is authenticated', async () => {
    const { socket } = await dial()

    socket.send(JSON.stringify({ v: 1, type: 'hello', token }))
    await new Promise((resolve) => setTimeout(resolve, 100))
    socket.send(
      JSON.stringify({
        v: 1,
        type: 'candidates',
        candidates: [
          { kind: 'host', address: '127.0.0.1', port: 53315 },
          { kind: 'host', address: '198.51.100.7', port: 40000 },
        ],
      }),
    )
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(engine.offered).toEqual(['198.51.100.7:40000'])
    socket.close()
  })
})
