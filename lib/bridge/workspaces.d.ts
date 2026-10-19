import type { Context } from '../dsh.js';
/** One workspace, as much of it as the phone needs. */
export interface WorkspaceRow {
    readonly workspaceId: string;
    /** The directory the workspace is rooted at. DSH's `fs.realpath` of it. */
    readonly path: string;
    /** What DSH calls it. */
    readonly title: string;
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
    readonly sessionIds?: readonly string[];
}
/** Everything a caller gets back. */
export interface WorkspaceListResult {
    readonly items: readonly WorkspaceRow[];
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
    readonly complete: boolean;
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
export declare function archivedSessionIds(ctx: Context): ReadonlySet<string> | null;
/** One archive request, already narrowed from the wire payload. */
export interface ArchiveSessionRequest {
    readonly sessionId: string;
    /** Ask the host to stop the session's running work instead of refusing it. */
    readonly stopActivity: boolean;
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
export declare function archiveSession(ctx: Context, request: ArchiveSessionRequest): Promise<void>;
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
export declare function resolveWorkspaceId(ctx: Context, path: string): Promise<string | null>;
