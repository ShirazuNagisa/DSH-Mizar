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
  }
  tls: {
    mode: 'off' | 'self-signed'
  }
  pairing: {
    codeTtlSeconds: number
    maxAttemptsPerMinute: number
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
  }),
  tls: z.object({
    mode: z.union([z.const('off'), z.const('self-signed')]).default('off'),
  }),
  pairing: z.object({
    codeTtlSeconds: z.natural().default(300),
    maxAttemptsPerMinute: z.natural().default(5),
  }),
  reconnect: z.object({
    heartbeatMs: z.natural().default(15000),
    pongTimeoutMs: z.natural().default(20000),
  }),
  portFallback: z.boolean().default(true),
  spike: z.boolean().default(false),
})
