/**
 * The method table.
 *
 * One place where wire method names map to bridge calls. Keeping it separate
 * from the listener is what lets `server/listener.ts` stay transport-only: it
 * moves frames and enforces authentication, and knows nothing about sessions.
 * Every DSH-shaped decision lives here or below.
 *
 * Every handler is wrapped by {@link guard}, so an upstream DSH failure leaves
 * as a code the app can branch on instead of a bare `INTERNAL`.
 *
 * @module dsh-mizar/bridge
 */
import type { Context } from '../dsh.js';
import { InteractionBroker } from './interactions.js';
/** Per-connection facts handed to a method. */
export interface MethodContext {
    /** The authenticated device's id. */
    readonly deviceId: string;
    /** The authenticated device's display name. */
    readonly deviceName: string;
    /** The remote address the request arrived from. */
    readonly remote: string;
}
/** A wire method implementation. */
export type MethodHandler = (payload: unknown, context: MethodContext) => Promise<unknown>;
/** What the bridge needs from its host to answer `host.info`. */
export interface HostFacts {
    readonly hostId: string;
    readonly hostName: string;
    readonly home: string;
    readonly protocolVersion: number;
}
/**
 * Build the method table for one plugin mount.
 *
 * @param ctx - the plugin context, used for every DSH call.
 * @param facts - host identity reported to clients.
 * @param broker - the interaction broker holding pending approvals and questions.
 * @returns the table, keyed by wire method name.
 */
export declare function createMethodTable(ctx: Context, facts: HostFacts, broker: InteractionBroker): Record<string, MethodHandler>;
