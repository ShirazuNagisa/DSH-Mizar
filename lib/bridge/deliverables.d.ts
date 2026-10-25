/**
 * The files a turn handed to the operator.
 *
 * The desktop app draws a card under a turn's summary when the model called
 * `present` — "Declare existing files as final deliverables for the user" — with
 * `{files: [{path, description?}]}`. That call is a `tool/call` record, and
 * `session.messages` drops every `tool/call` on purpose (see
 * {@link summaryRecords}): a page carries summaries, not a transcript, and tool
 * traffic is the largest thing in a log. So the phone could never draw those
 * cards, and the operator's only route to a delivered document was to read its
 * name in prose and go find it on the computer.
 *
 * This module reads the calls out of one complete turn's window and hands back
 * the list, which `session.messages` then attaches to that turn's `turn/end`
 * record as `mizarDeliverables`. It is deliberately narrow:
 *
 *   - **Only `present`.** Not "any tool that names a file": `write`, `edit` and
 *     `read` name files constantly, and a card per edited file would turn the
 *     end of every turn into a directory listing. `present` exists precisely to
 *     say "this one is for you".
 *   - **Arguments are a JSON string.** They arrive as text, not an object, and
 *     a truncated or malformed one must not fail the page — the turn still has
 *     an answer to show. A call that cannot be parsed is skipped.
 *   - **Paths stay as the model wrote them.** Relative to the session's working
 *     directory is what the tool's schema says, and resolving them here would
 *     put the host's directory layout on the wire. The reader
 *     (`bridge/files.ts`) resolves and confines them at read time.
 *
 * @module dsh-mizar/bridge/deliverables
 */
/** One file a turn declared as a deliverable. */
export interface DeliveredFile {
    /** The path as the model wrote it: relative to the session's working directory, or absolute. */
    readonly path: string;
    /** The one-line description the model wrote for the operator, when it wrote one. */
    readonly description?: string;
}
/**
 * The deliverables declared inside one turn's events.
 *
 * Later declarations win: a turn that presents the same report twice (a first
 * draft, then a corrected one) is describing one file, and the description that
 * survives should be the one written last.
 *
 * @param events - one complete turn's events, oldest first, as `turnWindows` builds them.
 * @returns the files, in the order they were presented, at most {@link MAX_DELIVERABLES}.
 */
export declare function deliverablesOf(events: readonly Record<string, unknown>[]): DeliveredFile[];
