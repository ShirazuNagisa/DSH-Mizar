/**
 * Talking to Google.
 *
 * FCM is not Apple with different words. Apple takes a signed JWT as the
 * password for every request; Google takes an OAuth2 access token, and that
 * token is itself minted by signing a JWT assertion with the service account's
 * private key and exchanging it at a second endpoint. Two requests to deliver
 * one notification, one of which is usually cached -- so the shape here is a
 * token cache in front of a request, the same as `apns.ts`, with one extra hop.
 *
 * **RS256 is not ES256.** The algorithm in the assertion header has to be the
 * one the key can actually produce: an RSA key signing `RS256` is the default
 * Node behaviour and needs no option, while the EC key `apns.ts` signs with
 * needs `dsaEncoding: 'ieee-p1363'`. Copying that option here would produce an
 * assertion Google rejects with `invalid_grant`, which says nothing about the
 * encoding. See `apns.ts` for the other half of this story.
 *
 * The other thing worth knowing: an FCM registration token is not a durable
 * fact either. Google answers `404 UNREGISTERED` for one that has been retired,
 * and a sender that ignores that keeps pushing into a hole for the life of the
 * deployment.
 *
 * **An Android token is not hex.** It is a long opaque string with `:` `-` and
 * `_` in it, and it goes into a JSON body rather than a URL path -- which is
 * why the validation that guards APNs tokens lives in `push.ts` and is applied
 * per platform rather than here.
 *
 * @module dsh-mizar-relay/fcm
 */
import { createPrivateKey, sign, type KeyObject } from 'node:crypto'

/** What FCM needs to know about this deployment. */
export interface FcmConfig {
  /** The Firebase project id, which the send path is built from. */
  readonly projectId: string
  /** The service account's address, which is the assertion's issuer. */
  readonly clientEmail: string
  /** The service account's private key, PEM, as the downloaded JSON carried it. */
  readonly privateKey: string
  /**
   * The Android notification channel the app created, when it has one.
   *
   * Android 8 and later drop a notification whose channel does not exist, and
   * the app is the only thing that knows what it called the channel -- so this
   * is configuration rather than a constant. Unset means the app's default
   * channel, which is what an app without an explicit channel gets.
   */
  readonly channelId?: string
  /**
   * Override the Google origins.
   *
   * Exists so a test can point this at a local HTTP server and exercise the
   * real signing, form encoding and framing. Unset in every deployment. It
   * applies to both the OAuth2 token endpoint and the messaging endpoint, so a
   * test sees one host rather than two; the real origins are asserted against
   * {@link fcmOrigin} instead.
   */
  readonly authority?: string
}

/** One notification to deliver. */
export interface FcmNotification {
  /** The FCM registration token, as the app reported it. Not hex. */
  readonly deviceToken: string
  readonly title: string
  readonly body: string
  /** Replaces an earlier notification with the same id. */
  readonly collapseId: string
  /** Higher priority requests are delivered immediately rather than batched. */
  readonly urgent: boolean
  /** The session a tap should open, echoed in the payload. */
  readonly sessionId: string | null
  /** What the notification is about, echoed in the payload. */
  readonly kind: string
}

/** What Google said. */
export interface FcmResult {
  readonly delivered: boolean
  /**
   * Whether Google says this token is dead and should be forgotten.
   *
   * `UNREGISTERED` and `SENDER_ID_MISMATCH` are the honest ones. `400
   * INVALID_ARGUMENT` is included for the same reason `apns.ts` includes
   * `BadDeviceToken`: retrying a request Google will never accept turns a dead
   * registration into a permanent stream of failed requests, and a token that
   * produced a malformed body once will produce it every time.
   */
  readonly unregistered: boolean
  readonly status: number
  readonly reason: string | null
}

/** Where Google's two endpoints live. */
const OAUTH_ORIGIN = 'https://oauth2.googleapis.com'
const FCM_ORIGIN = 'https://fcm.googleapis.com'

/** The one scope a notification sender needs. */
const OAUTH_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging'

/** The grant type that trades a signed assertion for an access token. */
const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer'

