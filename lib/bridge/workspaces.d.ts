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
import type { Context } from '../dsh.js';
/** One workspace, as much of it as the phone needs. */
export interface WorkspaceRow {
    readonly workspaceId: string;
    /** The directory the workspace is rooted at. This is what the phone matches on. */
    readonly path: string;
    /** What DSH calls it. */
    readonly title: string;
}
/** Everything a caller gets back. */
export interface WorkspaceListResult {
    readonly items: readonly WorkspaceRow[];
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
export declare function listWorkspaces(ctx: Context): Promise<WorkspaceListResult>;
