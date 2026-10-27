/**
 * Tests for the listener's handshake answers.
 *
 * The app branches on the error *code*, so a code that no host can produce is a
 * branch the app can never take: `DEVICE_REVOKED` tells the phone to forget its
 * token and pair again, and it was documented, implemented in Swift, and never
 * sent by anything -- a revoked device got `UNAUTHENTICATED`, which reads as
 * "this host does not know you" rather than "you were removed on purpose".
 *
 * These are the first tests to drive the listener over its real socket rather
 * than through a bridge call: the smoke script covers the same ground, but only
 * against a booted dev profile, which a unit test cannot run.
 *
 * @module dsh-mizar/test/listener
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { MizarStore } from '../src/auth/store.js'
import type { BindPlan } from '../src/net/interfaces.js'
import { MizarListener } from '../src/server/listener.js'

let dir: string
let listener: MizarListener
let store: MizarStore

/** Answers the listener reported as delivered, in order. */
const delivered: { method: string; result: unknown; deviceId: string }[] = []

/** Released by a test to let every waiting `test.slow` answer at once. */
let releaseSlow: () => void = () => undefined
let slowGate: Promise<void> = Promise.resolve()

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mizar-listener-'))
  store = await MizarStore.open(dir)
  delivered.length = 0
  slowGate = new Promise<void>((resolve) => {
    releaseSlow = resolve
  })
  listener = await MizarListener.start({
    plan,
    port: 0,
    portFallback: false,
    store,
    pairingTtlSeconds: 300,
    maxAttemptsPerMinute: 5,
    heartbeatMs: 15_000,
    pongTimeoutMs: 20_000,
    log: () => undefined,
    // One answer small enough to travel, one that cannot be delivered at all:
    // the delivery hook must fire for the first and not for the second.
    methods: {
      'test.small': async () => ({ ok: true }),
      'test.large': async () => ({ blob: 'x'.repeat(600 * 1024) }),
      // Holds its answer until the test lets go, which is how a connection gets
      // more than one call in flight without racing the event loop.
      'test.slow': async () => {
        await slowGate
        return { ok: true }
      },
    },
    onDelivered: (method, result, session) => {
      delivered.push({ method, result, deviceId: session.deviceId })
    },
  })
})

afterEach(async () => {
  await listener.stop()
  await rm(dir, { recursive: true, force: true })
})

const plan: BindPlan = {
  addresses: ['127.0.0.1'],
  mode: 'addresses',
  fellBack: false,
  reason: 'test',
}

/** One frame received, plus what the socket did afterwards. */
interface Exchange {
  readonly frame: Record<string, unknown>
  /** The close code, or `null` when the socket stayed open. */
  readonly closedWith: number | null
}

/**
 * Send one `hello` and read the answer.
 *
 * @param token - the device token to present.
 * @returns the frame and whether the socket was closed.
 */
async function hello(token: string): Promise<Exchange> {
  const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/mizar/v1/ws`)
  return await new Promise<Exchange>((resolve, reject) => {
    let frame: Record<string, unknown> | undefined
    let closedWith: number | null = null
    socket.on('message', (data: Buffer) => {
      frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>
    })
    socket.on('close', (code: number) => {
      closedWith = code
      socket.terminate()
      if (frame === undefined) reject(new Error('closed without answering'))
      else resolve({ frame, closedWith })
    })
    socket.on('error', reject)
    socket.on('open', () => {
      socket.send(
        JSON.stringify({ v: 1, type: 'hello', id: 'h1', token, appVersion: '0.0.1' }),
      )
    })
    // A socket that is accepted stays open, and the welcome is the answer.
    setTimeout(() => {
      if (frame !== undefined && socket.readyState === WebSocket.OPEN) {
        socket.terminate()
        resolve({ frame, closedWith: null })
      }
    }, 150)
  })
}

/** Pair one device through the real HTTP endpoint. */
async function pair(): Promise<{ token: string; deviceId: string }> {
  const issued = await listener.issuePairingCode()
  const response = await fetch(`http://127.0.0.1:${listener.port}/mizar/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: issued.display, deviceName: 'Test phone' }),
  })
  const body = (await response.json()) as { deviceToken: string; deviceId: string }
  return { token: body.deviceToken, deviceId: body.deviceId }
}

