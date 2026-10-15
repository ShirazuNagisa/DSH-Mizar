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
export declare const BIND_MODES: readonly ["tailscale", "lan", "loopback", "addresses"];
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
         * DSH and Tailscale both start at login and nothing orders them, so a
         * one-shot decision can land on loopback and stay there. Waiting turns that
         * race into a delay.
         */
        waitForMs: number;
        /** How often to re-check the bind addresses once listening, in milliseconds. */
        pollMs: number;
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
        autoConnect: boolean;
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
        ensureStartOnLogin: boolean;
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
