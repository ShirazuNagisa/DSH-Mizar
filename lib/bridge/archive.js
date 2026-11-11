import { serviceOf } from './service.js';
/** The service that owns the archive set. */
export const WORKSPACE_REGISTRY = 'workspaceRegistry';
/** The registry property holding every archived Session id. */
export const ARCHIVED_SESSION_IDS = 'archivedSessionIds';
/** The row fields a Session list uses for its id. */
function sessionIdOf(item) {
    if (typeof item !== 'object' || item === null)
        return null;
    const record = item;
    const id = record['sessionId'] ?? record['id'];
    return typeof id === 'string' && id !== '' ? id : null;
}
/**
 * Remove archived Sessions from a `session/list` result.
 *
 * @param ctx - the plugin context; the registry is read through it.
 * @param value - the result the gateway returned.
 * @param services - the configured service allowlist.
 * @returns the same object when nothing was dropped, a copy with the archived
 *   rows removed otherwise.
 */
export function withoutArchivedSessions(ctx, value, services) {
    if (!services.includes(WORKSPACE_REGISTRY))
        return value;
    const registry = serviceOf(ctx, WORKSPACE_REGISTRY, services);
    if (registry === null)
        return value;
    const archived = registry[ARCHIVED_SESSION_IDS];
    if (!Array.isArray(archived) || archived.length === 0)
        return value;
    const drop = new Set(archived.filter((id) => typeof id === 'string' && id !== ''));
    if (drop.size === 0)
        return value;
    if (typeof value !== 'object' || value === null)
        return value;
    const items = value.items;
    if (!Array.isArray(items))
        return value;
    const kept = items.filter((item) => {
        const id = sessionIdOf(item);
        return id === null || !drop.has(id);
    });
    if (kept.length === items.length)
        return value;
    return { ...value, items: kept };
}
