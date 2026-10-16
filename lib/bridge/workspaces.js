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
