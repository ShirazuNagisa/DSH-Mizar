/**
 * Workspace bridge.
 *
 * DSH's workspace list is **not** the session list. It lives in the host's own
 * workspace registry, and a session outlives the workspace it was created in:
 * deleting a workspace removes the registry entry and leaves the session log on
 * disk, so `session/list` keeps returning sessions whose `cwd` is a directory
 * DSH no longer has a workspace for.
 *
 * That is invisible from the phone, which has no other way to learn about
 * workspaces, so it drew one row per working directory any session had ever
 * used. Measured on the machine this was reported from: DSH had **4**
 * workspaces and the phone showed **10**, because six of them had been deleted
 * and their sessions had not.
 *
 * `workspace` has no `list` endpoint — the list is published through
 * `workspace/follow`, a stream whose first frame is a complete baseline. That is
 * what this reads: one frame, then the iterator is closed. Following the stream
 * for updates would keep the list live, and is worth doing when a workspace can
 * be deleted while the phone has the app open; today the phone re-reads on every
 * refresh, which is often enough for a change an operator makes on the Mac.
 *
 * @module dsh-mizar/bridge/workspaces
 */
import type { Context } from '../dsh.js'

/** One workspace, as much of it as the phone needs. */
export interface WorkspaceRow {
  readonly workspaceId: string
  /** The directory the workspace is rooted at. This is what the phone matches on. */
  readonly path: string
  /** What DSH calls it. */
  readonly title: string
}

/** Everything a caller gets back. */
export interface WorkspaceListResult {
  readonly items: readonly WorkspaceRow[]
}

/** How long to wait for the baseline frame before giving up. */
const FOLLOW_TIMEOUT_MS = 5_000

/**
 * One string field, or `null` when it is missing or not a string.
 *
 * @param record - the object to read.
 * @param key - the field.
 * @returns the value, or `null`.
 */
function str(record: Record<string, unknown>, key: string): string | null {
  const value = record[key]
  return typeof value === 'string' && value !== '' ? value : null
}

/**
 * Narrow one workspace entry from the follow frame.
 *
 * @param value - the entry.
 * @returns the row, or `null` when it is not shaped like one.
 */
function toRow(value: unknown): WorkspaceRow | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const workspaceId = str(record, 'workspaceId')
  const path = str(record, 'path')
  if (workspaceId === null || path === null) return null
  return { workspaceId, path, title: str(record, 'title') ?? path }
}

/**
 * List the workspaces DSH has, by directory.
 *
 * Returns an empty list rather than throwing when the stream cannot be read.
 * The phone already draws workspaces without this — by grouping sessions on
 * their working directory — and an empty answer means "keep doing that". A
 * failure here must not be able to remove a workspace somebody is using.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @returns the rows, oldest-first order as DSH reports it.
 */
export async function listWorkspaces(ctx: Context): Promise<WorkspaceListResult> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FOLLOW_TIMEOUT_MS)
  try {
    const iterable = await ctx.typertGateway.stream({
      namespace: 'workspace',
      method: 'follow',
      args: {},
      signal: controller.signal,
    })
    const iterator = iterable[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      const frame = first.value as { type?: unknown; value?: unknown } | undefined
      // Only the baseline carries the whole list. An `upsert` or `remove`
      // arriving first would mean the stream started mid-change, and building a
      // list from a delta is how a workspace silently disappears.
      if (frame === undefined || frame.type !== 'baseline') return { items: [] }
      const baseline = frame.value as { items?: unknown } | undefined
      const raw = Array.isArray(baseline?.items) ? baseline.items : []
      const items = raw.map(toRow).filter((row): row is WorkspaceRow => row !== null)
      return { items }
    } finally {
      // Closes the stream. Without it the subscription outlives the request,
      // and one of these per refresh is a leak that only shows up after an hour
      // of use.
      await iterator.return?.()
    }
  } catch {
    return { items: [] }
  } finally {
    clearTimeout(timer)
  }
}
