/**
 * FCM, against a fake Google.
 *
 * The interesting assertions here are not "a request was made". They are the
 * facts that are invisible when they are wrong:
 *
 *   - **The assertion verifies as RS256, with the claims Google checks.** A
 *     signature made with the wrong algorithm, or an `aud` pointing at the fake
 *     host a test happens to be using, produces a perfectly well-formed JWT that
 *     Google rejects with `invalid_grant` — a message that mentions neither.
 *   - **One access token is reused.** Google mints one per assertion, and an
 *     assertion per notification is a signature per notification against an
 *     endpoint that rate-limits by project.
 *   - **A retired token is reported as retired.** `404 UNREGISTERED` is the
 *     difference between a deployment that stops pushing into a hole and one
 *     that does it forever.
 *   - **A rejected access token costs exactly one re-mint.** `THIRD_PARTY_AUTH_ERROR`
 *     is a stale credential, not a dead device, and the two must not be
 *     confused in either direction.
 *
 * @module dsh-mizar-relay/test/fcm
 */
import { createServer, type Server } from 'node:http'
import { generateKeyPairSync, verify, type KeyObject } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertion,
  buildMessage,
  FcmClient,
  fcmOrigin,
  messagePath,
  MAX_PAYLOAD_BYTES,
  type FcmConfig,
} from '../src/fcm.js'
import { deliver, PushRegistry } from '../src/push.js'

/** A throwaway RSA key, in the shape a Firebase service account hands out. */
function testKey(): { pem: string; privateKey: KeyObject; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    privateKey,
    publicKey,
  }
}

/** One request the fake Google received. */
interface Seen {
  readonly path: string
  readonly headers: Record<string, string | string[] | undefined>
  readonly body: string
}

/** What a fake Google saw and answered. */
interface FakeGoogle {
  readonly origin: string
  readonly seen: Seen[]
  readonly close: () => Promise<void>
}

/**
 * A fake Google, answering both of its endpoints from one host.
 *
 * Real HTTP over a real socket rather than a stubbed client, because the form
 * encoding, the `Bearer` header and the JSON body are half of what can be
 * wrong. The token endpoint and the messaging endpoint share the origin because
 * {@link FcmConfig.authority} overrides both — the same trick `apns.ts` uses to
 * collapse two hosts into one.
 *
 * @param answer - what to reply with, given the request.
 * @returns the origin to point an {@link FcmClient} at, and what it received.
 */
async function fakeGoogle(
  answer: (seen: Seen) => { status: number; body?: string },
): Promise<FakeGoogle> {
  const seen: Seen[] = []
  const server: Server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => {
      body += chunk
    })
    request.on('end', () => {
      const record: Seen = { path: request.url ?? '', headers: request.headers, body }
      seen.push(record)
      const result = answer(record)
      response.writeHead(result.status, { 'content-type': 'application/json' })
      response.end(result.body ?? '')
    })
  })

  const port = await new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : 0)
    })
  })

  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** An answer that mints an access token. */
function tokenOk(): { status: number; body: string } {
  return { status: 200, body: JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }) }
}

/** The FCM error body for one `errorCode`. */
function fcmError(status: number, errorCode: string): { status: number; body: string } {
  return {
    status,
    body: JSON.stringify({
      error: {
        code: status,
        message: 'The registration token is not a valid FCM registration token',
        status: status === 404 ? 'NOT_FOUND' : 'PERMISSION_DENIED',
        details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }],
      },
    }),
  }
}

const clients: FcmClient[] = []
afterEach(() => {
  for (const client of clients.splice(0)) client.close()
})

/** A client pointed at a fake Google, remembered so it is closed after the test. */
function fakeClient(google: FakeGoogle, pem: string, channelId?: string): FcmClient {
  const client = new FcmClient(
    {
      projectId: 'mizar-test',
      clientEmail: 'relay@mizar-test.iam.gserviceaccount.com',
      privateKey: pem,
      ...(channelId === undefined ? {} : { channelId }),
      authority: google.origin,
    },
    () => {},
  )
  clients.push(client)
  return client
}

/** One notification, as the client takes it. */
const notification = {
  deviceToken: 'dGhpc2lzOm5vdC1oZXg_APA91b',
  title: 'Permission needed',
  body: 'Bash · demo',
  collapseId: 'approval-s1-Bash',
  urgent: true,
  sessionId: 's1',
  kind: 'approval',
} as const

/**
 * The assertion a fake Google received, decoded.
 *
 * @param body - the OAuth2 form body.
 * @returns the three JWS parts.
 */
