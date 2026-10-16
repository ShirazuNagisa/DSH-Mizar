/**
 * Talking to Apple.
 *
 * APNs is HTTP/2 with a JSON body and a JWT for a password, which is little
 * enough that it needs no dependency: `node:http2` and `node:crypto` are both
 * built in, and the one thing that is easy to get wrong is the signature.
 *
 * **ES256 is not "sign these bytes".** JWS wants the raw 64-byte `R || S` pair,
 * and Node's default for an ECDSA key is the DER `SEQUENCE` those two numbers
 * are wrapped in. Signing without `dsaEncoding: 'ieee-p1363'` produces a token
 * that looks entirely correct and that Apple rejects with `InvalidProviderToken`
 * -- which says nothing about the encoding. That one option is the difference
 * between this file working and this file being a mystery.
 *
 * The other thing worth knowing: a device token is not a durable fact. Apple
 * answers `410 Unregistered` for one that has been retired, and a sender that
 * ignores that keeps pushing into a hole for the life of the deployment.
 *
 * **A token also belongs to one of two Apples.** The sandbox and production
 * hosts do not accept each other's tokens, and nothing in the token says which
 * one minted it, so the environment travels with each notification and decides
 * the host per send. A relay that picked one host for the whole deployment
 * answered `BadDeviceToken` for every phone built the other way -- which is
 * indistinguishable from a dead token, so the registration was deleted and the
 * phone went quiet with the Mac still reporting it registered.
 *
 * @module dsh-mizar-relay/apns
 */
import { connect, constants, type ClientHttp2Session } from 'node:http2'
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'

/** Which APNs a token belongs to. The two do not accept each other's tokens. */
export type ApnsEnvironment = 'sandbox' | 'production'

/** What APNs needs to know about this deployment. */
export interface ApnsConfig {
  /** The `.p8` signing key, PEM, exactly as Apple issued it. */
  readonly key: string
  /** The key's ten-character id, from the Apple developer portal. */
  readonly keyId: string
  /** The ten-character team id. */
  readonly teamId: string
  /** The app's bundle id, which is also the APNs topic. */
  readonly topic: string
  /**
   * The environment this deployment mostly serves.
   *
   * No longer selects the host. It used to, and that was the defect: a Debug
   * phone whose token belongs to the sandbox answered `BadDeviceToken` for every
   * push against a relay configured for production, and the relay read that
   * answer -- correctly, once the environment is honoured -- as a dead token and
   * deleted the registration. Each device's own environment now picks the host,
   * and this field is kept because the config file and `MIZAR_APNS_ENV` still
   * carry it and a schema change would break deployments for no gain.
   */
  readonly production: boolean
  /**
   * Override the APNs origin.
   *
   * Exists so a test can point this at a local HTTP/2 server and exercise the
   * real signing and framing. Unset in every deployment. It applies to both
   * environments, so a test sees one host rather than two -- the per-environment
   * hosts are asserted against {@link apnsOrigin} instead.
   */
  readonly authority?: string
  /**
   * Ask iOS to break through Focus for urgent notifications.
   *
   * Off by default because it is not free: the level is only honoured when the
   * app carries the time-sensitive-notifications entitlement, and an app that
   * asks for a capability it was not provisioned for is not something a relay
   * should decide on an operator's behalf.
   */
  readonly timeSensitive?: boolean
}

/** One notification to deliver. */
export interface ApnsNotification {
  readonly deviceToken: string
  /**
   * Which APNs the token was issued for.
   *
   * Per notification rather than per deployment because one room holds phones
   * that disagree: a Debug build on the desk talks to the sandbox while the
   * TestFlight build in a pocket talks to production, and both are paired to the
   * same Mac.
   */
  readonly environment: ApnsEnvironment
  readonly title: string
  readonly body: string
  /** What the phone groups notifications under. */
  readonly threadId: string
  /** Replaces an earlier notification with the same id. */
  readonly collapseId: string
  /** Higher priority requests are delivered immediately rather than batched. */
  readonly urgent: boolean
  /** The session a tap should open, echoed in the payload. */
  readonly sessionId: string | null
  /** What the notification is about, echoed in the payload. */
  readonly kind: string
}

/** What Apple said. */
export interface ApnsResult {
  readonly delivered: boolean
  /**
   * Whether Apple says this token is dead and should be forgotten.
   *
   * `BadDeviceToken` is included: the environment a token belongs to travels
   * with the notification and picks the host, so this answer means the token is
   * dead or is for another topic -- and retrying it forever is a way to turn a
   * dead registration into a permanent stream of failed requests.
   */
  readonly unregistered: boolean
  readonly status: number
  readonly reason: string | null
}

/** How long a signed JWT is reused before it is minted again. */
const TOKEN_LIFETIME_MS = 50 * 60 * 1000

/** How long one APNs request may take. */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * The reasons Apple gives when the provider token it received is not acceptable.
 *
 * `ExpiredProviderToken` is the token having aged out; `InvalidProviderToken`
 * covers everything else about it, including a signature Apple will not accept.
 * The signature itself is pinned by a test, so by the time one of these arrives
 * the cached token -- not the code that minted it -- is what is worth doubting.
 */
