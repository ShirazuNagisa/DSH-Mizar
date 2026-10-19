import type { Context } from '../dsh.js';
import { type SessionStatsFrame } from './stats.js';
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
 * @returns the page, or no records when the session is unknown.
 */
export declare function sessionMessages(ctx: Context, sessionId: string, maxMessages?: number, beforeSeq?: number, afterSeq?: number): Promise<SessionMessagesResult>;
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
    /** Whether rows were dropped by the entry cap or the byte budget. */
    readonly hasMore: boolean;
}
/**
 * The running turn's compact process detail.
 *
 * A paid-account feature, but a read-only host method: it is the same current
 * log page {@link sessionMessages} reads (see {@link readLogPage}), narrowed to
 * the one turn that has not ended yet and then mapped to one-line rows. The
 * conversation itself does not travel here -- committed user/assistant
 * messages, step markers and every unrecognised event are skipped -- because
 * the conversation screen already drew them from the summary page.
 *
 * Everything about the answer is bounded so it stays a small frame: at most
 * {@link ACTIVITY_MAX_ENTRIES} rows, a byte budget of
 * {@link ACTIVITY_MAX_BYTES}, 240-character text and one line each.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to inspect.
 * @param maxEntries - how many rows the client wants; capped, default 200.
 * @returns the running turn's rows, or an empty feed when nothing runs.
 */
export declare function sessionActivity(ctx: Context, sessionId: string, maxEntries?: number): Promise<SessionActivityResult>;
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
