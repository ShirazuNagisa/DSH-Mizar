/**
 * Relay configuration.
 *
 * Deliberately a file rather than a database: this relay serves one operator and
 * a handful of Macs, and a token list that fits in a text file is easier to
 * audit than a schema. Everything here has an environment-variable override so a
 * container deployment does not need a writable filesystem.
 *
 * @module dsh-mizar-relay/config
 */
import { readFileSync } from 'node:fs'
import type { ApnsConfig } from './apns.js'
import type { FcmConfig } from './fcm.js'

/** How the relay is configured. */
export interface RelayConfig {
  /** Port the plain-HTTP server listens on. TLS is the reverse proxy's job. */
  readonly port: number
  /** Interface to bind. Loopback by default, because nginx sits in front. */
  readonly host: string
  /**
   * Tunnel credentials to accept, or empty to accept any.
   *
   * Empty is the normal mode, and the one that makes the plugin configurable by
   * doing nothing: a relay issues no credentials, every plugin invents its own
   * on first run, and the room is derived from whatever it presents. There is
   * nothing for an operator to hand out and nothing for a user to type.
   *
   * Non-empty restricts the relay to a known set, which is what a self-hoster
   * running a private relay wants. The check is a string comparison against a
   * list, so it is not a defence against a determined attacker -- it is a way to
   * keep one's own relay private.
   */
  readonly tokens: readonly string[]
  /**
   * Tunnels allowed from one address.
   *
   * The relay is open, so without this a single host can register rooms until
   * the process runs out of memory. Four is generous for one household and far
   * below what a script would want.
   */
  readonly maxTunnelsPerIp: number
  /** Rooms served at once. Bounds memory regardless of how connections arrive. */
  readonly maxRooms: number
  /** Largest request body the relay will carry, in bytes. */
  readonly maxBodyBytes: number
  /**
   * Largest single WebSocket message the relay will carry, in bytes.
   *
   * Below iOS's hard limit of one mebibyte, because exceeding it does not
   * truncate the message -- it closes the socket, and the operator loses the
   * connection rather than the answer.
   */
  readonly maxMessageBytes: number
  /** Concurrent client connections allowed per room. */
  readonly maxClientsPerRoom: number
  /** How long a phone request waits for the Mac before it is failed, in ms. */
  readonly requestTimeoutMs: number
  /** How long a tunnel may go without a pong before it is dropped, in ms. */
  readonly tunnelIdleMs: number
  /** UDP port for the endpoint probe, or 0 to disable. */
  readonly probePort: number
  /**
   * How to reach Apple, or `null` when this relay does not send notifications.
   *
   * `null` is the default and a perfectly good deployment: everything except
   * notifications works without it, and a self-hoster who does not want a signing
   * key on their server should not have to have one.
   */
  readonly apns: ApnsConfig | null
  /**
   * How to reach Google, or `null` when this relay does not notify Androids.
   *
   * Independent of {@link apns} in both directions: a relay may serve only
   * iPhones, only Androids, or both, and neither key is required for the
   * tunnel to work. See {@link readFcm}.
   */
  readonly fcm: FcmConfig | null
}

/**
 * The `fcm` object as it appears in the config file.
 *
 * A superset of {@link FcmConfig}: the file may carry the whole service-account
 * JSON, either inline or as a path to the downloaded file, which is the shape
 * a Firebase console actually hands out. The individual fields are for a
 * deployment that would rather keep them apart -- a container's secret store
 * usually mounts them that way.
 */
export interface FcmFileConfig {
  /** The service-account JSON, whole, inline. `\n` is unescaped for you. */
  readonly serviceAccount?: string
  /** Or a path to the downloaded service-account JSON. */
  readonly serviceAccountFile?: string
  /** The Firebase project id, when not read from the service account. */
  readonly projectId?: string
  /** The service account's address, when not read from the service account. */
  readonly clientEmail?: string
  /** The service account's private key PEM, when not read from the service account. */
  readonly privateKey?: string
  /** The Android notification channel the app created. */
  readonly channelId?: string
  /** Override Google's origins. Tests only. */
  readonly authority?: string
}

/** Where the config file lives unless overridden. */
export const DEFAULT_CONFIG_PATH = 'relay.config.json'

