import z from '@deepseek-ai/schemastery';
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
});
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
export function listenerBindMode(config) {
    return config.relay.enabled && config.relay.preferLoopback ? 'loopback' : config.bind.mode;
}
