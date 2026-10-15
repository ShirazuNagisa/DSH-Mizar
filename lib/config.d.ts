import z from '@deepseek-ai/schemastery';
/**
 * Bind target selection.
 *
 * `lan` binds every non-internal IPv4 address, which is what makes the plugin
 * work out of the box on a home network. `loopback` binds `127.0.0.1` only --
 * the posture to use with a relay, where the phone never dials this machine
 * directly. `addresses` binds exactly the configured literals.
 */
export declare const BIND_MODES: readonly ["lan", "loopback", "addresses"];
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
     * The reverse tunnel that makes this Mac reachable from a network that blocks
     * inbound traffic.
     *
     * Off by default. Turning it on means one machine's agent traffic flows
     * through another machine, which is a decision an operator should make
     * deliberately rather than inherit.
     */
    relay: {
        enabled: boolean;
        /** The relay's base URL, e.g. `https://mizar.example.com`. */
        url: string;
        /** The tunnel token, shared with the relay's own configuration. */
        token: string;
        /**
         * The base URL a phone should use, when it differs from {@link url}.
         *
         * A Mac on the same LAN as the relay can dial it on a private address while
         * phones must use the public one. Empty means "the same host, with the
         * scheme a phone needs".
         */
        publicUrl: string;
        /**
         * Whether to bind loopback while the tunnel is up.
         *
         * On by default, and it is the point of the feature: with a tunnel the phone
         * never needs to reach this machine directly, so leaving the listener on a
         * LAN address exports it for no reason.
         */
        preferLoopback: boolean;
        reconnectBaseMs: number;
        reconnectMaxMs: number;
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
