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
 * Narrow one workspace entry from the follow frame.
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
    return { workspaceId, path, title: str(record, 'title') ?? path };
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
export async function listWorkspaces(ctx) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FOLLOW_TIMEOUT_MS);
    try {
        const iterable = await ctx.typertGateway.stream({
            namespace: 'workspace',
            method: 'follow',
            args: {},
            signal: controller.signal,
        });
        const iterator = iterable[Symbol.asyncIterator]();
        try {
            const first = await iterator.next();
            const frame = first.value;
            // Only the baseline carries the whole list. An `upsert` or `remove`
            // arriving first would mean the stream started mid-change, and building a
            // list from a delta is how a workspace silently disappears.
            if (frame === undefined || frame.type !== 'baseline')
                return { items: [] };
            const baseline = frame.value;
            const raw = Array.isArray(baseline?.items) ? baseline.items : [];
            const items = raw.map(toRow).filter((row) => row !== null);
            return { items };
        }
        finally {
            // Closes the stream. Without it the subscription outlives the request,
            // and one of these per refresh is a leak that only shows up after an hour
            // of use.
            await iterator.return?.();
        }
    }
    catch {
        return { items: [] };
    }
    finally {
        clearTimeout(timer);
    }
}
/** The workspace registry, when this composition has one. */
function registryOf(ctx) {
    // `get` rather than a property read: `ctx.workspaceRegistry` is only reachable
    // from a plugin that declared it in `inject`, and declaring it would make the
    // whole plugin wait for a service it uses in one place. A composition without
    // it loses nothing but the ability to invent a workspace -- sessions,
    // approvals, notifications and pairing all still work.
    const registry = ctx.get?.('workspaceRegistry');
    if (registry === null || typeof registry !== 'object')
        return null;
    const candidate = registry;
    return typeof candidate.create === 'function' ? registry : null;
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
 * The Mac's sidebar is built on workspaces, so it drew nothing. Reported as
 * "created a session on the phone, sent a message, the Mac never shows it".
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
    const existing = (await listWorkspaces(ctx)).items.find((row) => samePath(row.path, path));
    if (existing !== undefined)
        return existing.workspaceId;
    const registry = registryOf(ctx);
    if (registry === null)
        return null;
    try {
        const created = await registry.create(path);
        return typeof created?.id === 'string' && created.id !== '' ? created.id : null;
    }
    catch {
        // A path that is not a directory, or a registry that refused. The caller
        // falls back to passing the directory itself, which is what it did before
        // any of this existed: the session is still created, it is just not filed
        // anywhere the Mac lists from.
        return null;
    }
}
