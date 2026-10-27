/**
 * The `service` channel: in-process services that have no Typert endpoint.
 *
 * Two of DSH's most useful reads are not Remote methods at all — the workspace
 * registry (`list`, `archiveSession`, `attachSession`) and the projection store
 * (`snapshot`, `onChanged`) are plain Cordis services. A plugin that only
 * proxied the gateway would leave the desktop unable to list workspaces or
 * archive a session, which is why this channel exists.
 *
 * ### Why an allowlist rather than "any service"
 *
 * `ctx.get(name)` returns whatever the composition registered, including
 * services that take no arguments but do destructive things. A name list is a
 * boundary a person can read; "any name the desktop asks for" is not. The list
 * is configuration, so adding a service is an edit — not a new plugin release,
 * which is the property that matters for the "no plugin update" requirement.
 *
 * ### What is refused
 *
 * Names outside the list, services that are not registered, and members that are
 * not callable. Members starting with `_` are refused too: they are private by
 * convention, and proxying them would make an implementation detail part of a
 * protocol.
 *
 * @module dsh-mizar/bridge/service
 */
import type { Context } from '../dsh.js';
/** A resolved service, as much of it as this module touches. */
type Service = Record<string, unknown>;
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
export declare function serviceOf(ctx: Context, name: string, allow: readonly string[]): Service | null;
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
export declare function callService(ctx: Context, name: string, method: string, args: readonly unknown[], allow: readonly string[]): Promise<unknown>;
export {};
