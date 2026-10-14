import z from '@deepseek-ai/schemastery';
/**
 * Bind target selection.
 *
 * `tailscale` enumerates the host interfaces and binds only the addresses the
 * tailnet owns (CGNAT IPv4 `100.64.0.0/10` and the tailnet IPv6 prefix), which
 * keeps the listener off plain LAN interfaces. `lan` binds every non-internal
 * IPv4 address. `loopback` binds `127.0.0.1` only — the SSH-tunnel posture.
 * `addresses` binds exactly the configured literals.
 */
export const BIND_MODES = ['tailscale', 'lan', 'loopback', 'addresses'];
export const Config = z.object({
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
});
