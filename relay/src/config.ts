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
  }
}
