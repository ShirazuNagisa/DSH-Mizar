/**
 * The push API, over HTTP, against the real relay.
 *
 * The unit tests cover signing and framing. What they cannot cover is the part
 * that is easy to get quietly wrong: whether the credential identifies the room,
 * whether a token registered by one Mac can be notified by another, whether a
 * retired token stops being tried, and whether one room's two platforms are
 * routed to two different services. All four are routing facts, and routing
 * facts need a server.
 *
 * @module dsh-mizar-relay/test/push-api
 */
import { createServer, type Server } from 'node:http'
import { createServer as createHttp2Server, type Http2Server } from 'node:http2'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { startRelay, type Relay } from '../src/index.js'
import type { RelayConfig } from '../src/config.js'
import type { FcmConfig } from '../src/fcm.js'
import { deriveRoom } from '../src/room.js'

const MAC_A = 'mac-a-tunnel-credential'
const MAC_B = 'mac-b-tunnel-credential'
const ROOM_A = deriveRoom(MAC_A)

/** An FCM registration token, which is emphatically not hex. */
const ANDROID_TOKEN = 'dGhpc2lzOm5vdC1oZXg_APA91b:APA91bF-abc_def'

let relay: Relay | undefined
let apple: Http2Server | undefined
let google: Server | undefined
/** Statuses the fake Apple answers with, consumed in order. */
let answers: Array<{ status: number; body?: string }> = []
let received: Array<{ path: string; body: string }> = []
/** HTTP/2 connections the fake Apple has accepted. */
let connections = 0
/** What the fake Google received. */
let googleReceived: Array<{ path: string; body: string }> = []

afterEach(async () => {
  await relay?.close()
  relay = undefined
  if (apple !== undefined) {
    const closing = apple
    await new Promise<void>((resolve) => closing.close(() => resolve()))
    apple = undefined
  }
  if (google !== undefined) {
    const closing = google
    await new Promise<void>((resolve) => closing.close(() => resolve()))
    google = undefined
  }
  answers = []
  received = []
  connections = 0
  googleReceived = []
})

/** Start a fake APNs and return the authority to point the relay at. */
async function startFakeApple(): Promise<string> {
  received = []
  connections = 0
  const server = createHttp2Server()
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

/**
 * Start a fake Google and return the authority to point the relay at.
 *
 * One host answers both endpoints, because the client's `authority` override
 * applies to both -- the same trick the APNs fake uses to collapse two hosts
 * into one.
 */
async function startFakeGoogle(): Promise<string> {
  googleReceived = []
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
    })
    request.on('end', () => {
      const path = request.url ?? ''
      googleReceived.push({ path, body })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        path === '/token'
          ? JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 })
          : JSON.stringify({ name: 'projects/mizar-test/messages/1' }),
      )
    })
  })
  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })
  google = server
  return `http://127.0.0.1:${port}`
}

/** An FCM configuration pointed at a fake Google. */
function fcmConfig(authority: string): FcmConfig {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    projectId: 'mizar-test',
    clientEmail: 'relay@mizar-test.iam.gserviceaccount.com',
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    authority,
  }
}

