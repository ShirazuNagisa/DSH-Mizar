/**
 * The push API, over HTTP, against the real relay.
 *
 * The unit tests cover signing and framing. What they cannot cover is the part
 * that is easy to get quietly wrong: whether the credential identifies the room,
 * whether a token registered by one Mac can be notified by another, and whether
 * a retired token stops being tried. All three are routing facts, and routing
 * facts need a server.
 *
 * @module dsh-mizar-relay/test/push-api
 */
import { createServer, type Http2Server } from 'node:http2'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { startRelay, type Relay } from '../src/index.js'
import type { RelayConfig } from '../src/config.js'
import { deriveRoom } from '../src/room.js'

const MAC_A = 'mac-a-tunnel-credential'
const MAC_B = 'mac-b-tunnel-credential'
const ROOM_A = deriveRoom(MAC_A)

let relay: Relay | undefined
let apple: Http2Server | undefined
/** Statuses the fake Apple answers with, consumed in order. */
let answers: Array<{ status: number; body?: string }> = []
let received: Array<{ path: string; body: string }> = []
/** HTTP/2 connections the fake Apple has accepted. */
let connections = 0

afterEach(async () => {
  await relay?.close()
  relay = undefined
  if (apple !== undefined) {
    const closing = apple
    await new Promise<void>((resolve) => closing.close(() => resolve()))
    apple = undefined
  }
  answers = []
  received = []
  connections = 0
})

/** Start a fake APNs and return the authority to point the relay at. */
async function startFakeApple(): Promise<string> {
  received = []
  connections = 0
  const server = createServer()
  server.on('session', () => {
    connections += 1
  })
  server.on('stream', (stream, headers) => {
    let body = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      body += chunk
    })
    stream.on('end', () => {
      received.push({ path: String(headers[':path'] ?? ''), body })
      const answer = answers.shift() ?? { status: 200 }
      stream.respond({ ':status': answer.status, 'content-type': 'application/json' })
      stream.end(answer.body ?? '')
    })
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  apple = server
  return `http://127.0.0.1:${port}`
}

/** Boot a relay whose APNs points at the fake. */
async function boot(authority: string | null): Promise<string> {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const config: RelayConfig = {
    port: 0,
    host: '127.0.0.1',
    tokens: [MAC_A, MAC_B],
    maxTunnelsPerIp: 4,
    maxRooms: 100,
    maxBodyBytes: 1024 * 1024,
    maxMessageBytes: 900 * 1024,
    maxClientsPerRoom: 8,
    requestTimeoutMs: 2000,
    tunnelIdleMs: 60_000,
    probePort: 0,
    apns:
      authority === null
        ? null
        : {
            key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
            keyId: 'ABCDE12345',
            teamId: 'TEAM123456',
            topic: 'me.shirazu.dshmizar',
            production: false,
            authority,
          },
  }
  relay = await startRelay(config, () => {})
  return `http://127.0.0.1:${relay.port}`
}

/** Post JSON with a bearer credential. */
async function post(
  base: string,
  path: string,
  token: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  })
  return { status: response.status, json: (await response.json()) as Record<string, unknown> }
}

const notification = {
  kind: 'approval',
  title: '需要你的许可',
  body: 'Bash · demo',
  sessionId: 'session-1',
  threadId: 'session-1',
  collapseId: 'approval-session-1',
  timeSensitive: false,
}

