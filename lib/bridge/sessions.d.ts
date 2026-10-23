import type { Context } from '../dsh.js';
import { type ContextPressureView, type SessionStatsFrame } from './stats.js';
import { type PromptAttachment } from './uploads.js';
/** One row in the session list. */
export interface SessionRow {
    readonly sessionId: string;
    /** Last activity, epoch milliseconds. */
    readonly updatedAt: number;
    /** Whether a turn is currently executing. */
    readonly running: boolean;
    /** Whether the session has no user prompt yet. */
    readonly blank: boolean;
    /** Whether an agent can be resolved for it. */
    readonly agentAvailable: boolean;
    /** The session's working directory, when recorded. */
    readonly cwd: string | null;
    /** Present when this row is a subagent. */
    readonly parentSessionId: string | null;
    /** `'subagent'` for delegated children. */
    readonly origin: string | null;
}
/** A session's usage frame plus where it was read from. */
export interface SessionStatsResult {
    readonly sessionId: string;
    /** The log cursor the frame reflects; `null` when the session is unknown. */
    readonly asOfSeq: number | null;
    readonly stats: SessionStatsFrame | null;
}
/** The projection key set requested for one session. */
export declare const SESSION_PROJECTION_KEYS: readonly ["tokenUsage", "contextPressure", "contextBreakdown", "sessionStats", "modelSelection", "permissions", "title"];
/**
 * List the sessions DSH would show, newest activity first.
 *
 * Sessions DSH has archived are left out. DSH's `session/list` does not know
 * about the archive set -- that lives in the workspace registry, and the
 * computer's own sidebar filters it itself -- so a phone drawing the raw list
 * would keep showing rows the operator has already put away on the computer.
 * The set is read at this boundary rather than inside the registry because
 * archiving deliberately keeps the session everywhere else (log, workspace
 * slot) and only hides it from the surfaces that draw lists. A composition
 * without a registry keeps the unfiltered list it had before: it cannot archive
 * either.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @returns the rows.
 */
export declare function listSessions(ctx: Context): Promise<{
    items: SessionRow[];
}>;
/**
 * Read one session's usage frame.
 *
 * Works for a cold session: the projection read does not activate an agent.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to read.
 * @returns the frame, or `null` stats when the session is unknown.
 */
export declare function sessionStats(ctx: Context, sessionId: string): Promise<SessionStatsResult>;
/**
 * Read a page of a session's log.
 *
 * See {@link readLogPage} for the two reads behind the cut. The reply is
 * narrowed by {@link summaryRecords} to what the conversation screen draws,
 * filtered to what the phone does not already hold, and then trimmed to what
 * fits by {@link withinBudget}.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to read.
 * @param maxMessages - how many messages to ask for.
 * @param beforeSeq - the exclusive upper bound, for paging backwards.
 * @param afterSeq - the log position the caller already holds; only records
 *   after it travel. Ignored together with `beforeSeq`, because a page paged
 *   backwards is not a page of new records.
 * @param parentSessionId - the parent of a delegated child. Supplying it is what
 *   makes a child's history readable at all: without it the host refuses the
 *   read outright (`session/agent-busy`), because a child is not addressable as
 *   a session. See {@link logAddress}.
 * @returns the page, or no records when the session is unknown.
 */