function assertionOf(body: string): { header: string; claims: string; signature: string } {
  const encoded = new URLSearchParams(body).get('assertion') ?? ''
  const [header = '', claims = '', signature = ''] = encoded.split('.')
  return { header, claims, signature }
}

describe('the OAuth2 assertion', () => {
  it('signs RS256 with the claims Google checks', () => {
    const key = testKey()
    const token = assertion(key.privateKey, 'relay@mizar-test.iam.gserviceaccount.com', 1_700_000_000_000)
    const { header, claims, signature } = assertionOf(`assertion=${encodeURIComponent(token)}`)

    expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    })
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString('utf8'))).toEqual({
      iss: 'relay@mizar-test.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    })

    // The whole point of RS256: a signature Node produced with the algorithm its
    // default selects, verified with the public half, and the raw bytes the JWS
    // expects rather than a DER wrapper.
    expect(
      verify('sha256', Buffer.from(`${header}.${claims}`), key.publicKey, Buffer.from(signature, 'base64url')),
    ).toBe(true)
  })

  it('points the JWT audience at the real Google even when the transport is overridden', () => {
    const key = testKey()
    const token = assertion(key.privateKey, 'relay@example.test', 1_700_000_000_000)
    const { claims } = assertionOf(`assertion=${encodeURIComponent(token)}`)
    // `aud` is a claim Google checks, not a transport detail. A test that moved
    // it along with the host would stop testing what Google is actually sent.
    expect(JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')).aud).toBe(
      'https://oauth2.googleapis.com/token',
    )
  })
})

describe('which Google endpoint is used', () => {
  it('has one origin per endpoint, and the override wins for both', () => {
    const config: FcmConfig = {
      projectId: 'p',
      clientEmail: 'c',
      privateKey: 'unused',
    }

    expect(fcmOrigin(config, 'oauth')).toBe('https://oauth2.googleapis.com')
    expect(fcmOrigin(config, 'api')).toBe('https://fcm.googleapis.com')
    expect(fcmOrigin({ ...config, authority: 'http://127.0.0.1:1' }, 'oauth')).toBe(
      'http://127.0.0.1:1',
    )
    expect(fcmOrigin({ ...config, authority: 'http://127.0.0.1:1' }, 'api')).toBe(
      'http://127.0.0.1:1',
    )

    // The send path carries the project id and the colon in `messages:send`,
    // which is the one place a URL could be assembled wrongly and still look
    // like a URL.
    expect(messagePath('mizar-test')).toBe('/v1/projects/mizar-test/messages:send')
  })
})

describe('message bodies', () => {
  it('carries every field FCM needs, and only strings in data', () => {
    const body = buildMessage(notification, 'mizar-alerts') as {
      message: {
        token: string
        notification: Record<string, unknown>
        data: Record<string, unknown>
        android: Record<string, unknown>
      }
    }

    expect(body.message.token).toBe(notification.deviceToken)
    expect(body.message.notification).toEqual({
      title: 'Permission needed',
      body: 'Bash · demo',
    })
    expect(body.message.android).toEqual({
      priority: 'high',
      ttl: '0s',
      collapse_key: 'approval-s1-Bash',
      notification: { channel_id: 'mizar-alerts' },
    })
    // Every value in `data` has to be a string: a null or a number makes the
    // whole send an `INVALID_ARGUMENT`, which the client reads as a dead token.
    expect(Object.values(body.message.data).every((value) => typeof value === 'string')).toBe(true)
    expect(body.message.data).toEqual({ kind: 'approval', sessionId: 's1' })
  })

  it('omits what is not there rather than sending nulls', () => {
    const body = buildMessage(
      { ...notification, sessionId: null, collapseId: '', urgent: false },
      undefined,
    ) as { message: { data: Record<string, unknown>; android: Record<string, unknown> } }

    expect(body.message.data).toEqual({ kind: 'approval' })
    // No collapse key, no channel: an empty string is not a value FCM wants.
    expect(body.message.android).toEqual({ priority: 'normal', ttl: '3600s' })
  })
})