/**
 * How long an access token is reused before it is replaced.
 *
 * Google issues them for an hour. Five minutes of margin covers a relay whose
 * clock drifts, and the retry below covers the rest -- a token that expires
 * between the check and the send earns one re-mint rather than a failed
 * notification.
 */
const ACCESS_TOKEN_LIFETIME_MS = 55 * 60 * 1000

/** How long one assertion claims to be valid for. Google's own maximum. */
const ASSERTION_LIFETIME_SECONDS = 3600

/** How long one FCM request may take. */
const REQUEST_TIMEOUT_MS = 15_000

/**
 * The reasons Google gives when the access token it received is not acceptable.
 *
 * `THIRD_PARTY_AUTH_ERROR` is a token Google will not take; a `401` is the same
 * answer with less ceremony. Both are worth one re-mint, and neither says the
 * registration is dead.
 */
const STALE_TOKEN_REASONS: ReadonlySet<string> = new Set([
  'THIRD_PARTY_AUTH_ERROR',
  'UNAUTHENTICATED',
])

/** FCM rejects a message larger than this. */
export const MAX_PAYLOAD_BYTES = 4096

/**
 * The origin for one of Google's two endpoints.
 *
 * Exported because the origins are otherwise invisible to a test: every test
 * points the client at a local fake through {@link FcmConfig.authority}, which
 * collapses both hosts into one.
 *
 * @param config - the deployment's FCM facts, for the override.
 * @param which - the OAuth2 token endpoint, or the messaging endpoint.
 * @returns the origin to send to.
 */
export function fcmOrigin(config: FcmConfig, which: 'oauth' | 'api'): string {
  return config.authority ?? (which === 'oauth' ? OAUTH_ORIGIN : FCM_ORIGIN)
}

/**
 * The path one message is sent to.
 *
 * @param projectId - the Firebase project.
 * @returns the path, from the messaging origin.
 */
export function messagePath(projectId: string): string {
  return `/v1/projects/${projectId}/messages:send`
}

/**
 * Sign the OAuth2 assertion for one access-token request.
 *
 * The `aud` is the real token endpoint even when {@link FcmConfig.authority}
 * points somewhere else: it is a claim Google checks, not a transport detail,
 * and a test that changed it along with the host would stop testing what Google
 * is actually sent.
 *
 * @param key - the parsed service-account key.
 * @param clientEmail - the service account's address, which is the issuer.
 * @param now - the issue time, in epoch milliseconds.
 * @returns the compact JWS.
 */
export function assertion(key: KeyObject, clientEmail: string, now: number): string {
  const iat = Math.floor(now / 1000)
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const payload = Buffer.from(
    JSON.stringify({
      iss: clientEmail,
      scope: OAUTH_SCOPE,
      aud: `${OAUTH_ORIGIN}/token`,
      iat,
      exp: iat + ASSERTION_LIFETIME_SECONDS,
    }),
  ).toString('base64url')
  // No options: an RSA key signs `RS256` by default, which is exactly what the
  // header claims. There is no `dsaEncoding` here on purpose -- see the module
  // comment.
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), key)
  return `${header}.${payload}.${signature.toString('base64url')}`
}

/**
 * Build one message body.
 *
 * `data` is strings only, because that is all FCM accepts: a null or a number
 * in there makes the whole send a `400 INVALID_ARGUMENT`, which this file would
 * then read as a dead token and forget the registration over.
 *
 * @param notification - what to send.
 * @param channelId - the Android channel, when the deployment named one.
 * @returns the request body.
 */
