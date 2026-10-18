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
 * used. Reported twice from the same phone. The first time it was the session
 * list: DSH had **4** workspaces and the phone showed **10**. The second time it
 * was the new-session picker, which offered every one of those ten directories
 * as a place to start work — "手机app中有许多电脑端dsh已经删除的工作区".
 *
 * **Where the list comes from, and why it changed.** It used to be read from
 * `workspace/follow`, a stream whose first frame is a complete baseline, because
 * `workspace` has no `list` endpoint. The registry service itself does have one —
 * `ctx.workspaceRegistry.list()` — and it is a synchronous projection of exactly
 * the records the computer's own sidebar draws, in DSH's display order, with each
 * workspace's **validated session membership** already computed against the
 * canonical-cwd header index.
 *
 * That membership is the part that matters. Matching a session to a workspace by
 * comparing path strings puts the phone in the business of guessing which of two
 * spellings of one directory is the real one — `/tmp/x` and `/private/tmp/x` are
 * the same directory on macOS and are not the same string — and guessing wrong
 * hides a conversation or draws a workspace that is gone. Asking the host is
 * both cheaper and correct.
 *
 * The stream is kept as the fallback for a composition whose registry is absent
 * or too old to have `list` — not for one whose registry exists and would not
 * answer, because those are different authorities and a failure of the durable
 * one is not grounds for handing the phone another service's opinion labelled
 * complete. `complete` says which of them answered. A phone that is told
 * `complete` may *replace* what it holds, including with nothing; one that is
 * not must only ever add, because "this host cannot say" and "this host has
 * none" look identical from an empty array.
 *
 * @module dsh-mizar/bridge/workspaces
 */