const STALE_TOKEN_REASONS: ReadonlySet<string> = new Set([
  'ExpiredProviderToken',
  'InvalidProviderToken',
])

/** The origin each environment lives at, in the form `connect` takes. */
const APNS_HOSTS: Record<ApnsEnvironment, string> = {
  sandbox: 'https://api.sandbox.push.apple.com',
  production: 'https://api.push.apple.com',
}

/**
 * The APNs host for one environment.
 *
 * Exported because the host choice is otherwise invisible to a test: every test
 * points the client at a local fake through {@link ApnsConfig.authority}, which
 * applies to both environments and collapses the two hosts into one.
 *
 * @param config - the deployment's APNs facts, for the override.
 * @param environment - which APNs the token belongs to.
 * @returns the origin to connect to.
 */
export function apnsOrigin(config: ApnsConfig, environment: ApnsEnvironment): string {
  return config.authority ?? APNS_HOSTS[environment]
}

/** APNs rejects a payload larger than this. */
export const MAX_PAYLOAD_BYTES = 4096

/**
 * Build the JWS signing input for one APNs token.
 *
 * @param keyId - the key id, which goes in the header.
 * @param teamId - the team id, which is the issuer.
 * @param now - the issue time, in epoch milliseconds.
 * @returns the base64url `header.claims` prefix, and the raw bytes to sign.
 */
export function signingInput(keyId: string, teamId: string, now: number): {
  readonly input: string
  readonly claims: { readonly iss: string; readonly iat: number }
} {
  const claims = { iss: teamId, iat: Math.floor(now / 1000) }
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: keyId })).toString('base64url')
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url')
  return { input: `${header}.${payload}`, claims }
}

/**
 * Sign an APNs provider token.
 *
 * @param key - the parsed `.p8` key.
 * @param keyId - the key id.
 * @param teamId - the team id.
 * @param now - the issue time, in epoch milliseconds.
 * @returns the compact JWS.
 */
export function providerToken(key: KeyObject, keyId: string, teamId: string, now: number): string {
  const { input } = signingInput(keyId, teamId, now)
  const signature = sign('sha256', Buffer.from(input), {
    key,
    // See the module comment: without this the signature is DER and Apple
    // answers `InvalidProviderToken`.
    dsaEncoding: 'ieee-p1363',
  })
  return `${input}.${signature.toString('base64url')}`
}

/** Narrow a raw notification before it is sent. */
export function buildPayload(
  notification: ApnsNotification,
  timeSensitive: boolean,
): Record<string, unknown> {
  return {
    aps: {
      alert: { title: notification.title, body: notification.body },
      sound: 'default',
      'thread-id': notification.threadId,
      ...(timeSensitive ? { 'interruption-level': 'time-sensitive' } : {}),
    },
    // Carried outside `aps` so the app can open the right conversation from a
    // tap without asking the relay anything.
    sessionId: notification.sessionId,
    kind: notification.kind,
  }
}

/**
 * An APNs client.
 *
 * One HTTP/2 session per environment, reused. A connection per notification
 * would make every push pay a TLS handshake to another continent, which for a
 * notification is most of the latency a person notices -- and one session shared
 * between the two environments is not possible, because they are different
 * hosts.
 */
export class ApnsClient {
  readonly #config: ApnsConfig
  readonly #log: (message: string) => void
  readonly #key: KeyObject
  #token: { value: string; mintedAt: number } | null = null
  /** One open session per environment. */
  readonly #sessions = new Map<ApnsEnvironment, ClientHttp2Session>()

  /**
   * @param config - the deployment's APNs facts.
   * @param log - where to report.
   */
  constructor(config: ApnsConfig, log: (message: string) => void) {
    this.#config = config
    this.#log = log
    this.#key = createPrivateKey(config.key)
  }

  /**
   * The current provider token, minted if it is missing or stale.
   *
   * @param freshToken - whether to ignore the cached token and mint a new one.
   * @returns the compact JWS.
   */
  #currentToken(freshToken = false): string {
    const now = Date.now()
    if (!freshToken && this.#token !== null && now - this.#token.mintedAt < TOKEN_LIFETIME_MS) {
      return this.#token.value
    }
    const value = providerToken(this.#key, this.#config.keyId, this.#config.teamId, now)
    this.#token = { value, mintedAt: now }
    return value
  }

