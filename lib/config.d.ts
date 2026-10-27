/**
 * Configuration for the 0.9.0 helper plugin.
 *
 * The 0.8.x schema described a server: a port, a bind policy, a relay, a push
 * service, pairing limits, TLS. None of that exists here any more — the desktop
 * app owns every one of those decisions now, and this plugin is a pipe that
 * dials it. What is left is where to find the desktop, which in-process services
 * may be proxied, and how hard to retry.
 *
 * @module dsh-mizar/config
 */
import z from '@deepseek-ai/schemastery';
/**
 * Where the desktop app publishes its loopback port and per-launch token.
 *
 * The desktop writes this file (`0600`, or the user's profile ACL on Windows)
 * before it starts serving, and rewrites it on every launch — the token is
 * minted per launch, so a stale file is a stale credential that the desktop
 * rejects.
 */
export declare const DEFAULT_ENDPOINT_FILE = "~/.agi-mizar/endpoint.json";
/**
 * In-process services the desktop may call through the `service` frame.
 *
 * These are the reads that have no Typert endpoint: the workspace registry, the
 * session registry, the projection store, and the two interaction services. A
 * deployment that needs another one adds its name here — a configuration edit,
 * not a new plugin version.
 */
export declare const DEFAULT_SERVICES: readonly ["workspaceRegistry", "sessions", "sessionProjections", "userApproval", "userQuestions"];
export interface Config {
    /** Turn the plugin off without uninstalling it. */
    enabled: boolean;
    /** The desktop's endpoint file. */
    endpointFile: string;
    /** In-process services the desktop may reach. */
    services: string[];
    reconnect: {
        /** First retry delay, in milliseconds. */
        baseMs: number;
        /** Retry ceiling, in milliseconds. */
        maxMs: number;
        /** Ping cadence; two silent intervals end the socket. */
        heartbeatMs: number;
    };
    /** Print every forwarded event on stdout. Diagnostics only; very noisy. */
    logEvents: boolean;
}
export declare const Config: z<Config>;