/**
 * Authenticate, call one method, and read its answer.
 *
 * @param token - the device token to present.
 * @param type - the method to call.
 * @returns the answer frame.
 */
async function callMethod(token: string, type: string): Promise<Record<string, unknown>> {
  const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/mizar/v1/ws`)
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    socket.on('error', reject)
    socket.on('open', () => {
      socket.send(JSON.stringify({ v: 1, type: 'hello', id: 'h1', token, appVersion: '0.0.1' }))
    })
    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>
      if (frame['type'] === 'welcome') {
        socket.send(JSON.stringify({ v: 1, type, id: 'm1', payload: {} }))
        return
      }
      socket.terminate()
      resolve(frame)
    })
  })
}

describe('the hello handshake', () => {
  it('accepts a token it issued', async () => {
    const { token, deviceId } = await pair()
    const { frame, closedWith } = await hello(token)
    expect(frame['type']).toBe('welcome')
    expect(frame['deviceId']).toBe(deviceId)
    expect(closedWith).toBeNull()
  })

  it('answers PAIRING_REQUIRED for a client with no token at all', async () => {
    // The app sends an empty token when it has nothing stored -- that is what
    // the frame's own type documents it for -- and the actionable answer is
    // "go and pair", not "you are not who you say you are".
    const { frame } = await hello('')
    expect(frame['type']).toBe('error')
    expect(frame['code']).toBe('PAIRING_REQUIRED')
  })

  it('answers UNAUTHENTICATED for a token it has never issued', async () => {
    const { frame } = await hello('mz_NOTATOKENATALL')
    expect(frame['type']).toBe('error')
    expect(frame['code']).toBe('UNAUTHENTICATED')
  })

  it('answers DEVICE_REVOKED for a device the operator removed', async () => {
    const { token, deviceId } = await pair()
    expect(await listener.revokeDevice(deviceId)).toBe(true)

    const { frame } = await hello(token)
    expect(frame['type']).toBe('error')
    expect(frame['code']).toBe('DEVICE_REVOKED')
  })

  it('drops the live socket when a device is revoked under it', async () => {
    const { token, deviceId } = await pair()
    const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/mizar/v1/ws`)
    const welcome = new Promise<void>((resolve, reject) => {
      socket.on('message', () => resolve())
      socket.on('error', reject)
    })
    socket.on('open', () => {
      socket.send(JSON.stringify({ v: 1, type: 'hello', id: 'h1', token }))
    })
    await welcome

    const closed = new Promise<number>((resolve) => socket.on('close', (code: number) => resolve(code)))
    await listener.revokeDevice(deviceId)
    expect(await closed).toBe(4401)
  })

  it('records the rejection in the audit log with its own reason', async () => {
    // The client-facing answer deliberately conflates a replay with a timeout,
    // but the operator's log is the only place the difference can live.
    const { token, deviceId } = await pair()
    await listener.revokeDevice(deviceId)
    await hello(token)
    await hello('mz_NOTATOKENATALL')

    const rejected = (await store.readAudit()).filter(
      (event) => event.event === 'client-rejected',
    )
    const details = rejected.map((event) => event.detail ?? '')
    expect(details.some((detail) => detail.includes('revoked'))).toBe(true)
    expect(details.some((detail) => detail.includes('unknown'))).toBe(true)
  })
})