/**
 * Read configuration from a file plus the environment.
 *
 * Environment wins, so a container can override a mounted file without rewriting
 * it. An empty value is treated as absent rather than as an empty string, which
 * is what an unset Docker variable looks like.
 *
 * @param path - the config file path.
 * @param env - the environment to read overrides from.
 * @returns the resolved configuration.
 * @throws when no token is configured, because an open relay is worse than a
 *   relay that refuses to start.
 */
export function loadConfig(
  path: string = DEFAULT_CONFIG_PATH,
  env: NodeJS.ProcessEnv = process.env,
): RelayConfig {
  let file: Partial<RelayConfig> = {}
  try {
    file = JSON.parse(readFileSync(path, 'utf8')) as Partial<RelayConfig>
  } catch (error) {
    if ((error as { code?: string }).code !== 'ENOENT') throw error
    // No file is fine: everything may come from the environment.
  }

  const pick = <T>(fromEnv: string | undefined, fromFile: T | undefined, fallback: T): T =>
    fromEnv !== undefined && fromEnv !== '' ? (fromEnv as unknown as T) : (fromFile ?? fallback)

  const rawTokens = pick(env['MIZAR_RELAY_TOKENS'], file.tokens?.join(','), '')
  const tokens = rawTokens
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '')

  return {
    port: Number(pick(env['MIZAR_RELAY_PORT'], file.port, 8787)),
    host: pick(env['MIZAR_RELAY_HOST'], file.host, '127.0.0.1'),
    tokens,
    maxTunnelsPerIp: Number(pick(env['MIZAR_RELAY_MAX_TUNNELS_PER_IP'], file.maxTunnelsPerIp, 4)),
    maxRooms: Number(pick(env['MIZAR_RELAY_MAX_ROOMS'], file.maxRooms, 10_000)),
    maxBodyBytes: Number(pick(env['MIZAR_RELAY_MAX_BODY'], file.maxBodyBytes, 4 * 1024 * 1024)),
    maxMessageBytes: Number(
      pick(env['MIZAR_RELAY_MAX_MESSAGE'], file.maxMessageBytes, 900 * 1024),
    ),
    maxClientsPerRoom: Number(pick(env['MIZAR_RELAY_MAX_CLIENTS'], file.maxClientsPerRoom, 8)),
    requestTimeoutMs: Number(pick(env['MIZAR_RELAY_REQUEST_TIMEOUT'], file.requestTimeoutMs, 30_000)),
    tunnelIdleMs: Number(pick(env['MIZAR_RELAY_TUNNEL_IDLE'], file.tunnelIdleMs, 90_000)),
    probePort: Number(pick(env['MIZAR_RELAY_PROBE_PORT'], file.probePort, 8788)),
    apns: readApns(env, file.apns ?? null),
    fcm: readFcm(env, (file.fcm ?? null) as FcmFileConfig | null),
  }
}

/**
 * Resolve the APNs half of the configuration.
 *
 * The `.p8` key arrives either inline or as a path, and inline is supported
 * because that is what a container's secret store usually gives you. The `\n`
 * unescaping is for the same place: a PEM pasted into an environment variable
 * has its newlines written as two characters, and a key that is nearly right is
 * one that fails at signing time with a message about PEM parsing rather than
 * about the environment.
 *
 * @param env - the environment.
 * @param file - the `apns` object from the config file, when present.
 * @returns the configuration, or `null` when this relay does not push.
 */
function readApns(
  env: NodeJS.ProcessEnv,
  file: Partial<ApnsConfig> | null,
): ApnsConfig | null {
  const pick = <T>(fromEnv: string | undefined, fromFile: T | undefined, fallback: T): T =>
    fromEnv !== undefined && fromEnv !== '' ? (fromEnv as unknown as T) : (fromFile ?? fallback)

  const keyId = pick(env['MIZAR_APNS_KEY_ID'], file?.keyId, '')
  const teamId = pick(env['MIZAR_APNS_TEAM_ID'], file?.teamId, '')
  const topic = pick(env['MIZAR_APNS_TOPIC'], file?.topic, '')
  const inline = pick(env['MIZAR_APNS_KEY'], file?.key, '')
  const path = pick(env['MIZAR_APNS_KEY_FILE'], undefined, '')

  let key = inline.replace(/\\n/g, '\n')
  if (key === '' && path !== '') {
    try {
      key = readFileSync(path, 'utf8')
    } catch {
      // Treated as "not configured" rather than as a startup failure: a relay
      // that refuses to boot because a notification key is missing takes the
      // tunnel down with it, and the tunnel is the part that matters.
      return null
    }
  }

  if (key === '' || keyId === '' || teamId === '' || topic === '') return null

  const environment: string = pick(env['MIZAR_APNS_ENV'], undefined as string | undefined, 'production')
  return {
    key,
    keyId,
    teamId,
    topic,
    production: environment !== 'sandbox',
    ...(env['MIZAR_APNS_TIME_SENSITIVE'] === '1' ||
    env['MIZAR_APNS_TIME_SENSITIVE'] === 'true'
      ? { timeSensitive: true }
      : {}),
  }
}

