/**
 * Session bridge.
 *
 * Drives the shipped `sessionController` Remotes through the in-process gateway
 * (see docs/decision-0001-in-process-gateway.md) and narrows their replies into
 * shapes the phone can render without understanding DSH's session model.
 *
 * Two deliberate choices:
 *
 *   - **Stats come from `session/projections`, not `ctx.sessionProjections`.**
 *     The service method needs a live `Session` object, and a listed session is
 *     usually cold. The Remote reads one complete baseline "through a
 *     live-preferred observation without activating an Agent", which is exactly
 *     what a phone browsing a session list needs — it must not wake forty
 *     agents to draw forty rows.
 *   - **The gateway's wire argument names are used as-is.** `session/list` takes
 *     `_request` (leading underscore) while `session/projections` takes
 *     `request`. Getting that wrong is a runtime error, not a compile error, so
 *     the names are stated once here and asserted by the smoke test.
 *
 * @module dsh-mizar/bridge/sessions
 */
import { randomUUID } from 'node:crypto';
import { MethodError } from './method-error.js';
import { buildStatsFrame, STATS_KEYS } from './stats.js';
/** The projection key set requested for one session. */
export const SESSION_PROJECTION_KEYS = STATS_KEYS;
/** Read a string field, or `null`. */
function str(source, key) {
    const value = source[key];
    return typeof value === 'string' ? value : null;
}
/** Read a boolean field, defaulting to `false`. */
function bool(source, key) {
    return source[key] === true;
}
/** Read a numeric field, defaulting to `0`. */
function count(source, key) {
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
/**
 * Narrow one `SessionSummary` into a row.
 * @param value - the raw summary.
 * @returns the row, or `null` when it carries no usable id.
 */
function toRow(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const record = value;
    const sessionId = str(record, 'sessionId');
    if (sessionId === null)
        return null;
    return {
        sessionId,
        updatedAt: count(record, 'updatedAt'),
        running: bool(record, 'running'),
        blank: bool(record, 'blank'),
        agentAvailable: bool(record, 'agentAvailable'),
        cwd: str(record, 'cwd'),
        parentSessionId: str(record, 'parentSessionId'),
        origin: str(record, 'origin'),
    };
}
/**
 * List the sessions DSH would show, newest activity first.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @returns the rows.
 */
export async function listSessions(ctx) {
    const value = (await ctx.typertGateway.invoke({
        namespace: 'session',
        method: 'list',
        args: { _request: {} },
        signal: AbortSignal.timeout(30_000),
    }));
    const items = (value?.items ?? [])
        .map(toRow)
        .filter((row) => row !== null)
        .sort((a, b) => b.updatedAt - a.updatedAt);
    return { items };
}
/**
 * Read one session's usage frame.
 *
 * Works for a cold session: the projection read does not activate an agent.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to read.
 * @returns the frame, or `null` stats when the session is unknown.
 */
export async function sessionStats(ctx, sessionId) {
    const value = (await ctx.typertGateway.invoke({
        namespace: 'session',
        method: 'projections',
        args: { request: { sessionId } },
        signal: AbortSignal.timeout(30_000),
    }));
    if (value === null || value === undefined || typeof value !== 'object') {
        return { sessionId, asOfSeq: null, stats: null };
    }
    const asOfSeq = typeof value.asOfSeq === 'number' ? value.asOfSeq : null;
    const values = typeof value.values === 'object' && value.values !== null
        ? value.values
        : {};
    return { sessionId, asOfSeq, stats: buildStatsFrame(values) };
}
/**
 * Whether a record is context DSH assembled for itself rather than anything a
 * person wrote.
 *
 * These arrive as ordinary `user/message` events and they are enormous: measured
 * on a live session, an eleven-character prompt came with 483 characters of
 * runtime context and 5921 of skill catalogue. Sending them costs roughly 6 KB
 * per turn over a link that may be a phone on cellular, and they are not user
 * data in any sense -- nobody wrote them and nobody wants them.
 *
 * Dropping them here rather than only in the app is what lets the phone ask for
 * a real history: at forty messages the page was already a few hundred kilobytes
 * and at two hundred it was large enough that the request timed out and the
 * conversation rendered empty. The app still filters by kind as a second layer,
 * because a build of this plugin older than the phone should not be able to
 * reintroduce the problem.
 *
 * @param record - one log record, as the gateway returned it.
 * @returns whether to leave it out of the page.
 */
function isInjectedContext(record) {
    const event = record
        ?.event;
    if (event?.type !== 'user/message')
        return false;
    const kind = event.data?.source?.kind;
    return kind === 'runtime-context' || kind === 'skill-catalog';
}
/**
 * Read a page of a session's log.
 *
 * The two-step shape is not optional. `session/page` is keyed by `address` and a
 * `throughSeq` cut, not by session id, and the cut comes from a projection read
 * -- so a caller cannot ask "give me the last N messages" without first asking
 * "what is the log at". `session.maxMessages` counts messages rather than raw
 * events, so a page that spans a long tool run still returns the requests around
 * it rather than a window of deltas.
 *
 * Works for a cold session: ike the stats read, this does not activate an agent.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to read.
 * @param maxMessages - how many messages to ask for.
 * @returns the page, or `null` records when the session is unknown.
 */
export async function sessionMessages(ctx, sessionId, maxMessages, beforeSeq) {
    const snapshot = (await ctx.typertGateway.invoke({
        namespace: 'session',
        method: 'projections',
        args: { request: { sessionId } },
        signal: AbortSignal.timeout(30_000),
    }));
    const asOfSeq = typeof snapshot?.asOfSeq === 'number' ? snapshot.asOfSeq : null;
    if (asOfSeq === null) {
        // No cut, no page: the session has no log to read.
        return { sessionId, asOfSeq: null, records: [], hasMore: false };
    }
    const value = (await ctx.typertGateway.invoke({
        namespace: 'session',
        method: 'page',
        args: {
            request: {
                address: { kind: 'session', sessionId },
                throughSeq: asOfSeq,
                // The lower bound. Without it a page starts at the beginning of the log,
                // which for a session with any history means a conversation view made
                // entirely of the first few turns -- and, because a single prompt emits
                // sixteen bookkeeping records for every two messages, very little of it
                // is conversation at all.
                ...(beforeSeq === undefined ? {} : { beforeSeq }),
                ...(maxMessages === undefined ? {} : { maxMessages }),
            },
        },
        signal: AbortSignal.timeout(30_000),
    }));
    const records = Array.isArray(value?.records) ? value.records : [];
    return {
        sessionId,
        asOfSeq,
        records: records.filter((record) => !isInjectedContext(record)),
        hasMore: value?.hasMore === true,
    };
}
/**
 * Create a session, or adopt/resume one when an id is supplied.
 *
 * Supplying `sessionId` for an existing session resumes it and retains its
 * writer lock, which is how the app reattaches to a conversation the desktop is
 * not currently using. Contention surfaces as `WRITER_HELD`.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param options - workspace, directory, preset or explicit session id.
 * @returns the session identity.
 */
export async function createSession(ctx, options) {
    const value = (await ctx.typertGateway.invoke({
        namespace: 'session',
        method: 'create',
        args: {
            request: {
                ...(options.workspaceId === undefined ? {} : { workspaceId: options.workspaceId }),
                ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
                ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
                ...(options.agentPreset === undefined ? {} : { agentPreset: options.agentPreset }),
            },
        },
        signal: AbortSignal.timeout(60_000),
    }));
    if (typeof value?.sessionId !== 'string' || value.sessionId === '') {
        throw new MethodError('REMOTE_ERROR', 'session.create returned no session id');
    }
    return {
        sessionId: value.sessionId,
        agentPreset: typeof value.agentPreset === 'string' ? value.agentPreset : null,
    };
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
export async function promptSession(ctx, options) {
    const requestId = options.requestId ?? randomUUID();
    await ctx.typertGateway.invoke({
        namespace: 'session',
        method: 'prompt',
        args: {
            request: {
                requestId,
                sessionId: options.sessionId,
                mode: options.mode ?? 'queue',
                content: [{ type: 'text', text: options.text }],
                ...(options.clientTimeZone === undefined ? {} : { clientTimeZone: options.clientTimeZone }),
            },
        },
        signal: AbortSignal.timeout(60_000),
    });
    return { accepted: true, requestId };
}
/**
 * Interrupt the running turn.
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to interrupt.
 * @returns the acceptance.
 */
export async function cancelSession(ctx, sessionId) {
    await ctx.typertGateway.invoke({
        namespace: 'session',
        method: 'cancel',
        args: { request: { sessionId } },
        signal: AbortSignal.timeout(30_000),
    });
    return { accepted: true };
}
/**
 * Rename a session.
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to rename.
 * @param title - the new title.
 */
export async function renameSession(ctx, sessionId, title) {
    await ctx.typertGateway.invoke({
        namespace: 'session',
        method: 'rename',
        args: { request: { sessionId, title } },
        signal: AbortSignal.timeout(30_000),
    });
}
