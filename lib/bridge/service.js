import { LINK_REFUSED, LinkError } from './errors.js';
/**
 * Read one in-process service, when it is allowed and present.
 *
 * `get` rather than a property read, for the same reason the 0.8.x bridge used
 * it: a plugin that declared the service in `inject` would refuse to activate in
 * a composition that does not have it, and every one of these is optional.
 *
 * @param ctx - the plugin context.
 * @param name - the service name the desktop asked for.
 * @param allow - the configured allowlist.
 * @returns the service, or `null` when it is not allowed or not registered.
 */
export function serviceOf(ctx, name, allow) {
    if (!allow.includes(name))
        return null;
    const getter = ctx.get;
    if (typeof getter !== 'function')
        return null;
    const service = getter.call(ctx, name);
    if (service === null || typeof service !== 'object')
        return null;
    return service;
}
/**
 * Call one method on an allowed service.
 *
 * The method is invoked with the service as `this`, because several of them are
 * class instances whose methods read private state.
 *
 * @param ctx - the plugin context.
 * @param name - the service name.
 * @param method - the method name.
 * @param args - positional arguments, already deserialised.
 * @param allow - the configured allowlist.
 * @returns whatever the method returned.
 * @throws LinkError when the service or method is not available.
 */
export async function callService(ctx, name, method, args, allow) {
    const service = serviceOf(ctx, name, allow);
    if (service === null) {
        throw new LinkError(LINK_REFUSED, allow.includes(name)
            ? `service "${name}" is not composed in this DSH profile`
            : `service "${name}" is not in the configured allowlist`);
    }
    if (method.startsWith('_')) {
        throw new LinkError(LINK_REFUSED, `service "${name}.${method}" is private`);
    }
    const member = service[method];
    if (typeof member !== 'function') {
        throw new LinkError(LINK_REFUSED, `service "${name}" has no method "${method}"`);
    }
    const result = await member.apply(service, [...args]);
    return result;
}
