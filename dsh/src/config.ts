import z from '@deepseek-ai/schemastery'

/**
 * Bind target selection.
 *
 * `tailscale` enumerates the host interfaces and binds only the addresses the
 * tailnet owns (CGNAT IPv4 `100.64.0.0/10` and the tailnet IPv6 prefix), which
 * keeps the listener off plain LAN interfaces. `lan` binds every non-internal
 * IPv4 address. `loopback` binds `127.0.0.1` only — the SSH-tunnel posture.
 * `addresses` binds exactly the configured literals.
 */
export const BIND_MODES = ['tailscale', 'lan', 'loopback', 'addresses'] as const
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
     * DSH and Tailscale both start at login and nothing orders them, so a
     * one-shot decision can land on loopback and stay there. Waiting turns that
     * race into a delay.
     */
    waitForMs: number
    /** How often to re-check the bind addresses once listening, in milliseconds. */
    pollMs: number
    /**
     * Start Tailscale automatically when no tailnet address is present.
     *
     * On by default, because choosing `bind.mode: tailscale` is already the
     * operator opting in to Tailscale, and this is what makes "start DSH and the
     * phone can reach it" true without a second manual step.
     *
     * The action is deliberately small: it *launches the app* (or runs
     * `tailscale up` off macOS). It never authenticates, never changes network
     * configuration, and is attempted at most once per startup — so quitting
     * Tailscale on purpose is not fought by a relaunch loop.
     */
    autoConnect: boolean
    /**
     * Make sure "Launch Tailscale at Login" is on.
     *
     * On by default, and it is the setting that matters most for a silent
     * experience: macOS then starts Tailscale itself at every login, as a
     * menu-bar-only app with no window and no focus change. Turning it on once
     * beats launching the app on every DSH start.
     *
     * Writes to Tailscale's own preferences, which is why it is a named setting
     * rather than something done unconditionally.
     */
    ensureStartOnLogin: boolean
  }
  tls: {
    mode: 'off' | 'self-signed'
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
    mode: z.union(BIND_MODES.map((mode) => z.const(mode))).default('tailscale'),
    addresses: z.array(z.string()).default([]),
    waitForMs: z.natural().default(30_000),
    pollMs: z.natural().default(15_000),
    autoConnect: z.boolean().default(true),
    ensureStartOnLogin: z.boolean().default(true),
  }),
  tls: z.object({
    mode: z.union([z.const('off'), z.const('self-signed')]).default('off'),
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