describe('delivery bookkeeping', () => {
  it('reports an answer as delivered once it is on the wire', async () => {
    const { token, deviceId } = await pair()
    const frame = await callMethod(token, 'test.small')
    expect(frame['type']).toBe('ok')
    // The hook runs on the server as the frame is written, a moment before the
    // client's message event; one short wait covers both.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(delivered).toHaveLength(1)
    expect(delivered[0]?.method).toBe('test.small')
    expect(delivered[0]?.deviceId).toBe(deviceId)
  })

  it('does not report a response the transport refused', async () => {
    // A page refused for size travels as an error frame, not as a page.
    // Recording it would tell the phone it holds records it never received.
    const { token } = await pair()
    const frame = await callMethod(token, 'test.large')
    expect(frame['type']).toBe('error')
    expect(frame['code']).toBe('RESPONSE_TOO_LARGE')
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(delivered).toHaveLength(0)
  })
})


describe('what one connection may ask for', () => {
  /**
   * Open an authenticated socket and hand it to the test.
   *
   * @param token - the device token.
   * @returns the socket and every answer that arrived on it.
   */
  async function authenticated(token: string): Promise<{
    socket: WebSocket
    answers: Record<string, unknown>[]
    closedWith: () => number | null
  }> {
    const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/mizar/v1/ws`)
    const answers: Record<string, unknown>[] = []
    let closedWith: number | null = null
    const ready = new Promise<void>((resolve, reject) => {
      // An oversized frame makes the transport error before it closes; that is
      // the refusal under test, so it is not a failure to run the test.
      socket.on('error', () => undefined)
      socket.on('close', (code: number) => {
        closedWith = code
      })
      socket.on('open', () => {
        socket.send(JSON.stringify({ v: 1, type: 'hello', id: 'h1', token, appVersion: '0.0.1' }))
      })
      socket.on('message', (data: Buffer) => {
        const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>
        if (frame['type'] === 'welcome') {
          resolve()
          return
        }
        answers.push(frame)
      })
      setTimeout(() => reject(new Error('no welcome')), 2_000)
    })
    await ready
    return { socket, answers, closedWith: () => closedWith }
  }

  /** Wait until `predicate` holds, or give up. */
  async function until(predicate: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 2_000
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  it('refuses a frame the transport will not carry, and keeps serving', async () => {
    const { token } = await pair()
    const { socket, answers, closedWith } = await authenticated(token)
    // Over the one mebibyte the listener accepts, in a single frame: the point is
    // that nothing on this side ever buffers or parses it.
    socket.send(
      JSON.stringify({
        v: 1,
        type: 'test.small',
        id: 'huge',
        payload: { blob: 'x'.repeat(1200 * 1024) },
      }),
    )
    await until(() => closedWith() !== null, 'the transport to close')
    // 1009 is `ws` saying the message exceeded `maxPayload`.
    expect(closedWith()).toBe(1009)
    expect(answers).toHaveLength(0)

    // The refusal is per connection: the listener is still there for the next one.
    const after = await callMethod(token, 'test.small')
    expect(after['type']).toBe('ok')
  })

  it('answers RATE_LIMITED past sixteen calls in flight, and recovers after', async () => {
    const { token } = await pair()
    const { socket, answers } = await authenticated(token)
    for (let index = 0; index < 17; index += 1) {
      socket.send(JSON.stringify({ v: 1, type: 'test.slow', id: `slow-${index}`, payload: {} }))
    }

    // The refusal is the only answer that can arrive while the rest are held: a
    // method that waits cannot answer, and the seventeenth call is not started.
    await until(() => answers.length > 0, 'the refusal')
    expect(answers).toHaveLength(1)
    expect(answers[0]?.['type']).toBe('error')
    expect(answers[0]?.['code']).toBe('RATE_LIMITED')
    expect(answers[0]?.['retryable']).toBe(true)

    releaseSlow()
    await until(() => answers.length === 17, 'the held answers')
    expect(answers.filter((frame) => frame['type'] === 'ok')).toHaveLength(16)
    socket.terminate()

    // The budget is per call, not per connection: it is back to zero now.
    const after = await callMethod(token, 'test.small')
    expect(after['type']).toBe('ok')
  })
})