import type { Workspace, WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import type { Context } from '../dsh.js'
import { streamRemote } from './invoke.js'

/** One workspace, as much of it as the phone needs. */
export interface WorkspaceRow {
  readonly workspaceId: string
  /** The directory the workspace is rooted at. DSH's `fs.realpath` of it. */
  readonly path: string
  /** What DSH calls it. */
  readonly title: string
  /**
   * The sessions DSH has filed under it, in DSH's order.
   *
   * Not derivable from the session list: membership requires both a slot in the
   * workspace's account and a session header whose canonical cwd equals the
   * workspace path, and a session created with a bare directory has neither.
   *
   * Omitted -- not empty -- when the source did not carry the field at all,
   * because the two mean different things to a phone deciding what belongs
   * where: an empty list is DSH saying "nothing is filed here", and no list is
   * DSH saying nothing, which leaves the phone matching on the path.
   */
  readonly sessionIds?: readonly string[]
}

/** Everything a caller gets back. */
export interface WorkspaceListResult {
  readonly items: readonly WorkspaceRow[]
  /**
   * Whether `items` is the host's whole list.
   *
   * `false` means the list could not be read, not that it is empty. The phone
   * needs the difference: it draws what it is given either way, but only a
   * complete list lets it drop a workspace that is no longer there.
   *
   * Only ever `true` for a list that was read in full. An entry this bridge
   * cannot make sense of is reported as no answer at all rather than as a
   * shorter list, because a shorter list is what the phone deletes rows from.
   */
  readonly complete: boolean
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
 * The session ids of one workspace entry.
 *
 * @param value - the raw field.
 * @returns the ids, or `undefined` when the entry did not carry a list at all.
 */
function ids(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((id): id is string => typeof id === 'string' && id !== '')
}

/**
 * Narrow one workspace entry from a follow frame.
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
  const sessionIds = ids(record['sessionIds'])
  return {
    workspaceId,
    path,
    title: str(record, 'title') ?? path,
    ...(sessionIds === undefined ? {} : { sessionIds }),
  }
}

/**
 * Narrow one registry entity.
 *
 * The entity's shape is DSH's, declared in `@deepseek-ai/dsh-workspace` and
 * reached through the declaration merge in `src/dsh.ts` — so this narrows a
 * `Workspace`, not a guess at one, and a rename there is a compile error here
 * rather than a silent fall back to path matching.
 *
 * @param entity - the entity.
 * @returns the row, or `null` when it is not shaped like one.
 */
function fromEntity(entity: Workspace): WorkspaceRow | null {
  const workspaceId = typeof entity.id === 'string' && entity.id !== '' ? entity.id : null
  const path = typeof entity.path === 'string' && entity.path !== '' ? entity.path : null
  if (workspaceId === null || path === null) return null
  const title = typeof entity.title === 'string' ? entity.title : ''
  const sessionIds = ids(entity.sessionIds)
  return {
    workspaceId,
    path,
    title: title === '' ? path : title,
    ...(sessionIds === undefined ? {} : { sessionIds }),
  }
}

/**
 * Narrow every entry of a list, or nothing at all.
 *
 * Deliberately all-or-nothing. The rows are reported as *complete*, and the
 * phone acts on that by replacing what it holds — so a row this code fails to
 * understand is a workspace that silently disappears from both screens, and
 * from the list of places a session can be started. Dropping it is the one
 * failure mode worse than not answering: "I could not read this" is a question
 * the phone already knows how to handle, and it is the safe answer.
 *
 * @param raw - the entries.
 * @param narrow - how to read one entry.
 * @returns the rows, or `null` when any entry could not be read.
 */
function narrowAll<T>(
  raw: readonly T[],
  narrow: (value: T) => WorkspaceRow | null,
): WorkspaceRow[] | null {
  const rows: WorkspaceRow[] = []
  for (const value of raw) {
    const row = narrow(value)
    if (row === null) return null
    rows.push(row)
  }
  return rows
}

/** What asking the registry produced. */
type RegistryRead =
  /** The registry answered, in full. */
  | { readonly kind: 'read'; readonly rows: WorkspaceRow[] }
  /** This composition has no registry service to ask. */
  | { readonly kind: 'absent' }
  /** There is a registry, and it could not be read. */
  | { readonly kind: 'failed' }

/**
 * The workspace registry, when this composition has one.
 *
 * `get` rather than a property read: `ctx.workspaceRegistry` is only reachable
 * from a plugin that declared it in `inject`, and declaring it would make the
 * whole plugin wait for a service it uses in one place. A composition without
 * it loses the registry reads and nothing else -- sessions, approvals,
 * notifications and pairing all still work, and the stream still answers.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @returns the registry, or `null`.
 */
function registryOf(ctx: Context): WorkspaceRegistry | null {
  const registry = (ctx as unknown as { get?: (name: string) => unknown }).get?.('workspaceRegistry')
  if (registry === null || typeof registry !== 'object') return null
  const candidate = registry as { create?: unknown }
  return typeof candidate.create === 'function' ? (registry as WorkspaceRegistry) : null
}

/**
 * The registry's own list.
 *
 * Synchronous, so there is no timeout and nothing to await: the registry
 * publishes a fresh array from an in-memory index it maintains on every write.
 *
 * The three outcomes are kept apart, and that is the point. "There is no
 * registry here" means the stream is the authority and its baseline is the
 * answer. "There is one and it would not answer" must **not** quietly become the
 * stream's answer: the registry is the durable record and the stream is a
 * separate service, so a failure here falls back to a *different* opinion that
 * may be older -- and it would be handed to the phone as complete, which is the
 * authority it deletes rows with. A registry that cannot be read is reported as
 * no answer, and the next refresh tries again.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @returns what was read, or why not.
 */
function readRegistry(ctx: Context): RegistryRead {
  const registry = registryOf(ctx)
  // No service, or a service from before it had `list`: not a failure, just a
  // composition that answers this question somewhere else.
  if (registry === null || typeof registry.list !== 'function') return { kind: 'absent' }
  try {
    const entities = registry.list()
    if (!Array.isArray(entities)) return { kind: 'failed' }
    const rows = narrowAll(entities, fromEntity)
    return rows === null ? { kind: 'failed' } : { kind: 'read', rows }
  } catch {
    return { kind: 'failed' }
  }
}

/**
 * Read the list from `workspace/follow`'s baseline frame.
 *
 * One frame, then the iterator is closed. Following the stream for updates would
 * keep the list live, and is worth doing when a workspace can be deleted while
 * the phone has the app open; today the phone re-reads on every refresh, which
 * is often enough for a change an operator makes on the computer.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @returns the rows, or `null` when the baseline did not arrive.
 */
async function listFromStream(ctx: Context): Promise<WorkspaceRow[] | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FOLLOW_TIMEOUT_MS)
  try {
    const iterable = await streamRemote(ctx, {
      namespace: 'workspace',
      method: 'follow',
      args: {},
      signal: controller.signal,
    })
    const iterator = iterable[Symbol.asyncIterator]()
    let rows: WorkspaceRow[] | null = null
    try {
      const first = await iterator.next()
      const frame = first.value as { type?: unknown; value?: unknown } | undefined
      // Only the baseline carries the whole list. An `upsert` or `remove`
      // arriving first would mean the stream started mid-change, and building a
      // list from a delta is how a workspace silently disappears.
      if (frame === undefined || frame.type !== 'baseline') return null
      const baseline = frame.value as { items?: unknown } | undefined
      const raw = Array.isArray(baseline?.items) ? baseline.items : []
      rows = narrowAll(raw, toRow)
    } finally {
      // Closes the stream. Without it the subscription outlives the request,
      // and one of these per refresh is a leak that only shows up after an hour
      // of use.
      //
      // Best effort, like the history page's: a carrier that dies while being
      // closed must not throw away a list that was read successfully -- the
      // phone would keep the directory grouping this method exists to replace,
      // and it would be reported as "this host cannot answer".
      try {
        await iterator.return?.()
      } catch {
        /* the list was read; the subscription is the carrier's problem now */
      }
    }
    return rows
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * List the workspaces DSH has, by directory.
 *
 * Returns an incomplete empty list rather than throwing when nothing can be
 * read. The phone already draws workspaces without this — by grouping sessions
 * on their working directory — and `complete: false` means "keep doing that". A
 * failure here must not be able to remove a workspace somebody is using.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @returns the rows, and whether they are the whole list.
 */
export async function listWorkspaces(ctx: Context): Promise<WorkspaceListResult> {
  const registry = readRegistry(ctx)
  if (registry.kind === 'read') return { items: registry.rows, complete: true }
  // A registry that is there and would not answer is the end of it: the stream
  // is a different service that may hold an older set, and "complete" is what
  // the phone deletes rows on. See `readRegistry`.
  if (registry.kind === 'failed') return { items: [], complete: false }

  const fromStream = await listFromStream(ctx)
  if (fromStream !== null) return { items: fromStream, complete: true }

  return { items: [], complete: false }
}

/**
 * Two spellings of the same directory.
 *
 * Compared with trailing slashes removed, not resolved: DSH stores the
 * `fs.realpath` of a workspace, and the paths that arrive here came out of a
 * session header, which DSH wrote from a workspace path in the first place. A
 * full `realpath` would need the filesystem, and being wrong about this costs a
 * redundant lookup that the registry answers from its own records anyway.
 *
 * @param left - one path.
 * @param right - the other.
 * @returns whether they name the same directory.
 */
function samePath(left: string, right: string): boolean {
  const trim = (value: string): string => (value.length > 1 ? value.replace(/\/+$/, '') : value)
  return trim(left) === trim(right)
}

/**
 * The id of a registry entity, when it has one.
 *
 * @param value - the entity, or `undefined`.
 * @returns the id, or `null`.
 */
function idOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const id = (value as { id?: unknown }).id
  return typeof id === 'string' && id !== '' ? id : null
}

/**
 * The workspace a directory belongs to, creating one when DSH has none.
 *
 * **Why this exists.** DSH attaches a session to a workspace in exactly one
 * place: `session/create`, and only when the request names a `workspaceId`.
 * With a bare `cwd` it creates the session and attaches nothing —
 *
 *     const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
 *     ...
 *     if (workspace !== undefined) await workspace.attachSession(sessionId)
 *
 * — and a workspace's session list is membership, not a directory scan. So a
 * session created from the phone with a `cwd` belongs to no workspace, which the
 * phone cannot tell: it groups by working directory and drew the session anyway.
 * The computer's sidebar is built on workspaces, so it drew nothing. Reported as
 * "created a session on the phone, sent a message, the computer never shows it".
 *
 * Creating the workspace when there is none is what DSH's own desktop does when
 * somebody opens a folder: a session has to live somewhere, and "somewhere DSH
 * does not know about" is not a place it can be shown from.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param path - the directory the session was asked for.
 * @returns the workspace id, or `null` when one could not be resolved.
 */
export async function resolveWorkspaceId(ctx: Context, path: string): Promise<string | null> {
  const registry = registryOf(ctx)
  if (registry === null) {
    // No registry in this composition, so nothing can be created. The most this
    // can do is recognise a directory DSH already has a workspace for.
    const existing = (await listWorkspaces(ctx)).items.find((row) => samePath(row.path, path))
    return existing?.workspaceId ?? null
  }

  if (typeof registry.resolveByPath === 'function') {
    try {
      // Canonical, and it does not create: this is the lookup, `create` below is
      // the fallback. A path that is not an existing directory rejects here and
      // again there, which is the answer the caller already handles.
      const found = idOf(await registry.resolveByPath(path))
      if (found !== null) return found
    } catch {
      /* not an existing directory, or a registry that refused */
    }
  } else {
    // A registry from before `resolveByPath`, which the shipped one has had all
    // along -- so this is the older-composition path, not the common one.
    const existing = (await listWorkspaces(ctx)).items.find((row) => samePath(row.path, path))
    if (existing !== undefined) return existing.workspaceId
  }

  try {
    const created = await registry.create(path)
    return idOf(created)
  } catch {
    // A path that is not a directory, or a registry that refused. The caller
    // falls back to passing the directory itself, which is what it did before
    // any of this existed: the session is still created, it is just not filed
    // anywhere the computer lists from.
    return null
  }
}