/**
 * Resolve the FCM half of the configuration.
 *
 * The service account is the awkward part: Firebase hands out a JSON file whose
 * three interesting fields are exactly the three this client needs, so both
 * shapes are accepted -- the file (inline or by path) with the fields read out
 * of it, or the fields on their own, which wins when both are present. The `\n`
 * unescaping is for the same place it is in {@link readApns}: a PEM pasted into
 * an environment variable has its newlines written as two characters, and a key
 * that is nearly right fails at signing time with a message about RSA keys
 * rather than about the environment.
 *
 * Incomplete means `null`, not a startup failure. A relay that refuses to boot
 * because a notification credential is missing takes the tunnel down with it,
 * and the tunnel is the part that matters -- a missing or malformed service
 * account shows up as `"fcm": false` on `/healthz` and one log line per room
 * notified, rather than as a relay that is not running.
 *
 * @param env - the environment.
 * @param file - the `fcm` object from the config file, when present.
 * @returns the configuration, or `null` when this relay does not push to Android.
 */
function readFcm(env: NodeJS.ProcessEnv, file: FcmFileConfig | null): FcmConfig | null {
  const pick = <T>(fromEnv: string | undefined, fromFile: T | undefined, fallback: T): T =>
    fromEnv !== undefined && fromEnv !== '' ? (fromEnv as unknown as T) : (fromFile ?? fallback)

  const inline = pick(env['MIZAR_FCM_SERVICE_ACCOUNT'], file?.serviceAccount, '')
  const path = pick(env['MIZAR_FCM_SERVICE_ACCOUNT_FILE'], file?.serviceAccountFile, '')

  let account: Record<string, unknown> = {}
  if (inline !== '') {
    const parsed = parseServiceAccount(inline)
    if (parsed === null) return null
    account = parsed
  } else if (path !== '') {
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch {
      // See the comment above: not configured, not a reason to stop the tunnel.
      return null
    }
    const parsed = parseServiceAccount(text)
    if (parsed === null) return null
    account = parsed
  }

  const projectId = pick(env['MIZAR_FCM_PROJECT_ID'], file?.projectId, text(account, 'project_id'))
  const clientEmail = pick(env['MIZAR_FCM_CLIENT_EMAIL'], file?.clientEmail, text(account, 'client_email'))
  const privateKey = pick(
    env['MIZAR_FCM_PRIVATE_KEY'],
    file?.privateKey,
    text(account, 'private_key'),
  ).replace(/\\n/g, '\n')
  const channelId = pick(env['MIZAR_FCM_CHANNEL_ID'], file?.channelId, '')
  const authority = pick(env['MIZAR_FCM_AUTHORITY'], file?.authority, '')

  if (projectId === '' || clientEmail === '' || privateKey === '') return null

  return {
    projectId,
    clientEmail,
    privateKey,
    ...(channelId === '' ? {} : { channelId }),
    ...(authority === '' ? {} : { authority }),
  }
}

/**
 * Parse a service-account JSON body.
 *
 * No unescaping here: `JSON.parse` already turns the `\n` inside the JSON's
 * `private_key` string into a real newline, and the one place a doubly-escaped
 * PEM still needs fixing is {@link readFcm}'s final `replace`, which sees the
 * extracted key whichever way it arrived.
 */
function parseServiceAccount(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** One string field of a service account, or `''` when it is not a string. */
function text(account: Record<string, unknown>, key: string): string {
  const value = account[key]
  return typeof value === 'string' ? value : ''
}