describe('delivery', () => {
  it('mints one access token and reuses it for a second send', async () => {
    const google = await fakeGoogle((seen) =>
      seen.path.endsWith('/token') ? tokenOk() : { status: 200 },
    )
    const key = testKey()
    const client = fakeClient(google, key.pem)

    expect(await client.send(notification)).toEqual({
      delivered: true,
      unregistered: false,
      status: 200,
      reason: null,
    })
    expect(await client.send(notification)).toEqual({
      delivered: true,
      unregistered: false,
      status: 200,
      reason: null,
    })

    const oauth = google.seen.filter((request) => request.path === '/token')
    const sends = google.seen.filter((request) => request.path !== '/token')
    // One assertion for two notifications. An assertion per send is a signature
    // per send, and the endpoint that accepts them rate-limits by project.
    expect(oauth).toHaveLength(1)
    expect(sends).toHaveLength(2)
    expect(oauth[0]?.body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer')
    expect(oauth[0]?.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(sends[0]?.headers['authorization']).toBe('Bearer ya29.test')
    expect(sends[0]?.path).toBe('/v1/projects/mizar-test/messages:send')
    expect(sends[0]?.headers['content-type']).toBe('application/json')

    // The assertion that actually went on the wire, not merely the one the
    // signing function produces when a test calls it directly.
    const onTheWire = assertionOf(oauth[0]?.body ?? '')
    expect(JSON.parse(Buffer.from(onTheWire.header, 'base64url').toString('utf8')).alg).toBe('RS256')
    expect(
      verify(
        'sha256',
        Buffer.from(`${onTheWire.header}.${onTheWire.claims}`),
        key.publicKey,
        Buffer.from(onTheWire.signature, 'base64url'),
      ),
    ).toBe(true)

    await google.close()
  })

  it('addresses one message per device with the priority, key and ttl asked for', async () => {
    const google = await fakeGoogle((seen) =>
      seen.path.endsWith('/token') ? tokenOk() : { status: 200 },
    )
    const key = testKey()
    const registry = new PushRegistry()
    registry.register('room-a', {
      deviceId: 'android-phone',
      token: notification.deviceToken,
      platform: 'android',
      environment: null,
      locale: 'zh-Hans',
    })
    const client = fakeClient(google, key.pem, 'mizar-alerts')

    const outcome = await deliver(
      { registry, apns: null, fcm: client, log: () => {} },
      'room-a',
      {
        kind: 'approval',
        title: '需要你的许可',
        body: 'Bash · demo',
        sessionId: 's1',
        threadId: 's1',
        collapseId: 'approval-s1',
        timeSensitive: false,
        exceptDeviceIds: [],
      },
    )

    expect(outcome).toMatchObject({ sent: 1, failed: 0, dropped: 0, enabled: true })
    const send = google.seen.find((request) => request.path !== '/token')
    const body = JSON.parse(send?.body ?? '{}') as {
      message: { token: string; android: Record<string, unknown>; data: Record<string, unknown> }
    }
    expect(body.message.token).toBe(notification.deviceToken)
    expect(body.message.android['priority']).toBe('high')
    expect(body.message.android['ttl']).toBe('0s')
    expect(body.message.android['collapse_key']).toBe('approval-s1')
    expect(body.message.android['notification']).toEqual({ channel_id: 'mizar-alerts' })
    expect(Object.values(body.message.data).every((value) => typeof value === 'string')).toBe(true)

    await google.close()
  })

  it('forgets a registration token Google says is unregistered', async () => {
    const google = await fakeGoogle((seen) =>
      seen.path.endsWith('/token') ? tokenOk() : fcmError(404, 'UNREGISTERED'),
    )
    const key = testKey()
    const registry = new PushRegistry()
    registry.register('room-a', {
      deviceId: 'android-phone',
      token: notification.deviceToken,
      platform: 'android',
      environment: null,
      locale: 'en',
    })
    const client = fakeClient(google, key.pem)

    const first = await deliver(
      { registry, apns: null, fcm: client, log: () => {} },
      'room-a',
      {
        kind: 'turn-complete',
        title: 't',
        body: 'b',
        sessionId: null,
        threadId: 't',
        collapseId: '',
        timeSensitive: false,
        exceptDeviceIds: [],
      },
    )
    expect(first).toMatchObject({ sent: 0, dropped: 1 })
    expect(registry.devices('room-a')).toHaveLength(0)

    // And gone, so the next notification does not pay for the same answer.
    const before = google.seen.filter((request) => request.path !== '/token').length
    await deliver(
      { registry, apns: null, fcm: client, log: () => {} },
      'room-a',
      {
        kind: 'turn-complete',
        title: 't',
        body: 'b',
        sessionId: null,
        threadId: 't',
        collapseId: '',
        timeSensitive: false,
        exceptDeviceIds: [],
      },
    )
    expect(google.seen.filter((request) => request.path !== '/token')).toHaveLength(before)

    await google.close()
  })

  it('retires a token on SENDER_ID_MISMATCH, which is a wrong project rather than a wrong token', async () => {
    const google = await fakeGoogle((seen) =>
      seen.path.endsWith('/token') ? tokenOk() : fcmError(403, 'SENDER_ID_MISMATCH'),
    )
    const key = testKey()
    const client = fakeClient(google, key.pem)

    const result = await client.send(notification)

    // The token belongs to another Firebase project and will never be accepted
    // by this one, so retrying it forever is the failure being avoided.
    expect(result).toMatchObject({ delivered: false, unregistered: true, status: 403 })
    expect(result.reason).toBe('SENDER_ID_MISMATCH')
    await google.close()
  })

  it('re-mints the access token exactly once when Google refuses it', async () => {
    let attempt = 0
    const google = await fakeGoogle((seen) => {
      if (seen.path.endsWith('/token')) return tokenOk()
      attempt += 1
      if (attempt === 1) return fcmError(403, 'THIRD_PARTY_AUTH_ERROR')
      return { status: 200 }
    })
    const key = testKey()
    const client = fakeClient(google, key.pem)

    const result = await client.send(notification)

    // Google's second answer is the one reported, and by then it is a delivery.
    expect(result).toMatchObject({ delivered: true, unregistered: false, status: 200 })
    expect(google.seen.filter((request) => request.path === '/token')).toHaveLength(2)
    expect(google.seen.filter((request) => request.path !== '/token')).toHaveLength(2)

    // And the token that worked is the cached one, so the retry costs a round
    // trip once rather than a signature per notification from then on.
    await client.send(notification)
    expect(google.seen.filter((request) => request.path === '/token')).toHaveLength(2)
    await google.close()
  })

  it('reports what Google said after one retry, rather than looping', async () => {
    const google = await fakeGoogle((seen) =>
      seen.path.endsWith('/token') ? tokenOk() : fcmError(401, 'UNAUTHENTICATED'),
    )
    const key = testKey()
    const client = fakeClient(google, key.pem)

    const result = await client.send(notification)

    expect(result).toMatchObject({ delivered: false, unregistered: false, status: 401 })
    // One mint up front, one after the refusal, and no more: a credential Google
    // will not accept is a configuration problem, and a loop here would be a
    // request storm against a rate-limited endpoint.
    expect(google.seen.filter((request) => request.path === '/token')).toHaveLength(2)
    expect(google.seen.filter((request) => request.path !== '/token')).toHaveLength(2)
    // A 401 is not a dead device token. Retiring the registration over it is how
    // a relay stops notifying a phone whose only problem was a bad key.
    expect(result.unregistered).toBe(false)
    await google.close()
  })

  it('reports a transient refusal without retiring anything', async () => {
    for (const status of [429, 503]) {
      const google = await fakeGoogle((seen) =>
        seen.path.endsWith('/token') ? tokenOk() : { status, body: '{"error":{"status":"UNAVAILABLE"}}' },
      )
      const key = testKey()
      const client = fakeClient(google, key.pem)

      const result = await client.send(notification)

      expect(result).toMatchObject({ delivered: false, unregistered: false, status })
      // Asked once. Only an access token Google refuses earns a second attempt:
      // a busy Google is a busy Google, and retrying it would double the load at
      // exactly the moment it can least take it.
      expect(google.seen.filter((request) => request.path !== '/token')).toHaveLength(1)
      await google.close()
    }
  })

  it('refuses an oversized message without asking Google', async () => {
    const google = await fakeGoogle((seen) =>
      seen.path.endsWith('/token') ? tokenOk() : { status: 200 },
    )
    const key = testKey()
    const client = fakeClient(google, key.pem)

    const result = await client.send({ ...notification, body: 'x'.repeat(MAX_PAYLOAD_BYTES + 100) })

    expect(result).toMatchObject({ delivered: false, status: 413 })
    // Not even the token endpoint: the answer is knowable here, and a 400
    // INVALID_ARGUMENT from Google would be read as a dead registration.
    expect(google.seen).toHaveLength(0)
    await google.close()
  })

  it('reports a service account that cannot mint a token without retiring the device', async () => {
    const google = await fakeGoogle(() => ({
      status: 400,
      body: JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT Signature.' }),
    }))
    const key = testKey()
    const client = fakeClient(google, key.pem)

    const result = await client.send(notification)

    expect(result).toMatchObject({ delivered: false, unregistered: false, status: 400 })
    expect(result.reason).toBe('invalid_grant')
    expect(google.seen.filter((request) => request.path !== '/token')).toHaveLength(0)
    await google.close()
  })
})
