import z from '@deepseek-ai/schemastery';
/**
 * Bind target selection.
 *
 * `lan` binds every non-internal IPv4 address, which is what makes the plugin
 * work out of the box on a home network. `loopback` binds `127.0.0.1` only --
 * the posture to use with a relay, where the phone never dials this machine
 * directly. `addresses` binds exactly the configured literals.
 */
export const BIND_MODES = ['lan', 'loopback', 'addresses'];
/**
 * The relay this plugin uses unless told otherwise.
 *
 * A relay issues no credentials and holds no per-user state, so the same address
 * is correct for everybody. Self-hosters point `relay.url` somewhere else; no
 * other setting changes.
 */
export const PUBLIC_RELAY_URL = 'https://dshmizar.shirazu-nagisa.com';
export const Config = z.object({
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
});
