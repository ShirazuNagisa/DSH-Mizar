import { streamRemote } from './invoke.js';
import { MethodError } from './method-error.js';
/** How long to wait for the baseline frame before giving up. */
const FOLLOW_TIMEOUT_MS = 5_000;
/**
 * One string field, or `null` when it is missing or not a string.
 *
 * @param record - the object to read.
 * @param key - the field.
 * @returns the value, or `null`.
 */
function str(record, key) {
    const value = record[key];
    return typeof value === 'string' && value !== '' ? value : null;
}
/**
 * The session ids of one workspace entry.
 *
 * @param value - the raw field.
 * @returns the ids, or `undefined` when the entry did not carry a list at all.
 */
function ids(value) {
    if (!Array.isArray(value))
        return undefined;
    return value.filter((id) => typeof id === 'string' && id !== '');
}
/**
 * Narrow one workspace entry from a follow frame.
 *
 * @param value - the entry.
 * @returns the row, or `null` when it is not shaped like one.
 */
function toRow(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const record = value;
    const workspaceId = str(record, 'workspaceId');
    const path = str(record, 'path');
    if (workspaceId === null || path === null)
        return null;
    const sessionIds = ids(record['sessionIds']);
    return {
        workspaceId,
        path,
        title: str(record, 'title') ?? path,
        ...(sessionIds === undefined ? {} : { sessionIds }),
    };
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
function fromEntity(entity) {
    const workspaceId = typeof entity.id === 'string' && entity.id !== '' ? entity.id : null;
    const path = typeof entity.path === 'string' && entity.path !== '' ? entity.path : null;
    if (workspaceId === null || path === null)
        return null;
    const title = typeof entity.title === 'string' ? entity.title : '';
    const sessionIds = ids(entity.sessionIds);
    return {
        workspaceId,
        path,
        title: title === '' ? path : title,
        ...(sessionIds === undefined ? {} : { sessionIds }),
    };
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
function narrowAll(raw, narrow) {
    const rows = [];
    for (const value of raw) {
        const row = narrow(value);
        if (row === null)
            return null;
        rows.push(row);
    }
    return rows;
}
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
function registryOf(ctx) {
    const registry = ctx.get?.('workspaceRegistry');
    if (registry === null || typeof registry !== 'object')
        return null;
    const candidate = registry;
    return typeof candidate.create === 'function' ? registry : null;
}
/**
 * The workspace registry, when it is new enough to archive sessions.
 *
 * Separate from {@link registryOf} because the two are different questions. A
 * registry from before archival existed can still list workspaces, and the list
 * has no fallback for hiding archived sessions; archival has no fallback at
 * all. Answering `{archived: true}` from a host that cannot archive would tell
 * the phone a session left the computer's list when it did not, so this is the
 * one registry read that ends in a refusal instead of another service's answer.
 *
 * @param ctx - a context observing `ctx.workspaceRegistry`.
 * @returns the registry, or `null` when this composition cannot archive.
 */
function archivingRegistryOf(ctx) {
    const registry = registryOf(ctx);
    if (registry === null)
        return null;
    const candidate = registry;
    return typeof candidate.archiveSession === 'function' ? registry : null;
}
/**
 * The session ids DSH has archived, or `null` when this composition cannot say.
 *
 * The archive set is registry-global (`WorkspaceRegistry.archivedSessionIds`),
 * not a property of any workspace: archiving hides a session from every
 * grouping surface while leaving its workspace accounting untouched, which is
 * what lets unarchiving restore the position it had. So the phone's list
 * methods have to apply it at the wire boundary -- DSH's own session list still
 * returns those rows, and the computer's sidebar filters them itself.
 *
 * `null` rather than an empty set for "this host cannot answer": a composition
 * without a registry keeps exactly the behaviour it had before this existed,
 * and failing the whole list over a filter whose absence can only ever show one
 * extra row would be a worse answer than the stale one.
 *
 * @param ctx - a context observing `ctx.workspaceRegistry`.
 * @returns the archived ids, or `null` when they cannot be read.
 */
export function archivedSessionIds(ctx) {
    const registry = registryOf(ctx);
    if (registry === null)
        return null;
    try {
        // Not narrowed by `WorkspaceRegistry`'s declared type: the point of the
        // check is the composition whose registry predates the getter, which the
        // type cannot express because the peer dependency is new enough to have it.
        const ids = registry.archivedSessionIds;
        if (!Array.isArray(ids))
            return null;
        return new Set(ids.filter((id) => typeof id === 'string' && id !== ''));
    }
    catch {
        return null;
    }
}
/**
 * Archive one session in DSH's own registry.
 *
 * Non-destructive on the host: the log stays, and so does the session's
 * workspace slot. All that changes is the registry-global archive set that
 * {@link listWorkspaces} and `listSessions` filter on -- which is why this is
 * the only call here and why a refusal must surface as one.
 *
 * Without `stopActivity`, DSH refuses to archive a session that is still
 * running, and that is the behaviour the phone relies on: archiving from a
 * long-press menu must not silently kill a turn somebody is watching. With it,
 * the registry writes the archive first and then asks the composed providers to
 * stop the work; the archive is never rolled back by a provider that fails.
 *
 * @param ctx - a context observing `ctx.workspaceRegistry`.
 * @param request - the session, and whether running work may be stopped.
 * @throws MethodError when this composition has no registry to archive in.
 */
export async function archiveSession(ctx, request) {
    const registry = archivingRegistryOf(ctx);
    if (registry === null) {
        throw new MethodError('REMOTE_ERROR', 'session.archive: this composition has no workspace registry to archive sessions in');
    }
    // The wire carries a plain id and the registry brand is only knowable here;
    // the registry validates existence itself, so the cast promises nothing this
    // layer could keep.
    await registry.archiveSession(request.sessionId, request.stopActivity ? { stopActivity: true } : undefined);
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
function readRegistry(ctx) {
    const registry = registryOf(ctx);
    // No service, or a service from before it had `list`: not a failure, just a
    // composition that answers this question somewhere else.
    if (registry === null || typeof registry.list !== 'function')
        return { kind: 'absent' };
    try {
        const entities = registry.list();
        if (!Array.isArray(entities))
            return { kind: 'failed' };
        const rows = narrowAll(entities, fromEntity);
        return rows === null ? { kind: 'failed' } : { kind: 'read', rows };
    }
    catch {
        return { kind: 'failed' };
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
async function listFromStream(ctx) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FOLLOW_TIMEOUT_MS);
    try {
        const iterable = await streamRemote(ctx, {
            namespace: 'workspace',
            method: 'follow',
            args: {},
            signal: controller.signal,
        });
        const iterator = iterable[Symbol.asyncIterator]();
        let rows = null;
        try {
            const first = await iterator.next();
            const frame = first.value;
            // Only the baseline carries the whole list. An `upsert` or `remove`
            // arriving first would mean the stream started mid-change, and building a
            // list from a delta is how a workspace silently disappears.
            if (frame === undefined || frame.type !== 'baseline')
                return null;
            const baseline = frame.value;
            const raw = Array.isArray(baseline?.items) ? baseline.items : [];
            rows = narrowAll(raw, toRow);
        }
        finally {
            // Closes the stream. Without it the subscription outlives the request,
            // and one of these per refresh is a leak that only shows up after an hour
            // of use.
            //
            // Best effort, like the history page's: a carrier that dies while being
            // closed must not throw away a list that was read successfully -- the
            // phone would keep the directory grouping this method exists to replace,
            // and it would be reported as "this host cannot answer".
            try {
                await iterator.return?.();
            }
            catch {
                /* the list was read; the subscription is the carrier's problem now */
            }
        }
        return rows;
    }
    catch {
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * One row with the archived sessions taken out of its membership.
 *
 * Absent membership stays absent: the source did not carry a list at all, and
 * turning that into `[]` would tell the phone "nothing is filed here" about a
 * workspace the host said nothing about. An empty *present* list is the real
 * "nothing is filed here", including the case where every session filed in the
 * workspace has been archived.
 *
 * @param row - the registry row.
 * @param archived - the ids to hide.
 * @returns the row as the phone should see it.
 */
function hideArchived(row, archived) {
    if (row.sessionIds === undefined)
        return row;
    return {
        ...row,
        sessionIds: row.sessionIds.filter((sessionId) => !archived.has(sessionId)),
    };
}
/**
 * List the workspaces DSH has, by directory.
 *
 * Returns an incomplete empty list rather than throwing when nothing can be
 * read. The phone already draws workspaces without this — by grouping sessions
 * on their working directory — and `complete: false` means "keep doing that". A
 * failure here must not be able to remove a workspace somebody is using.
 *
 * Archived sessions are filtered out of each row's `sessionIds`. That has to
 * happen at this boundary rather than in the registry, because DSH's archive
 * deliberately keeps the accounted slot: the membership is still true, it is
 * just no longer part of what any list should show. The stream fallback is only
 * reached without a registry -- which is a composition that cannot archive
 * either -- so its baseline is taken as it is.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @returns the rows, and whether they are the whole list.
 */
export async function listWorkspaces(ctx) {
    const registry = readRegistry(ctx);
    if (registry.kind === 'read') {
        const archived = archivedSessionIds(ctx);
        return {
            items: archived === null
                ? registry.rows
                : registry.rows.map((row) => hideArchived(row, archived)),
            complete: true,
        };
    }
    // A registry that is there and would not answer is the end of it: the stream
    // is a different service that may hold an older set, and "complete" is what
    // the phone deletes rows on. See `readRegistry`.
    if (registry.kind === 'failed')
        return { items: [], complete: false };
    const fromStream = await listFromStream(ctx);
    if (fromStream !== null)
        return { items: fromStream, complete: true };
    return { items: [], complete: false };
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
function samePath(left, right) {
    const trim = (value) => (value.length > 1 ? value.replace(/\/+$/, '') : value);
    return trim(left) === trim(right);
}
/**
 * The id of a registry entity, when it has one.
 *
 * @param value - the entity, or `undefined`.
 * @returns the id, or `null`.
 */
function idOf(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const id = value.id;
    return typeof id === 'string' && id !== '' ? id : null;
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
export async function resolveWorkspaceId(ctx, path) {
    const registry = registryOf(ctx);
    if (registry === null) {
        // No registry in this composition, so nothing can be created. The most this
        // can do is recognise a directory DSH already has a workspace for.
        const existing = (await listWorkspaces(ctx)).items.find((row) => samePath(row.path, path));
        return existing?.workspaceId ?? null;
    }
    if (typeof registry.resolveByPath === 'function') {
        try {
            // Canonical, and it does not create: this is the lookup, `create` below is
            // the fallback. A path that is not an existing directory rejects here and
            // again there, which is the answer the caller already handles.
            const found = idOf(await registry.resolveByPath(path));
            if (found !== null)
                return found;
        }
        catch {
            /* not an existing directory, or a registry that refused */
        }
    }
    else {
        // A registry from before `resolveByPath`, which the shipped one has had all
        // along -- so this is the older-composition path, not the common one.
        const existing = (await listWorkspaces(ctx)).items.find((row) => samePath(row.path, path));
        if (existing !== undefined)
            return existing.workspaceId;
    }
    try {
        const created = await registry.create(path);
        return idOf(created);
    }
    catch {
        // A path that is not a directory, or a registry that refused. The caller
        // falls back to passing the directory itself, which is what it did before
        // any of this existed: the session is still created, it is just not filed
        // anywhere the computer lists from.
        return null;
    }
}
