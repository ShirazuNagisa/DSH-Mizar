/**
 * Hide archived sessions from the one read the desktop uses to list them.
 *
 * DSH's `session/list` returns every Session it knows, archived ones included;
 * the DSH GUI filters them with `workspaceRegistry.archivedSessionIds`, a
 * service property that is not a Remote endpoint. The desktop has no access to
 * that registry — it is a DSH service, not part of the gateway — so the bridge
 * filters the result it proxies.
 *
 * Without this, a Session archived on the computer keeps answering
 * `session/list`, and the phone keeps drawing it after every refresh: "refresh"
 * re-reads the same list the desktop was given.
 *
 * The filter is a pass-through whenever the registry is absent or the archive
 * set is empty, so a host without the service behaves exactly as before.
 *
 * @module dsh-mizar/bridge/archive
 */
import type { Context } from '../dsh.js';
/** The service that owns the archive set. */
export declare const WORKSPACE_REGISTRY = "workspaceRegistry";
/** The registry property holding every archived Session id. */
export declare const ARCHIVED_SESSION_IDS = "archivedSessionIds";
/**
 * Remove archived Sessions from a `session/list` result.
 *
 * @param ctx - the plugin context; the registry is read through it.
 * @param value - the result the gateway returned.
 * @param services - the configured service allowlist.
 * @returns the same object when nothing was dropped, a copy with the archived
 *   rows removed otherwise.
 */
export declare function withoutArchivedSessions(ctx: Context, value: unknown, services: readonly string[]): unknown;
