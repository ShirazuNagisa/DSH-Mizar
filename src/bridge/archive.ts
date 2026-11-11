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
import type { Context } from '../dsh.js'
import { serviceOf } from './service.js'

/** The service that owns the archive set. */
export const WORKSPACE_REGISTRY = 'workspaceRegistry'

/** The registry property holding every archived Session id. */
export const ARCHIVED_SESSION_IDS = 'archivedSessionIds'

/** The row fields a Session list uses for its id. */
function sessionIdOf(item: unknown): string | null {
  if (typeof item !== 'object' || item === null) return null
  const record = item as Record<string, unknown>
  const id = record['sessionId'] ?? record['id']
  return typeof id === 'string' && id !== '' ? id : null
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
export function withoutArchivedSessions(
  ctx: Context,
  value: unknown,
  services: readonly string[],
): unknown {
  if (!services.includes(WORKSPACE_REGISTRY)) return value
  const registry = serviceOf(ctx, WORKSPACE_REGISTRY, services)
  if (registry === null) return value
  const archived = registry[ARCHIVED_SESSION_IDS]
  if (!Array.isArray(archived) || archived.length === 0) return value

  const drop = new Set(archived.filter((id): id is string => typeof id === 'string' && id !== ''))
  if (drop.size === 0) return value
  if (typeof value !== 'object' || value === null) return value
  const items = (value as { items?: unknown }).items
  if (!Array.isArray(items)) return value

  const kept = items.filter((item) => {
    const id = sessionIdOf(item)
    return id === null || !drop.has(id)
  })
  if (kept.length === items.length) return value
  return { ...(value as Record<string, unknown>), items: kept }
}
