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
export declare const BIND_MODES: readonly ["lan", "loopback", "addresses"];
/**
 * The relay this plugin uses unless told otherwise.
 *
 * A relay issues no credentials and holds no per-user state, so the same address
 * is correct for everybody. Self-hosters point `relay.url` somewhere else; no
 * other setting changes.
 */
export declare const PUBLIC_RELAY_URL = "https://dshmizar.shirazu-nagisa.com";
/**
 * The account relay — the paid tier's high-bandwidth relay.
 *
 * It is also the only relay that can verify an account session, so the app
 * points its account API here regardless of which tunnel this computer uses.
 * A paid account asks the host to move its tunnel here; see `relay.set`.
 */
export declare const ACCOUNT_RELAY_URL = "https://dshmizar-1.shirazu-nagisa.com";
/** The two public relays a phone may move this computer between. */
export declare const SELECTABLE_RELAY_URLS: readonly string[];
export type BindMode = (typeof BIND_MODES)[number];
export interface Config {
    enabled: boolean;
    port: number;
    bind: {
        mode: BindMode;
        addresses: string[];
        /**
         * How long to wait for the requested mode to produce an address before
         * accepting a fallback, in milliseconds.
         *
         * DSH and the network both come up at login and nothing orders them, so a
         * one-shot decision can land on loopback and stay there. Waiting turns that
         * race into a delay.
         */
        waitForMs: number;
        /** How often to re-check the bind addresses once listening, in milliseconds. */
        pollMs: number;
    };
    tls: {
        mode: 'off' | 'self-signed';
    };
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
        enabled: boolean;
        /** The relay's base URL. */
        url: string;
        /**
         * A tunnel credential, when one is supplied.
         *
         * Empty in every normal install: the plugin generates its own identity on
         * first run and the relay derives the room from it. Setting this is for
         * pinning a specific room -- moving a computer between relays without re-pairing
         * the phones, or reproducing an issue.
         */
        token: string;
        /**
         * The base URL a phone should use, when it differs from {@link url}.
         *
         * A computer on the same LAN as the relay can dial it on a private address while
         * phones must use the public one. Empty means "the same host, with the
         * scheme a phone needs".
         */
        publicUrl: string;
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
        preferLoopback: boolean;
        reconnectBaseMs: number;
        reconnectMaxMs: number;
        /** How long the relay may stay silent before the tunnel is redialled. */
        watchdogMs: number;
    };
    pairing: {
        codeTtlSeconds: number;
        maxAttemptsPerMinute: number;
        issueOnStart: boolean;
    };
    reconnect: {
        heartbeatMs: number;
        pongTimeoutMs: number;
    };
    portFallback: boolean;
    spike: boolean;
}
export declare const Config: z<Config>;
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
export declare function listenerBindMode(config: Config): BindMode;
