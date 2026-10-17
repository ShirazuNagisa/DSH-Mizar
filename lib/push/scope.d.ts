/**
 * Which sessions a notification may be about.
 *
 * One rule, in its own file because it is a *policy* rather than a line of the
 * composition root, and because a policy nobody can call is a policy nobody can
 * test -- which is how it went wrong the first time.
 *
 * ### The rule
 *
 * A session that the phone does not draw a row for must not produce a
 * notification. That is the whole test, and it is deliberately phrased in terms
 * of what the app shows rather than in terms of what DSH calls a thing.
 *
 * Two kinds of session fail it:
 *
 *   - **A delegated child** carries `origin: 'subagent'`. It is the agent's own
 *     bookkeeping -- a subagent finishing is not a task the operator asked to be
 *     woken for -- and the app hides it.
 *   - **A fork** carries `parentSession` and an origin of nothing at all. It is
 *     not a delegated child; it is a session somebody deliberately branched, and
 *     DSH's own subagent routing uses `origin` alone for exactly that reason.
 *     But the app currently treats either field as "this is a child", so a fork
 *     has no row, and a notification about a session with no row opens the app
 *     onto a conversation the operator cannot find in their list.
 *
 * Matching the app's rule rather than DSH's is the conservative choice: a
 * notification the operator cannot act on is worse than a missing one, and the
 * two rules only differ for forks.
 *
 * @module dsh-mizar/push/scope
 */
/** As much of a session header as the filter reads. */
export interface ScopedSessionHeader {
    /** `'subagent'` for a delegated child. */
    readonly origin?: string;
    /** Set on a fork, and on a delegated child's own header. */
    readonly parentSession?: string;
}
/**
 * Whether a notification may be sent about this session.
 *
 * @param header - the session's header, as `ctx.sessions` or the event carries it.
 * @returns whether the phone would show a row for it.
 */
export declare function isNotifiable(header: ScopedSessionHeader | undefined): boolean;
/** As much of a session-list row as the idle check reads. */
export interface RunningSessionRow {
    /** Whether a turn is currently executing. */
    readonly running: boolean;
    /** `'subagent'` for a delegated child. */
    readonly origin: string | null;
    /** Set on a fork, and on a delegated child's own header. */
    readonly parentSessionId: string | null;
}
/**
 * Whether any session the phone draws a row for is still working.
 *
 * The one question that decides whether a finished turn may take the Live
 * Activity down with it: the island belongs to the work on screen, so a hidden
 * subagent or fork still running is not a reason to keep it up, and a visible
 * session still running is. Written over rows rather than headers because that
 * is the shape `listSessions` returns, and mapped through {@link isNotifiable}
 * so the two questions cannot disagree about which sessions are visible.
 *
 * @param rows - the session list, as `listSessions` returned it.
 * @returns whether the Mac is still working on something the phone shows.
 */
export declare function anyNotifiableSessionRunning(rows: readonly RunningSessionRow[]): boolean;
