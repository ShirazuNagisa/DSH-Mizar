/** Cordis 4 has no required/optional Inject syntax. Read optional services via
 * its documented ctx.get API, as the existing workspace and connection bridges do.
 * Direct property access is only a fallback for plain test/SDK context doubles. */
export function optionalService(ctx, name) {
    if (typeof ctx.get === 'function')
        return ctx.get(name);
    return ctx[name];
}