export declare function sessionMessages(ctx: Context, sessionId: string, maxMessages?: number, beforeSeq?: number, afterSeq?: number, parentSessionId?: string): Promise<SessionMessagesResult>;
/** One page of a session's log. */
export interface SessionMessagesResult {
    readonly sessionId: string;
    /**
     * The log cut the page was taken at; `null` when the session is unknown.
     *
     * The follow opening frame's `cursor` normally, and the projections
     * `asOfSeq` when the stream could not answer. Both are positions in the same
     * log and the app passes it back as the next page's `beforeSeq`.
     */
    readonly asOfSeq: number | null;
    /**
     * The records the conversation screen draws, in the log's order.
     *
     * Not the whole page: see {@link summaryRecords} for what is kept and why.
     * Individual records are passed through exactly as the host reported them --
     * event names are merge-extensible by design, so the set of record shapes is
     * open and reshaping them here would mean this plugin has to be redeployed
     * whenever DSH adds one.
     */
    readonly records: readonly unknown[];
    readonly hasMore: boolean;
    /**
     * Context-window occupancy and its breakdown, as of this read.
     *
     * Always present: every page carries it, full and incremental both, so the
     * figure above the composer updates with whatever refresh the screen runs
     * rather than only with a separate `session.stats` read an incremental
     * refresh never makes. Same derivation as `session.stats`'s `context` field
     * (see the `buildContextPressure` call in {@link readLogPage}); `null` when
     * the host has no `contextPressure` projection to answer from -- absent is
     * unknown, never zero. Additive: an older client ignores the key and an older
     * host omits it, so this needs no protocol version change.
     */
    readonly context: ContextPressureView | null;
}
/** One compact line of a running turn's process. */
export interface SessionActivityEntry {
    /** Stable across polls: `seq-<n>` when the record has a log position. */
    readonly id: string;
    /** The record's log position, or `null` when the host numbered nothing. */
    readonly seq: number | null;
    /** When the record was written, epoch milliseconds. */
    readonly at: number;
    /** Narration (`thinking`), a shell-like `command`, its `output`, or another `tool`. */
    readonly kind: 'thinking' | 'command' | 'output' | 'tool';
    /** The tool name for command/tool rows, the matching name for output; may be empty. */
    readonly title: string;
    /** Compact one-line detail, at most {@link ACTIVITY_TEXT_CHARS} characters. */
    readonly text: string;
}
/** What `session.activity` answers: the running turn's compact process detail. */
export interface SessionActivityResult {
    readonly sessionId: string;
    /** The log cut the page was taken at; `null` when the session is unknown. */
    readonly asOfSeq: number | null;
    /** The currently running turn, or `null` when nothing is running. */
    readonly turn: number | null;
    /**
     * Only the running turn's process rows, oldest first.
     *
     * No committed user/assistant messages and no step markers: the summary page
     * already carries those, and this feed exists to answer "what is it doing
     * right now" without repeating the conversation.
     */
    readonly entries: readonly SessionActivityEntry[];
    /**
     * Whether older rows may still be read.
     *
     * Wider than "this answer was trimmed", because a long turn extends before
     * the page window even when every row fitted. On a forward read this is
     * "rows were dropped" OR "the log page has older records"; on a backwards
     * read it is "the page has older records" AND "this page had rows of the
     * requested turn" -- false there means the walk has passed the turn's
     * beginning, and asking again would only return empty pages.
     */
    readonly hasMore: boolean;
    /**
     * The smallest log position in the page the host read; `null` when nothing
     * was read or no record in it named a position.
     *
     * The cursor for paging back: the phone sends this value back as
     * `beforeSeq`. It is the page's own lower bound rather than the oldest
     * *returned* row, so it says where reading stopped rather than how many rows
     * survived the caps.
     */
    readonly oldestSeq: number | null;
}
/**
 * The running turn's compact process detail.
 *
 * A paid-account feature, but a read-only host method: it reads a log page (see
 * {@link readLogPage}), narrows it to one turn and maps it to one-line rows. The
 * conversation itself does not travel here -- committed user/assistant
 * messages, step markers and every unrecognised event are skipped -- because
 * the conversation screen already drew them from the summary page.
 *
 * Two reads share that mapping. Without a cursor this is the newest page and
 * finds the turn that has not ended yet. With `beforeSeq` + `turn` it reads the
 * window before a position and keeps only that turn's rows, which is how a
 * scrolling reader lazily loads the older part of a long turn. The answer's
 * `oldestSeq` is the cursor for the next such request.
 *
 * Everything about the answer is bounded so it stays a small frame: at most
 * {@link ACTIVITY_MAX_ENTRIES} rows, a byte budget of
 * {@link ACTIVITY_MAX_BYTES}, 240-character text and one line each.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to inspect.
 * @param maxEntries - how many rows the client wants; capped, default 200.
 * @param beforeSeq - read the page before this log position instead of the
 *   newest one. Requires `turn`.
 * @param turn - the running turn a backwards page belongs to. Ignored without
 *   `beforeSeq`, because a forward read names its own turn.
 * @param parentSessionId - the parent of a delegated child. The activity read
 *   opens the same log the same way `session.messages` does, so a child named
 *   bare is refused with `session/agent-busy` before anything is read; the
 *   parent is what makes a child's activity readable at all. No shipped
 *   client polls a child's activity yet -- the parameter is the pure addition
 *   that keeps a future poller from reintroducing the refused read.
 * @returns the running turn's rows, or an empty feed when nothing runs.
 * @throws MethodError when `beforeSeq` is given without `turn`.
 */
