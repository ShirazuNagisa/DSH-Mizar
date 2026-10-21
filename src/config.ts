import z from '@deepseek-ai/schemastery'

/**
 * Bind target selection.
 *
 * `lan` binds every non-internal IPv4 address, which is what makes the plugin
 * work out of the box on a home network -- including with the relay on, where a
 * phone that is nearby should take the direct route instead of the tunnel.
 * `loopback` binds `127.0.0.1` only: the explicit "nobody dials this machine
 * directly" posture, put in the ordinary bind setting. `addresses` binds exactly
 * the configured literals.
 */
export const BIND_MODES = ['lan', 'loopback', 'addresses'] as const

/**
 * The relay this plugin uses unless told otherwise.
 *
 * A relay issues no credentials and holds no per-user state, so the same address
 * is correct for everybody. Self-hosters point `relay.url` somewhere else; no
 * other setting changes.
 */
export const PUBLIC_RELAY_URL = 'https://dshmizar.shirazu-nagisa.com'

/**
 * The account relay — the paid tier's high-bandwidth relay.
 *
 * It is also the only relay that can verify an account session, so the app
 * points its account API here regardless of which tunnel this computer uses.
 * A paid account asks the host to move its tunnel here; see `relay.set`.
 */
export const ACCOUNT_RELAY_URL = 'https://dshmizar-1.shirazu-nagisa.com'

/** The two public relays a phone may move this computer between. */
export const SELECTABLE_RELAY_URLS: readonly string[] = [
  PUBLIC_RELAY_URL,
  ACCOUNT_RELAY_URL,
]

export type BindMode = (typeof BIND_MODES)[number]

export interface Config {
  enabled: boolean
  port: number
  bind: {
    mode: BindMode
    addresses: string[]
    /**
     * How long to wait for the requested mode to produce an address before
     * accepting a fallback, in milliseconds.
     *
     * DSH and the network both come up at login and nothing orders them, so a
     * one-shot decision can land on loopback and stay there. Waiting turns that
     * race into a delay.
     */
    waitForMs: number
    /** How often to re-check the bind addresses once listening, in milliseconds. */
    pollMs: number
  }
  tls: {
    mode: 'off' | 'self-signed'
  }
  /**
   * The reverse tunnel that makes this computer reachable from a network that blocks
   * inbound traffic.
   *
   * On by default, pointed at the public service, because the point of the whole
   * plugin is that a user installs it and scans a code. Anything they have to
   * configure first is a step most of them will not complete.
   *
   * Self-hosters set `url` to their own relay and nothing else; the rest works
   * the same way, because a relay issues no credentials.
   */
  relay: {
    enabled: boolean
    /** The relay's base URL. */
    url: string
    /**
     * A tunnel credential, when one is supplied.
     *
     * Empty in every normal install: the plugin generates its own identity on
     * first run and the relay derives the room from it. Setting this is for
     * pinning a specific room -- moving a computer between relays without re-pairing
     * the phones, or reproducing an issue.
     */
    token: string
    /**
     * The base URL a phone should use, when it differs from {@link url}.
     *
     * A computer on the same LAN as the relay can dial it on a private address while
     * phones must use the public one. Empty means "the same host, with the
     * scheme a phone needs".
     */
    publicUrl: string
    /**
     * Whether the relay forces the listener onto loopback.
     *
     * Off by default, and that is a product decision made when the LAN link
     * became something the app promises: a phone on the same network as this
     * computer must be able to reach it directly. The direct route is what
     * unlocks the metered features for free, and it is also cheaper for both
     * sides than a relayed round trip. With this on -- and the relay is on by
     * default -- the listener binds loopback whenever the tunnel is up, so
     * `host.info` advertises no dialable address, the pairing QR carries no
     * direct one, and the phone has no LAN route to find at all.
     *
     * Leaving the listener reachable on the LAN is the price. It is not an
     * unauthenticated door: every connection is bearer-token authenticated, and
     * pairing is rate-limited. This is also what the plugin already does with
     * the relay off, which is the common case for anybody on a home network.
     *
     * Turn it on for the old posture -- a tunnel means nobody dials this
     * machine directly, and the LAN features stay unavailable while everything
     * still works over the relay. `bind.mode: loopback` is the same posture in
     * the ordinary bind setting; either one alone is enough.
     */
    preferLoopback: boolean
    reconnectBaseMs: number
    reconnectMaxMs: number
    /** How long the relay may stay silent before the tunnel is redialled. */
    watchdogMs: number
  }
  pairing: {
    codeTtlSeconds: number
    maxAttemptsPerMinute: number
    issueOnStart: boolean
  }
  reconnect: {
    heartbeatMs: number
    pongTimeoutMs: number
  }
  portFallback: boolean
  spike: boolean
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  port: z.natural().max(65535).default(19390),
  bind: z.object({
    mode: z.union(BIND_MODES.map((mode) => z.const(mode))).default('lan'),
    addresses: z.array(z.string()).default([]),
    waitForMs: z.natural().default(30_000),
    pollMs: z.natural().default(15_000),
  }),
  tls: z.object({
    mode: z.union([z.const('off'), z.const('self-signed')]).default('off'),
  }),
  relay: z.object({
    enabled: z.boolean().default(true),
    url: z.string().default(PUBLIC_RELAY_URL),
    token: z.string().default(''),
    publicUrl: z.string().default(''),
    preferLoopback: z.boolean().default(false),
    reconnectBaseMs: z.natural().default(1_000),
    reconnectMaxMs: z.natural().default(60_000),
    /**
     * How long the relay may stay silent before the tunnel is redialled, in ms.
     *
     * The relay pings every tunnel every `tunnelIdleMs / 3` (30 s with the
     * relay's default 90 s idle window). Four missed pings is longer than any
     * healthy relay's silence and short enough that a blackholed network cannot
     * leave a dead room behind for hours. `0` disables the watchdog.
     */
    watchdogMs: z.natural().default(120_000),
  }),
  pairing: z.object({
    codeTtlSeconds: z.natural().default(300),
    maxAttemptsPerMinute: z.natural().default(5),
    /**
     * Issue a pairing code as soon as the listener is up and log it.
     *
     * The Web panel is the normal way to get a code, but a headless or CLI
     * profile has no panel. Turning this on is what makes Mizar usable without
     * the GUI, and what lets the end-to-end smoke test run without a browser.
     */
    issueOnStart: z.boolean().default(false),
  }),
  reconnect: z.object({
    heartbeatMs: z.natural().default(15000),
    pongTimeoutMs: z.natural().default(20000),
  }),
  portFallback: z.boolean().default(true),
  spike: z.boolean().default(false),
})

/**
 * The bind mode the listener actually uses for a given config.
 *
 * `relay.preferLoopback` is the one way the relay changes the bind, and it is
 * off by default: a direct route to a phone on the same network is a feature of
 * the product, not an accident of having no tunnel, so the listener keeps
 * binding whatever `bind.mode` says while the tunnel is up. An explicit
 * `bind.mode: loopback` is untouched by this -- it is the operator saying
 * "nobody dials this machine directly" in the ordinary setting.
 *
 * The decision lives here rather than inline in the composition root so the
 * tests can pin it without starting a listener, and so nobody re-derives it.
 *
 * @param config - the validated plugin config.
 * @returns the mode to bind.
 */
export function listenerBindMode(config: Config): BindMode {
  return config.relay.enabled && config.relay.preferLoopback ? 'loopback' : config.bind.mode
}