  /**
   * Open the session for one environment, or reuse the open one.
   *
   * @param environment - which APNs host to talk to.
   * @returns the session.
   */
  #connect(environment: ApnsEnvironment): ClientHttp2Session {
    const existing = this.#sessions.get(environment)
    if (existing !== undefined && !existing.closed && !existing.destroyed) return existing
    const session = connect(apnsOrigin(this.#config, environment))
    // The handlers capture the session they belong to and clear the slot only
    // while it is still the one in use. A late event from a session that has
    // already been replaced used to null the field unconditionally, which
    // orphaned the healthy replacement: the next send opened a third connection
    // and nothing held a reference to close the second.
    const discard = (): void => {
      if (this.#sessions.get(environment) === session) this.#sessions.delete(environment)
    }
    session.on('error', (error) => {
      this.#log(`apns: session error: ${error.message}`)
      discard()
    })
    session.on('close', discard)
    // Apple closes an idle session eventually; letting the process exit while a
    // notification is in flight is worse than keeping one socket open.
    session.unref()
    this.#sessions.set(environment, session)
    return session
  }

  /**
   * Deliver one notification.
   *
   * Never throws. A push is an announcement about state that is already durable,
   * so a failure here must not be able to fail whatever caused it.
   *
   * @param notification - what to send.
   * @returns what Apple said.
   */
  async send(notification: ApnsNotification): Promise<ApnsResult> {
    const payload = JSON.stringify(
      buildPayload(notification, this.#config.timeSensitive === true),
    )
    if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
      // Apple answers `PayloadTooLarge`. Saying so here saves a round trip and
      // names the real problem.
      return { delivered: false, unregistered: false, status: 413, reason: 'PayloadTooLarge' }
    }

    const first = await this.#attempt(notification, payload, false)
    if (first.reason === null || !STALE_TOKEN_REASONS.has(first.reason)) return first

    // A rejected provider token is the one APNs answer worth a second attempt.
    // A token is cached for fifty minutes, and the clock that decides when it is
    // stale is the same clock that minted it -- so a clock that moved under a
    // running relay can leave this process holding a token Apple has stopped
    // accepting while the cache still believes it is good, for as long as the
    // skew lasts. Once, and then Apple's own answer is reported: a loop here
    // would turn a genuinely bad key into a request storm against a rate-limited
    // endpoint, and asking again with the same reason cannot produce a different
    // answer.
    return await this.#attempt(notification, payload, true)
  }

  /**
   * Make one request.
   *
   * @param notification - what to send.
   * @param payload - the already-encoded body.
   * @param freshToken - whether to mint a new provider token for this attempt.
   * @returns what Apple said.
   */
  async #attempt(
    notification: ApnsNotification,
    payload: string,
    freshToken: boolean,
  ): Promise<ApnsResult> {
    const headers: Record<string, string | number> = {
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: `/3/device/${notification.deviceToken}`,
      [constants.HTTP2_HEADER_AUTHORIZATION]: `bearer ${this.#currentToken(freshToken)}`,
      'apns-topic': this.#config.topic,
      'apns-push-type': 'alert',
      // 10 delivers immediately; 5 lets the device defer it to save power. A
      // permission prompt that arrives when the phone next wakes up is a
      // notification about something that already timed out.
      'apns-priority': notification.urgent ? 10 : 5,
      'apns-expiration': notification.urgent ? 0 : Math.floor(Date.now() / 1000) + 3600,
      ...(notification.collapseId === '' ? {} : { 'apns-collapse-id': notification.collapseId }),
      'content-type': 'application/json',
      [constants.HTTP2_HEADER_CONTENT_LENGTH]: Buffer.byteLength(payload),
    }

    return await new Promise<ApnsResult>((resolve) => {
      let settled = false
      const finish = (result: ApnsResult): void => {
        if (settled) return
        settled = true
        resolve(result)
      }

      let request
      try {
        request = this.#connect(notification.environment).request(headers)
      } catch (error) {
        this.#log(`apns: could not open a request: ${describe(error)}`)
        finish({ delivered: false, unregistered: false, status: 0, reason: 'TransportError' })
        return
      }

      let status = 0
      let body = ''
      request.setEncoding('utf8')
      request.on('response', (responseHeaders) => {
        status = Number(responseHeaders[constants.HTTP2_HEADER_STATUS] ?? 0)
      })
      request.on('data', (chunk: string) => {
        body += chunk
      })
      request.on('error', (error) => {
        this.#log(`apns: request failed: ${describe(error)}`)
        finish({ delivered: false, unregistered: false, status, reason: 'TransportError' })
      })
      request.on('end', () => {
        const reason = readReason(body)
        if (status === 200) {
          finish({ delivered: true, unregistered: false, status, reason: null })
          return
        }
        finish({
          delivered: false,
          unregistered: status === 410 || reason === 'BadDeviceToken' || reason === 'Unregistered',
          status,
          reason,
        })
      })
      request.setTimeout(REQUEST_TIMEOUT_MS, () => {
        request.close(constants.NGHTTP2_CANCEL)
        finish({ delivered: false, unregistered: false, status: 0, reason: 'Timeout' })
      })
      request.end(payload)
    })
  }

  /** Close every session, for shutdown. */
  close(): void {
    for (const session of this.#sessions.values()) session.close()
    this.#sessions.clear()
  }
}

/** Read APNs's `{"reason": "..."}` body, tolerating anything else. */
function readReason(body: string): string | null {
  if (body === '') return null
  try {
    const parsed = JSON.parse(body) as { reason?: unknown }
    return typeof parsed.reason === 'string' ? parsed.reason : null
  } catch {
    return body.slice(0, 200)
  }
}

/** One line for a thrown value. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
