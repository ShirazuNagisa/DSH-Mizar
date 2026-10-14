/**
 * Readiness gates for the Mizar host half.
 *
 * Phase 0.1 established a non-obvious ordering fact by measurement: a plugin's
 * `apply()` runs during composition, but the shipped strict Typert descriptors
 * register **later**, so an immediate `ctx.typertGateway.invoke()` fails with
 * `gateway/invocation-unavailable`. Every consumer of the gateway therefore has
 * to gate on descriptor availability rather than on its own activation.
 *
 * @module dsh-mizar/ready
 */
import type { Context } from './dsh.js';
/** Options for {@link awaitEndpoints}. */
export interface AwaitEndpointsOptions {
    /** Total time to wait, in milliseconds. */
    readonly timeoutMs?: number;
    /** Poll interval, in milliseconds. */
    readonly intervalMs?: number;
    /** Optional abort signal that ends the wait early. */
    readonly signal?: AbortSignal;
}
/** Outcome of an {@link awaitEndpoints} wait. */
export interface EndpointsReady {
    /** Whether every requested endpoint was registered in time. */
    readonly ok: boolean;
    /** Endpoints observed at the end of the wait. */
    readonly present: readonly string[];
    /** Requested endpoints never observed. */
    readonly missing: readonly string[];
    /** Total number of local descriptors registered when the wait ended. */
    readonly registeredCount: number;
}
/**
 * List the strict endpoints currently registered on this environment.
 * @param ctx - any context observing `ctx.typert`.
 * @returns the registered endpoint keys.
 */
export declare function localEndpoints(ctx: Context): Set<string>;
/**
 * Wait until every named strict endpoint is registered.
 *
 * Returns whether the wait succeeded together with what was observed, so a
 * caller can report a precise diagnostic instead of a bare timeout.
 *
 * @param ctx - any context observing `ctx.typert`.
 * @param required - endpoint keys in `namespace/method` form.
 * @param options - wait bounds.
 * @returns the readiness outcome; never throws for a timeout.
 */
export declare function awaitEndpoints(ctx: Context, required: readonly string[], options?: AwaitEndpointsOptions): Promise<EndpointsReady>;
