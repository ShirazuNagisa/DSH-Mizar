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
export declare function resolveWorkspaceId(ctx: Context, path: string): Promise<string | null>;