/** Boot a relay whose APNs and FCM point at the fakes. */
async function boot(authority: string | null, fcm: FcmConfig | null = null): Promise<string> {
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
    fcm,
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

  it('accepts an Android token that is not hex, and only for Android', async () => {
    const base = await boot(null)
    // ~150 characters of `:` `-` `_` and dots: what FCM actually issues, and
    // what the APNs hex rule rejected with a 400 before there was a platform.
    const android = await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'android-phone',
      token: ANDROID_TOKEN,
      platform: 'android',
    })
    expect(android.status).toBe(200)

    // The same token for iOS is still refused: a registration token sent to APNs
    // would be interpolated into a URL path, and the hex rule is what stops that.
    const ios = await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'iphone',
      token: ANDROID_TOKEN,
      platform: 'ios',
      environment: 'sandbox',
    })
    expect(ios.status).toBe(400)

    // And an Android token with a slash is refused whatever it claims to be.
    const slash = await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'android-phone',
      token: 'has/a/slash',
      platform: 'android',
    })
    expect(slash.status).toBe(400)
  })

  it('treats a registration with no platform as iOS, which is what old plugins send', async () => {
    const base = await boot(null)
    // The plugin that does not know about `platform` is the one that cannot be
    // updated as fast as this relay, so the field being absent has to keep
    // working. Getting this wrong stops notifications to iPhones on deploy day.
    const reply = await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'iphone',
      token: 'deadbeef',
      environment: 'sandbox',
    })
    expect(reply.status).toBe(200)

    const status = await fetch(`${base}/push/v1/status`, {
      headers: { authorization: `Bearer ${MAC_A}` },
    })
    const body = (await status.json()) as { devices: Array<Record<string, unknown>> }
    expect(body.devices[0]).toMatchObject({
      deviceId: 'iphone',
      platform: 'ios',
      environment: 'sandbox',
    })
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

  it('routes each platform to its own service, in the same room and the same call', async () => {
    const authority = await startFakeApple()
    const googleAuthority = await startFakeGoogle()
    const base = await boot(authority, fcmConfig(googleAuthority))
    // One room, two phones on two services: an iPhone paired to this Mac and an
    // Android one. Before `platform` existed the second could not even register.
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'iphone',
      token: 'deadbeef',
      environment: 'sandbox',
    })
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'android-phone',
      token: ANDROID_TOKEN,
      platform: 'android',
    })

    const reply = await post(base, '/push/v1/notify', MAC_A, notification)
    expect(reply.status).toBe(200)
    expect(reply.json).toMatchObject({ ok: true, sent: 2, failed: 0, dropped: 0, enabled: true })

    // One framed APNs request addressed by token, and one FCM message with the
    // registration token in its body.
    expect(received.map((entry) => entry.path)).toEqual(['/3/device/deadbeef'])
    const sends = googleReceived.filter((entry) => entry.path !== '/token')
    expect(sends).toHaveLength(1)
    expect(sends[0]?.path).toBe('/v1/projects/mizar-test/messages:send')
    expect(JSON.parse(sends[0]?.body ?? '{}')).toMatchObject({
      message: { token: ANDROID_TOKEN, notification: { title: '需要你的许可' } },
    })
    // A token is never in a URL: the Android one only ever appears in a body.
    expect(googleReceived.every((entry) => !entry.path.includes(ANDROID_TOKEN))).toBe(true)
  })

  it('fails only the platform it has no client for, and delivers the other anyway', async () => {
    const authority = await startFakeApple()
    const base = await boot(authority)
    // An Android phone paired to a relay whose operator has not set up FCM. The
    // iPhone must keep being notified: a room that gains one Android device
    // cannot lose its notifications.
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'iphone',
      token: 'deadbeef',
      environment: 'sandbox',
    })
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'android-phone',
      token: ANDROID_TOKEN,
      platform: 'android',
    })

    const reply = await post(base, '/push/v1/notify', MAC_A, notification)
    expect(reply.json).toMatchObject({ sent: 1, failed: 1, dropped: 0, enabled: true })
    expect(received).toHaveLength(1)
  })

  it('does the same in the other direction, with only FCM configured', async () => {
    const googleAuthority = await startFakeGoogle()
    const base = await boot(null, fcmConfig(googleAuthority))
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'iphone',
      token: 'deadbeef',
      environment: 'sandbox',
    })
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'android-phone',
      token: ANDROID_TOKEN,
      platform: 'android',
    })

    // No APNs key at all, so the iPhone is the one that cannot be reached -- and
    // `enabled` is still true, because this relay can notify somebody.
    const reply = await post(base, '/push/v1/notify', MAC_A, notification)
    expect(reply.json).toMatchObject({ sent: 1, failed: 1, dropped: 0, enabled: true })
    expect(googleReceived.filter((entry) => entry.path !== '/token')).toHaveLength(1)
    // The registration is not thrown away over it: the operator may configure
    // APNs tomorrow and the token is still the one that phone holds.
    const status = await fetch(`${base}/push/v1/status`, {
      headers: { authorization: `Bearer ${MAC_A}` },
    })
    expect(((await status.json()) as { devices: unknown[] }).devices).toHaveLength(2)
  })

  it('reports both flags on the health endpoint', async () => {
    const authority = await startFakeApple()
    const base = await boot(authority)
    // `push` stays the either-or flag an operator's existing grep uses; `fcm` is
    // the new half, and false here is the honest answer.
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({
      ok: true,
      push: true,
      fcm: false,
    })
  })

  it('says fcm is on when it is the only thing configured', async () => {
    const googleAuthority = await startFakeGoogle()
    const base = await boot(null, fcmConfig(googleAuthority))
    expect(await (await fetch(`${base}/healthz`)).json()).toMatchObject({
      ok: true,
      push: true,
      fcm: true,
    })
  })

  it('does not leak an Android token through the status endpoint either', async () => {
    const googleAuthority = await startFakeGoogle()
    const base = await boot(null, fcmConfig(googleAuthority))
    await post(base, '/push/v1/register', MAC_A, {
      deviceId: 'android-phone',
      token: ANDROID_TOKEN,
      platform: 'android',
      locale: 'zh-Hans',
    })

    const status = await fetch(`${base}/push/v1/status`, {
      headers: { authorization: `Bearer ${MAC_A}` },
    })
    const body = (await status.json()) as { devices: Array<Record<string, unknown>> }
    expect(body.devices[0]).toMatchObject({
      deviceId: 'android-phone',
      platform: 'android',
      // iOS-only, so `null` rather than a guessed default.
      environment: null,
      locale: 'zh-Hans',
    })
    expect(JSON.stringify(body)).not.toContain(ANDROID_TOKEN)
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