export function buildMessage(
  notification: FcmNotification,
  channelId?: string,
): Record<string, unknown> {
  return {
    message: {
      token: notification.deviceToken,
      notification: { title: notification.title, body: notification.body },
      data: {
        kind: notification.kind,
        // Carried so the app can open the right conversation from a tap without
        // asking the relay anything. Omitted rather than null when there is no
        // session: every value in `data` has to be a string.
        ...(notification.sessionId === null ? {} : { sessionId: notification.sessionId }),
      },
      android: {
        // `high` wakes the device now, `normal` lets it batch -- the same split
        // as APNs's 10 and 5, and for the same reason: an approval that arrives
        // when the phone next wakes up is a notification about something that
        // already timed out.
        priority: notification.urgent ? 'high' : 'normal',
        // 0 means "deliver now or drop it"; an hour is the window a batching
        // device has to hand it over.
        ttl: notification.urgent ? '0s' : '3600s',
        ...(notification.collapseId === '' ? {} : { collapse_key: notification.collapseId }),
        ...(channelId === undefined || channelId === ''
          ? {}
          : { notification: { channel_id: channelId } }),
      },
    },
  }
}

/**
 * An FCM client.
 *
 * One access token, cached, in front of one HTTPS endpoint. `fetch` owns the
 * connection pool, so there is no session to keep here -- and the token, which
 * is the only thing worth holding on to, is what the cache is for.
 */
export class FcmClient {
  readonly #config: FcmConfig
  readonly #log: (message: string) => void
  readonly #key: KeyObject
  #token: { value: string; mintedAt: number } | null = null

  /**
   * @param config - the deployment's FCM facts.
   * @param log - where to report.
   */
  constructor(config: FcmConfig, log: (message: string) => void) {
    this.#config = config
    this.#log = log
    this.#key = createPrivateKey(config.privateKey)
  }

  /**
   * An access token, minted if it is missing or stale.
   *
   * @param freshToken - whether to ignore the cached token and mint a new one.
   * @returns the token, or the result to report when it could not be had.
   */
  async #accessToken(
    freshToken: boolean,
  ): Promise<{ token: string } | { token: null; result: FcmResult }> {
    const now = Date.now()
    if (!freshToken && this.#token !== null && now - this.#token.mintedAt < ACCESS_TOKEN_LIFETIME_MS) {
      return { token: this.#token.value }
    }

    const body = new URLSearchParams({
      grant_type: JWT_BEARER_GRANT,
      assertion: assertion(this.#key, this.#config.clientEmail, now),
    }).toString()
    const response = await this.#request(
      `${fcmOrigin(this.#config, 'oauth')}/token`,
      { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    )
    if (response.error !== null) {
      return {
        token: null,
        result: { delivered: false, unregistered: false, status: response.status, reason: response.error },
      }
    }

    const parsed = parseJson(response.body)
    const access = parsed === null ? null : parsed['access_token']
    if (response.status !== 200 || typeof access !== 'string' || access === '') {
      // Google's refusal is `{"error":"invalid_grant","error_description":…}`.
      // Reported rather than swallowed: a service account that cannot mint a
      // token is a configuration problem an operator has to see, and it is not
      // a dead device token.
      const reason = parsed === null ? null : parsed['error']
      this.#log(
        `fcm: could not mint an access token (${response.status} ${typeof reason === 'string' ? reason : 'no error field'})`,
      )
      return {
        token: null,
        result: {
          delivered: false,
          unregistered: false,
          status: response.status,
          reason: typeof reason === 'string' && reason !== '' ? reason : 'AccessTokenUnavailable',
        },
      }
    }

    this.#token = { value: access, mintedAt: now }
    return { token: access }
  }

  /**
   * Deliver one message.
   *
   * Never throws. A push is an announcement about state that is already durable,
   * so a failure here must not be able to fail whatever caused it.
   *
   * @param notification - what to send.
   * @returns what Google said.
   */
  async send(notification: FcmNotification): Promise<FcmResult> {
    const payload = JSON.stringify(buildMessage(notification, this.#config.channelId))
    if (Buffer.byteLength(payload) > MAX_PAYLOAD_BYTES) {
      // Google answers `INVALID_ARGUMENT`, which this file would read as a dead
      // token. Saying so here saves a round trip, names the real problem and
      // keeps the registration.
      return { delivered: false, unregistered: false, status: 413, reason: 'PayloadTooLarge' }
    }

    const first = await this.#attempt(payload, false)
    if (!isStaleToken(first)) return first

    // A rejected access token is the one FCM answer worth a second attempt. The
    // cache is trusted for fifty-five minutes and the clock that decides is the
    // same clock that minted it, so a token can be expired for Google while the
    // cache still believes it is good. Once, and then Google's own answer is
    // reported: a loop here would be a request storm against an endpoint that
    // rate-limits by project, and asking again with the same token cannot
    // produce a different answer.
    return await this.#attempt(payload, true)
  }

  /**
   * Make one send.
   *
   * @param payload - the already-encoded body.
   * @param freshToken - whether to mint a new access token for this attempt.
   * @returns what Google said.
   */
  async #attempt(payload: string, freshToken: boolean): Promise<FcmResult> {
    const access = await this.#accessToken(freshToken)
    if (access.token === null) return access.result

    const response = await this.#request(
      `${fcmOrigin(this.#config, 'api')}${messagePath(this.#config.projectId)}`,
      { authorization: `Bearer ${access.token}`, 'content-type': 'application/json' },
      payload,
    )
    if (response.error !== null) {
      // 429s and 5xx land here as their own status; a timeout or a dead socket
      // as 0. Transient, and never a reason to forget a token.
      return {
        delivered: false,
        unregistered: false,
        status: response.status,
        reason: response.error,
      }
    }
    if (response.status === 200) {
      return { delivered: true, unregistered: false, status: 200, reason: null }
    }

    const reason = readReason(response.body)
    return {
      delivered: false,
      unregistered: isUnregistered(response.status, reason),
      status: response.status,
      reason,
    }
  }

  /**
   * One POST, with a deadline.
   *
   * @param url - the full URL.
   * @param headers - the headers to send.
   * @param body - the body.
   * @returns the status and body, or the reason there is none.
   */
  async #request(
    url: string,
    headers: Record<string, string>,
    body: string,
  ): Promise<{ status: number; body: string; error: string | null }> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      return { status: response.status, body: await response.text(), error: null }
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError'
      this.#log(`fcm: request failed: ${describe(error)}`)
      return { status: 0, body: '', error: timedOut ? 'Timeout' : 'TransportError' }
    }
  }

  /**
   * Forget the cached access token.
   *
   * There is nothing else to close: `fetch` owns its own sockets, and the
   * service account's key is not a resource. Present so the relay's shutdown
   * reads the same for both transports.
   */
  close(): void {
    this.#token = null
  }
}

