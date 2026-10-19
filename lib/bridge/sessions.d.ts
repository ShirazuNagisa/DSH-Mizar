import type { Context } from '../dsh.js';
import { type SessionStatsFrame } from './stats.js';
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
 * The two-step shape is not optional. `session/page` is keyed by `address` and a
 * `throughSeq` cut, not by session id, and the cut comes from opening the
 * session's follow stream and reading one frame -- so a caller cannot ask "give
 * me the last N messages" without first asking "what is the log at".
 * `session.maxMessages` counts messages rather than raw events, so a page that
 * spans a long tool run still returns the requests around it rather than a
 * window of deltas.
 *
 * The cut comes from {@link followCursor}, and from {@link projectionsCut} when
 * that cannot answer. The reply is narrowed by {@link summaryRecords} to what
 * the conversation screen draws, filtered to what the phone does not already
 * hold, and then trimmed to what fits by {@link withinBudget}.
 *
 * Works for a cold session: neither read activates an agent, which was measured
 * for the follow path before it was adopted here.
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
/** Host-generated content only: the mobile wire never accepts these parts directly. */
export type PromptPart = {
    readonly type: 'image';
    readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
    readonly data: string;
    readonly name: string;
} | {
    readonly type: 'file';
    readonly receiptId: string;
};
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
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param options - target session, text, delivery mode and idempotency key.
 * @returns the acceptance.
 */
export declare function promptSession(ctx: Context, options: {
    sessionId: string;
    text: string;
    mode?: 'queue' | 'steer';
    requestId?: string;
    clientTimeZone?: string;
    attachmentParts?: readonly PromptPart[];
    signal?: AbortSignal;
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