export declare function sessionActivity(ctx: Context, sessionId: string, maxEntries?: number, beforeSeq?: number, turn?: number, parentSessionId?: string): Promise<SessionActivityResult>;
/** A newly created or resumed session. */
export interface CreateSessionResult {
    readonly sessionId: string;
    /** The agent preset the session runs under, when the host reported one. */
    readonly agentPreset: string | null;
}
/**
 * Create a session, or adopt/resume one when an id is supplied.
 *
 * Supplying `sessionId` for an existing session resumes it and retains its
 * writer lock, which is how the app reattaches to a conversation the desktop is
 * not currently using. Contention surfaces as `WRITER_HELD`.
 *
 * ### A directory is turned into a workspace first
 *
 * DSH attaches a session to a workspace in one place, and only when the request
 * names a `workspaceId`; a bare `cwd` creates a session that belongs to no
 * workspace at all. Membership is what the computer's sidebar lists from, so a
 * session created here with a directory was invisible on the computer -- while the
 * phone, which groups by working directory, showed it. Reported as "created a
 * session on the phone, sent a message, and the computer never shows it".
 *
 * So the directory is resolved to the workspace rooted at it, and one is created
 * when DSH has none, which is what the desktop does when somebody opens a
 * folder. `sessionId` is the exception: adopting a session must not move it, and
 * `workspaceId` together with a foreign directory is an attach that fails.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param options - workspace, directory, preset or explicit session id.
 * @returns the session identity.
 */
export declare function createSession(ctx: Context, options: {
    workspaceId?: string;
    cwd?: string;
    sessionId?: string;
    agentPreset?: string;
}): Promise<CreateSessionResult>;
/** Fork only a proven completed response boundary, never a guessed latest turn. */
export declare function forkSession(ctx: Context, options: {
    sessionId: string;
    atSeq: number;
}): Promise<{
    sessionId: string;
}>;
/** Acceptance of a prompt. */
export interface PromptResult {
    /** Always true when the call succeeds; the host rejects rather than queues silently. */
    readonly accepted: true;
    /** The idempotency key the host recorded, echoed for the client's own retry bookkeeping. */
    readonly requestId: string;
}
/**
 * Send a prompt.
 *
 * `requestId` is an idempotency key: DSH returns the original acceptance for a
 * request id it has already queued or logged, so a retry after a dropped
 * connection cannot submit the same message twice. The client should therefore
 * generate it once and reuse it across retries — which is why the optional
 * `requestId` argument exists rather than being minted here every call.
 *
 * ### Attachments
 *
 * `text` may be absent when there is at least one attachment, and the resulting
 * content preserves the caller's order: the text first (when there is one), then
 * each attachment in the order its id was listed. A prompt with neither is
 * refused before any host call -- DSH itself requires one of the two, and saying
 * so here keeps the failure a clear `MALFORMED_FRAME` rather than an upstream
 * error.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param options - target session, text and/or attachments, delivery mode and idempotency key.
 * @returns the acceptance.
 */
export declare function promptSession(ctx: Context, options: {
    sessionId: string;
    text?: string;
    attachments?: readonly PromptAttachment[];
    mode?: 'queue' | 'steer';
    requestId?: string;
    clientTimeZone?: string;
}): Promise<PromptResult>;
/**
 * Interrupt the running turn.
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to interrupt.
 * @returns the acceptance.
 */
export declare function cancelSession(ctx: Context, sessionId: string): Promise<{
    accepted: true;
}>;
/**
 * Rename a session.
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to rename.
 * @param title - the new title.
 */
export declare function renameSession(ctx: Context, sessionId: string, title: string): Promise<void>;