/** Whether Google's answer means the access token is what was wrong. */
function isStaleToken(result: FcmResult): boolean {
  return result.status === 401 || (result.reason !== null && STALE_TOKEN_REASONS.has(result.reason))
}

/** Whether Google's answer means this registration token should be forgotten. */
function isUnregistered(status: number, reason: string | null): boolean {
  if (status === 404) return true
  return reason === 'UNREGISTERED' || reason === 'INVALID_ARGUMENT' || reason === 'SENDER_ID_MISMATCH'
}

/**
 * Read the error code out of an FCM error body.
 *
 * The useful string is nested two levels deep in `error.details[].errorCode`
 * (`UNREGISTERED`, `SENDER_ID_MISMATCH`, …); `error.status` is the coarse
 * fallback, and a body that is not JSON at all is reported as itself.
 *
 * @param body - the response body.
 * @returns the reason, or `null` when there is none.
 */
function readReason(body: string): string | null {
  if (body === '') return null
  const parsed = parseJson(body)
  if (parsed === null) return body.slice(0, 200)
  const error = parsed['error']
  if (typeof error !== 'object' || error === null) return body.slice(0, 200)
  const record = error as Record<string, unknown>
  const details = record['details']
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (typeof detail !== 'object' || detail === null) continue
      const code = (detail as Record<string, unknown>)['errorCode']
      if (typeof code === 'string' && code !== '') return code
    }
  }
  const status = record['status']
  if (typeof status === 'string' && status !== '') return status
  const message = record['message']
  if (typeof message === 'string' && message !== '') return message.slice(0, 200)
  return null
}

/** Parse a JSON object, or `null` for anything else. */
function parseJson(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** One line for a thrown value. */
function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}
