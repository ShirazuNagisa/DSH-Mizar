/**
 * The Web panel's data API.
 *
 * Three exact routes under `/api`, registered on the shared authenticated
 * channel. They reuse DSH's own browser-session cookie rather than inventing a
 * second authentication scheme: the panel runs in the operator's already
 * authenticated browser, and the `/api` bridge's trust fence and cookie check
 * have already run by the time a handler is called.
 *
 * The routes are registered through `ctx.inject`, so a composition without a
 * browser carrier — headless, SDK, a bare test tree — still gets the whole
 * listener and bridge, just no panel. Requiring `connection` in the plugin's
 * `inject` would instead stop Mizar loading altogether on those surfaces.
 *
 * @module dsh-mizar/panel/api
 */
import type { Context } from '../dsh.js';
import type { MizarStore } from '../auth/store.js';
import type { BindPlan } from '../net/interfaces.js';
/**
 * Route paths.
 *
 * These carry the `/api` prefix themselves. The interface doc calls `path` an
 * "absolute path below `/api`", but the shipped registrations pass `/api/file`
 * and friends — the prefix is part of the path, and omitting it produces a
 * silent 404 with no registration error.
 */
export declare const PANEL_ROUTES: {
    readonly status: "/api/mizar.status";
    readonly pairing: "/api/mizar.pairing";
    readonly revoke: "/api/mizar.revoke";
};
/** What the panel needs from the running listener. */
export interface PanelHost {
    /** Every `host:port` the phone can dial. */
    readonly authorities: readonly string[];
    /** How many authenticated clients are connected. */
    readonly clientCount: number;
    /**
     * Issue a fresh pairing code.
     * @returns the code and its deadline.
     */
    issuePairingCode(): Promise<{
        code: string;
        display: string;
        expiresAt: number;
    }>;
    /**
     * Revoke one device and drop its live sessions.
     * @param deviceId - the device to revoke.
     * @returns whether a device was revoked.
     */
    revokeDevice(deviceId: string): Promise<boolean>;
}
/**
 * The reverse tunnel, read through getters.
 *
 * Getters because both the connection state and the room change while the panel
 * is open, and re-registering the routes on every change would be a worse way to
 * keep them current than reading them when a request arrives.
 */
export interface PanelRelay {
    readonly enabled: boolean;
    readonly state: {
        connected: boolean;
        room: string | null;
        lastError: string | null;
    };
    /** The base URL a phone should be paired against, or `null` before a room exists. */
    readonly pairBaseURL: string | null;
}
/** Wiring for the panel routes. */
export interface PanelOptions {
    readonly host: PanelHost;
    readonly store: MizarStore;
    readonly plan: BindPlan;
    readonly hostName: string;
    readonly protocolVersion: number;
    /** The reverse tunnel, or `null` when none is configured. */
    readonly relay: PanelRelay | null;
    /** Sink for operator-facing diagnostics. */
    readonly log: (message: string) => void;
}
/**
 * Register the panel's routes on the shared API channel.
 *
 * @param ctx - the plugin context.
 * @param options - host wiring.
 */
export declare function registerPanelApi(ctx: Context, options: PanelOptions): void;