describe('registering a device', () => {
  it('stores it against the room the credential derives', async () => {
    const base = await boot(null)
    const reply = await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'phone-1',
      token: 'deadbeef',
      environment: 'sandbox',
      locale: 'zh-Hans',
    })
    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({ ok: true, devices: 1, enabled: false })

    const status = await fetch(`${base}/push/v1/status`, {
      headers: { authorization: `Bearer ${MAC_A}` },
    })
    const statusBody = (await status.json()) as { devices: Array<Record<string, unknown>> }
    expect(statusBody.devices).toHaveLength(1)
    expect(statusBody.devices[0]).toMatchObject({ deviceId: 'phone-1', locale: 'zh-Hans' })
    // The endpoint an operator curls must not hand out the token.
    expect(JSON.stringify(statusBody)).not.toContain('deadbeef')
  })

  it('refuses a request with no credential', async () => {
    const base = await boot(null)
    const response = await fetch(`${base}/push/v1/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'phone-1', token: 'aa', environment: 'sandbox' }),
    })
    expect(response.status).toBe(401)
  })

  it('refuses a credential this relay does not accept', async () => {
    const base = await boot(null)
    const reply = await post(base, '/push/v1/register', 'not-a-configured-credential', {
      deviceId: 'phone-1',
      token: 'aa',
      environment: 'sandbox',
    })
    expect(reply.status).toBe(401)
  })

  it('refuses a token that is not hex', async () => {
    const base = await boot(null)
    const reply = await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'phone-1',
      token: 'has/a/slash',
      environment: 'sandbox',
    })
    expect(reply.status).toBe(400)
  })
})

describe('notifying a room', () => {
  it('delivers to the registered device and reports what happened', async () => {
    const authority = await startFakeApple()
    const base = await boot(authority)
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'phone-1',
      token: 'deadbeef',
      environment: 'sandbox',
      locale: 'en',
    })

    const reply = await post(base, '/push/v1/notify', MAC_A, notification)
    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({ ok: true, sent: 1, failed: 0, dropped: 0, enabled: true })
    expect(received).toHaveLength(1)
    expect(received[0]?.path).toBe('/3/device/deadbeef')
    expect(JSON.parse(received[0]?.body ?? '{}')).toMatchObject({
      aps: { alert: { title: '需要你的许可', body: 'Bash · demo' } },
      sessionId: 'session-1',
    })
  })

  it('sends each device to the Apple its own token belongs to', async () => {
    const authority = await startFakeApple()
    const base = await boot(authority)
    // One room, two phones that disagree about which Apple minted their token:
    // a Debug build and a TestFlight build, both paired to the same Mac.
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'desk-debug-build',
      token: 'aaaa',
      environment: 'sandbox',
    })
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'pocket-testflight-build',
      token: 'bbbb',
      environment: 'production',
    })

    const reply = await post(base, '/push/v1/notify', MAC_A, notification)
    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({ ok: true, sent: 2, failed: 0, dropped: 0 })
    expect(received.map((entry) => entry.path).sort()).toEqual([
      '/3/device/aaaa',
      '/3/device/bbbb',
    ])
    // Both environments resolve to this fake, because the authority override
    // applies to both, so the split shows up as a connection each -- which is
    // what a client that picked one host for the whole deployment could not do.
    // The two hosts themselves are pinned in apns.test.ts, where they are
    // visible without a real Apple to connect to.
    expect(connections).toBe(2)
  })

  it('leaves out the devices whose app the Mac says is on screen', async () => {
    const authority = await startFakeApple()
    const base = await boot(authority)
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'phone-1',
      token: 'aaaa',
      environment: 'sandbox',
    })
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'phone-2',
      token: 'bbbb',
      environment: 'sandbox',
    })

    const reply = await post(base, '/push/v1/notify', MAC_A, {
      ...notification,
      exceptDeviceIds: ['phone-1'],
    })
    expect(reply.json).toMatchObject({ ok: true, sent: 1, failed: 0, dropped: 0 })
    // Skipped, not refused: the device that is looking gets nothing, and the one
    // in the pocket still gets everything. A single global flag used to silence
    // both, which is how an iPad left open on a session muted a phone.
    expect(received.map((entry) => entry.path)).toEqual(['/3/device/bbbb'])
    // Still registered, so the next notification -- once the app is put away --
    // reaches it without waiting for a re-registration.
    const status = await fetch(`${base}/push/v1/status`, {
      headers: { authorization: `Bearer ${MAC_A}` },
    })
    const statusBody = (await status.json()) as { devices: unknown[] }
    expect(statusBody.devices).toHaveLength(2)
  })

  it('does not let one Mac notify another Mac\'s phones', async () => {
    const authority = await startFakeApple()
    const base = await boot(authority)
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'phone-1',
      token: 'deadbeef',
      environment: 'sandbox',
    })

    // Same relay, different credential: a different room, and a room with
    // nothing registered in it. This is the property that makes an open relay
    // safe, so it is asserted rather than assumed.
    const reply = await post(base, '/push/v1/notify', MAC_B, notification)
    expect(reply.json).toMatchObject({ sent: 0, failed: 0 })
    expect(received).toHaveLength(0)
    expect(deriveRoom(MAC_B)).not.toBe(ROOM_A)
  })

  it('stops trying a token Apple has retired', async () => {
    const authority = await startFakeApple()
    const base = await boot(authority)
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'phone-1',
      token: 'deadbeef',
      environment: 'sandbox',
    })

    answers = [{ status: 410, body: JSON.stringify({ reason: 'Unregistered' }) }]
    const first = await post(base, '/push/v1/notify', MAC_A, notification)
    expect(first.json).toMatchObject({ sent: 0, dropped: 1 })

    // And the second attempt does not reach Apple at all.
    const second = await post(base, '/push/v1/notify', MAC_A, notification)
    expect(second.json).toMatchObject({ sent: 0, dropped: 0, failed: 0 })
    expect(received).toHaveLength(1)
  })

  it('answers 200 with enabled:false when this relay has no key', async () => {
    const base = await boot(null)
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'phone-1',
      token: 'deadbeef',
      environment: 'sandbox',
    })
    const reply = await post(base, '/push/v1/notify', MAC_A, notification)
    // Not an error: a Mac whose relay cannot push should be told so, not left
    // with a failed request it will retry.
    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({ ok: true, sent: 0, enabled: false })
  })

  it('announces push state on the health endpoint', async () => {
    const authority = await startFakeApple()
    const base = await boot(authority)
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'phone-1',
      token: 'deadbeef',
      environment: 'sandbox',
    })
    const health = await fetch(`${base}/healthz`)
    expect(await health.json()).toMatchObject({ ok: true, pushDevices: 1, push: true })
  })

  it('replaces a device that re-registers, so a reinstall is one row', async () => {
    const authority = await startFakeApple()
    const base = await boot(authority)
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'phone-1',
      token: 'aaaa',
      environment: 'sandbox',
    })
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'phone-1',
      token: 'bbbb',
      environment: 'sandbox',
    })
    await post(base, '/push/v1/notify', MAC_A, notification)
    expect(received.map((entry) => entry.path)).toEqual(['/3/device/bbbb'])
  })

  it('forgets a device on unregister', async () => {
    const authority = await startFakeApple()
    const base = await boot(authority)
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'phone-1',
      token: 'deadbeef',
      environment: 'sandbox',
    })
    const removed = await post(base, '/push/v1/unregister', MAC_A, { deviceId: 'phone-1' })
    expect(removed.json).toMatchObject({ removed: true, devices: 0 })

    const reply = await post(base, '/push/v1/notify', MAC_A, notification)
    expect(reply.json).toMatchObject({ sent: 0 })
    expect(received).toHaveLength(0)
  })

  it('refuses a notification with no title', async () => {
    const base = await boot(null)
    const reply = await post(base, '/push/v1/notify', MAC_A, { body: 'no title' })
    expect(reply.status).toBe(400)
  })

  it('leaves the tunnel API alone', async () => {
    const base = await boot(null)
    // The push prefix must not shadow anything, and an unknown path under it
    // must not be mistaken for a room.
    const unknown = await post(base, '/push/v1/nonsense', MAC_A, {})
    expect(unknown.status).toBe(404)
    const room = await fetch(`${base}/r/${ROOM_A}/mizar/v1/hello`)
    expect(room.status).toBe(404)
  })
})
