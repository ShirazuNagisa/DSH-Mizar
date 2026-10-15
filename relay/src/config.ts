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

/** How the relay is configured. */
export interface RelayConfig {
  /** Port the plain-HTTP server listens on. TLS is the reverse proxy's job. */
  readonly port: number
  /** Interface to bind. Loopback by default, because nginx sits in front. */
  readonly host: string
  /**
   * Tokens a Mac may present at the tunnel endpoint.
   *
   * Each token is the capability for one Mac. The room is derived from it, so a
   * token is never sent over the phone leg and never appears in the QR code --
   * a room id leaking is survivable, a tunnel token leaking is not.
   */
  readonly tokens: readonly string[]
  /** Largest request body the relay will carry, in bytes. */
  readonly maxBodyBytes: number
  /** Largest single WebSocket message the relay will carry, in bytes. */
  readonly maxMessageBytes: number
  /** Concurrent client connections allowed per room. */
  readonly maxClientsPerRoom: number
  /** How long a phone request waits for the Mac before it is failed, in ms. */
  readonly requestTimeoutMs: number
  /** How long a tunnel may go without a pong before it is dropped, in ms. */
  readonly tunnelIdleMs: number
  /** UDP port for the endpoint probe, or 0 to disable. */
  readonly probePort: number
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

  if (tokens.length === 0) {
    throw new Error(
      'relay: no tunnel token configured. Set "tokens" in relay.config.json or ' +
        'MIZAR_RELAY_TOKENS. An empty list would accept any tunnel, which is not a ' +
        'useful default for a service that exposes a machine that can run code.',
    )
  }

  return {
    port: Number(pick(env['MIZAR_RELAY_PORT'], file.port, 8787)),
    host: pick(env['MIZAR_RELAY_HOST'], file.host, '127.0.0.1'),
    tokens,
    maxBodyBytes: Number(pick(env['MIZAR_RELAY_MAX_BODY'], file.maxBodyBytes, 4 * 1024 * 1024)),
    maxMessageBytes: Number(
      pick(env['MIZAR_RELAY_MAX_MESSAGE'], file.maxMessageBytes, 4 * 1024 * 1024),
    ),
    maxClientsPerRoom: Number(pick(env['MIZAR_RELAY_MAX_CLIENTS'], file.maxClientsPerRoom, 8)),
    requestTimeoutMs: Number(pick(env['MIZAR_RELAY_REQUEST_TIMEOUT'], file.requestTimeoutMs, 30_000)),
    tunnelIdleMs: Number(pick(env['MIZAR_RELAY_TUNNEL_IDLE'], file.tunnelIdleMs, 90_000)),
    probePort: Number(pick(env['MIZAR_RELAY_PROBE_PORT'], file.probePort, 8788)),
  }
}
