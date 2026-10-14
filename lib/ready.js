/**
 * Build the `namespace/method` key a descriptor is addressed by.
 * @param descriptor - a registered descriptor.
 * @returns its endpoint key, or `undefined` when it carries no identity.
 */
function endpointKeyOf(descriptor) {
    if (typeof descriptor.endpoint === 'string')
        return descriptor.endpoint;
    const { namespace, method } = descriptor;
    if (typeof namespace === 'string' && typeof method === 'string')
        return `${namespace}/${method}`;
    return undefined;
}
/**
 * List the strict endpoints currently registered on this environment.
 * @param ctx - any context observing `ctx.typert`.
 * @returns the registered endpoint keys.
 */
export function localEndpoints(ctx) {
    const keys = new Set();
    for (const descriptor of ctx.typert.local.list()) {
        const key = endpointKeyOf(descriptor);
        if (key !== undefined)
            keys.add(key);
    }
    return keys;
}
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
export async function awaitEndpoints(ctx, required, options = {}) {
    const { timeoutMs = 60_000, intervalMs = 200, signal } = options;
    const deadline = Date.now() + timeoutMs;
    let registered = new Set();
    for (;;) {
        registered = localEndpoints(ctx);
        const missing = required.filter((endpoint) => !registered.has(endpoint));
        if (missing.length === 0) {
            return {
                ok: true,
                present: [...required],
                missing: [],
                registeredCount: registered.size,
            };
        }
        if (signal?.aborted === true || Date.now() >= deadline) {
            return {
                ok: false,
                present: required.filter((endpoint) => registered.has(endpoint)),
                missing,
                registeredCount: registered.size,
            };
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
}
