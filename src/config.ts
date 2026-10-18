import z from '@deepseek-ai/schemastery'

/**
 * Bind target selection.
 *
 * `lan` binds every non-internal IPv4 address, which is what makes the plugin
 * work out of the box on a home network. `loopback` binds `127.0.0.1` only --
 * the posture to use with a relay, where the phone never dials this machine
 * directly. `addresses` binds exactly the configured literals.
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
     * Whether to bind loopback while the tunnel is up.
     *
     * On by default, and it is the point of the feature: with a tunnel the phone
     * never needs to reach this machine directly, so leaving the listener on a
     * LAN address exports it for no reason.
     */
    preferLoopback: boolean
    reconnectBaseMs: number
    reconnectMaxMs: number
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
    preferLoopback: z.boolean().default(true),
    reconnectBaseMs: z.natural().default(1_000),
    reconnectMaxMs: z.natural().default(60_000),
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
