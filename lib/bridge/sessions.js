/**
 * Session bridge.
 *
 * Drives the shipped `sessionController` Remotes through the in-process gateway
 * (see docs/decision-0001-in-process-gateway.md) and narrows their replies into
 * shapes the phone can render without understanding DSH's session model.
 *
 * Three deliberate choices:
 *
 *   - **Stats come from `session/projections`, not `ctx.sessionProjections`.**
 *     The service method needs a live `Session` object, and a listed session is
 *     usually cold. The Remote reads one complete baseline "through a
 *     live-preferred observation without activating an Agent", which is exactly
 *     what a phone browsing a session list needs — it must not wake forty
 *     agents to draw forty rows.
 *   - **A history page carries a summary, not a transcript.** The log holds ten
 *     to twenty records for every message a person would recognise — per-step
 *     narration, tool calls and results, attempts, the system prompt, the
 *     runtime context DSH injects under `user/message`. Measured over the 47
 *     session logs in a dev home, the raw log is 1323 KB and the summary of it
 *     is 66 KB. Reading a page is a read of the durable log, so every one of
 *     those bytes was work on the host, and all but a twentieth of them were
 *     bytes the phone dropped on arrival. What survives is what a conversation
 *     screen draws: the prompt, the turn's boundaries and timing, one marker per
 *     step, and **one** assistant message per finished turn — the model's
 *     summary of it. See {@link summaryRecords}.
 *   - **The gateway's wire argument names are used as-is.** `session/list` takes
 *     `_request` (leading underscore) while `session/projections` takes
 *     `request`. Getting that wrong is a runtime error, not a compile error, so
 *     the names are stated once here and asserted by the smoke test.
 *
 * @module dsh-mizar/bridge/sessions
 */
import { randomUUID } from 'node:crypto';
import { recordSeq } from './delivery.js';
import { invokeRemote, streamRemote } from './invoke.js';
import { MethodError } from './method-error.js';
import { buildStatsFrame, STATS_KEYS } from './stats.js';
import { resolveWorkspaceId } from './workspaces.js';
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
 * The event inside one log record.
 *
 * The gateway wraps a log record as `{type: 'event', event: {...}}`, and the
 * event's own name is one level down. The same record written to a session log
 * has `type`, `seq`, `time` and `data` at the top level with no wrapper at all
 * -- so a record that arrives unwrapped is read as itself rather than as a
 * wrapper with nothing in it, which is how a record type silently contributes
 * nothing instead of being kept.
 *
 * @param record - one record, either shape.
 * @returns the event, or `null` when the record is not one.
 */
function eventOf(record) {
    if (typeof record !== 'object' || record === null)
        return null;
    const wrapper = record;
    const value = typeof wrapper.event === 'object' && wrapper.event !== null ? wrapper.event : record;
    const event = value;
    return typeof event.type === 'string' ? event : null;
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
    const value = (await invokeRemote(ctx, {
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
    const value = (await invokeRemote(ctx, {
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
 * The largest page that can actually be delivered, in bytes.
 *
 * Measured the hard way: iOS's `URLSessionWebSocketTask` refuses any frame over
 * one mebibyte and **closes the connection** when one arrives --
 *
 *     input message size 2222614 exceeds maximum message size 1048576
 *     Read completed with an error Message too long
 *
 * -- so an oversized page did not degrade the conversation, it killed the
 * socket. Every reply was missing, the history appeared to vanish on refresh,
 * and the app could not reconnect, all from one page that was 2.1 MB.
 *
 * Half the limit, because the page is JSON and arrives with framing around it,
 * and because being wrong on the high side costs the connection rather than the
 * freshness of one screen.
 */
const MAX_PAGE_BYTES = 256 * 1024;
/**
 * Trim a page to the largest prefix that will fit.
 *
 * Keeps the newest records, which are the ones a conversation is looking at, and
 * drops from the oldest end. A page shorter than asked for is a page the reader
 * can still use; a page that does not arrive is not.
 *
 * @param records - the records, oldest first.
 * @returns as many of the newest as fit.
 */
function withinBudget(records) {
    const kept = [];
    let total = 0;
    for (let index = records.length - 1; index >= 0; index -= 1) {
        const record = records[index];
        // Bytes, not `String.length`. `length` counts UTF-16 code units, and a
        // Chinese character is one of those but three bytes of UTF-8 -- so a budget
        // written with `length` sent roughly three times what it claimed. That is
        // exactly what the device log showed: a page budgeted at half a megabyte
        // arriving as two, then five.
        const size = Buffer.byteLength(JSON.stringify(record) ?? '', 'utf8');
        if (total + size > MAX_PAGE_BYTES && kept.length > 0)
            break;
        total += size;
        kept.push(record);
    }
    return kept.reverse();
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
    // Through `eventOf`, so an unwrapped record is read as itself. Reading only
    // the wrapper meant a host that returns the log's own shape leaked the whole
    // runtime context and skill catalogue back into every page.
    const event = eventOf(record);
    if (event?.['type'] !== 'user/message')
        return false;
    const kind = event['data']?.source?.kind;
    return kind === 'runtime-context' || kind === 'skill-catalog';
}
/**
 * The readable text of an assistant message, or `null` when it carries none.
 *
 * Two keys deep, and one deeper than a user message: the parts are at
 * `data.message.content` rather than `data.content`. Reading only the latter is
 * why every reply was once missing from the phone while the Mac showed the
 * whole exchange.
 *
 * A step that only called tools has no text part at all, and one part typed
 * `reasoning` is not something the model said to anybody -- so both count as
 * "no text", which is the same call the app makes when it draws the record.
 *
 * @param event - the unwrapped event.
 * @returns the joined text, or `null`.
 */
function assistantText(event) {
    const data = event['data'];
    const parts = data?.message?.content;
    if (!Array.isArray(parts))
        return null;
    const text = parts
        .filter((part) => typeof part === 'object' &&
        part !== null &&
        part.type === 'text' &&
        typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
    return text === '' ? null : text;
}
/**
 * Narrow a page to what a conversation screen actually draws.
 *
 * The host returns the whole log window -- ten to twenty records for every
 * message a person would recognise -- and almost none of it survives the trip.
 * Measured over the 47 session logs in a dev home, the full log of a session is
 * 1323 KB and its summary is 66 KB; for the largest of them, 65 KB of records
 * narrow to 10 KB. Since reading a page *is* reading the durable log and folding
 * every projection over it (see {@link sessionMessages}), the host pays for all
 * of it and the phone pays again in relay bandwidth.
 *
 * What is kept is what survives being read rather than scrolled:
 *
 *   - `turn/start` and `turn/end`, which are how a turn is timed, whether it is
 *     still running, and why it stopped -- a monitoring app's whole subject.
 *   - `step/start`, the only remaining signal of how much work a turn did. It is
 *     about 100 bytes, and it stands in for the narration, the tool calls and
 *     the attempts that used to carry the same information at a hundred times
 *     the size. `step/end` is not kept: it says nothing the start did not.
 *   - `user/message` a person wrote. DSH sends its own injected context through
 *     the same event, so {@link isInjectedContext} drops the two kinds that are
 *     not anybody's words.
 *   - **one** `assistant/message` per turn that **ended inside this page** -- the
 *     last one with readable text. That is the model's summary of the turn, and
 *     the per-step narration around it is not: the app draws one bubble per
 *     turn, so the earlier messages were downloaded and then discarded.
 *
 * A turn with no `turn/end` in the page gets no assistant message at all. That
 * covers two cases that look the same from here and want the same answer: a turn
 * still running, whose partial answer is not a summary of anything, and the turn
 * the page was cut through, whose end is in the next page back. Both are
 * re-read from a later page once they finish, and neither is worth the largest
 * thing on the wire to show half of.
 *
 * Everything else goes: `assistant/attempt`, `tool/call`, `tool/result`,
 * `system/message`, `request/header`, `request/context`, the inbox splices, and
 * every other assistant message. The set is an allowlist rather than a blocklist
 * because the alternative is the behaviour this replaces -- an unrecognised
 * event type adding weight to every page forever.
 *
 * The order of the records is the log's, and every kept record is one the host
 * sent: this decides what travels, not what it means.
 *
 * @param records - one page, oldest first, exactly as the gateway returned it.
 * @returns the records worth sending.
 */
function summaryRecords(records) {
    /** Assistant messages that are their turn's last word, and have one. */
    const summaries = new Set();
    const ended = new Set();
    const lastPerTurn = new Map();
    for (const record of records) {
        const event = eventOf(record);
        if (event?.['type'] === 'turn/end') {
            ended.add(turnOf(event));
        }
        else if (event?.['type'] === 'assistant/message') {
            // The last message *with text*, not merely the last message: a turn that
            // narrated and then ended on a step whose message carries only tool calls
            // has its answer in the earlier record. Recording the tool-only one and
            // requiring text of it afterwards dropped the answer entirely, and the
            // turn rendered as a prompt with no reply.
            if (assistantText(event) !== null)
                lastPerTurn.set(turnOf(event), record);
        }
    }
    for (const [turn, last] of lastPerTurn) {
        if (ended.has(turn))
            summaries.add(last);
    }
    return records.filter((record) => {
        const event = eventOf(record);
        switch (event?.['type']) {
            case 'turn/start':
            case 'turn/end':
            case 'step/start':
                return true;
            case 'user/message':
                return !isInjectedContext(record);
            case 'assistant/message':
                return summaries.has(record);
            default:
                return false;
        }
    });
}
/**
 * The turn number an event belongs to, or `undefined` when it names none.
 *
 * Every event kept here carries `data.turn`, which is how a turn's records are
 * recognised as belonging together. A record that names no turn shares the
 * `undefined` key with every other one, so a host that stopped numbering turns
 * would still get its boundaries and its steps -- and would get at most one
 * assistant message per page, which is a smaller page rather than a broken one.
 *
 * @param event - the unwrapped event.
 * @returns the turn number, or `undefined`.
 */
function turnOf(event) {
    return event['data']?.turn;
}
/**
 * How long to wait for the follow opening frame before giving up and asking the
 * projections instead.
 *
 * The same budget as every other read in this file, which is the point: the
 * follow path is the one that has to replay the session log before it can answer
 * at all, so a caller that would have waited thirty seconds for the projections
 * read must not be cut off sooner here. The fallback is for a host that cannot
 * answer this way, not for one that is merely slow.
 */
const FOLLOW_TIMEOUT_MS = 30_000;
/**
 * The log cut, from the opening frame of `session/follow`.
 *
 * **Why the stream, and not the projection read it replaces.** `throughSeq` is
 * documented as an "inclusive log cut obtained from the corresponding follow
 * opening frame", and a page is what a follow opening frame is allowed to be
 * paged by -- so the cut is taken from the same frame the wire's own client
 * takes it from. Measured against a live host, the two are the same number: for
 * five sessions, cold and with logs of 17 to 105 events, the snapshot `cursor`
 * and the projections `asOfSeq` were equal in every case. This is not a
 * freshness fix, it is the contract the type states, and it removes a second
 * read of every projection value from each page request.
 *
 * **Opening the stream does not wake the session.** The concern is real --
 * `session/projections` is documented as reading "without activating an
 * Agent", and `follow` is not -- so it was measured. Against a live host, a cold
 * session's `session/list` row reads `running: false, agentAvailable: false`
 * before the stream is opened, after its snapshot frame is read, and after the
 * iterator is closed: unchanged. Pulling a *second* frame is what activates the
 * agent (`agentAvailable` flips to `true`), which is why the first frame is the
 * only one this ever asks for.
 *
 * One frame, then the iterator is closed -- the shape `workspace/follow` already
 * uses, including the timeout. Following the stream for updates would keep the
 * session live for as long as the request, and one subscription per refresh is a
 * leak that only shows up after an hour of use.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to open.
 * @returns the cursor, or `null` when the host would not answer this way.
 */
async function followCursor(ctx, sessionId) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FOLLOW_TIMEOUT_MS);
    try {
        const iterable = await streamRemote(ctx, {
            namespace: 'session',
            method: 'follow',
            args: { request: { address: { kind: 'session', sessionId } } },
            signal: controller.signal,
        });
        const iterator = iterable[Symbol.asyncIterator]();
        try {
            const first = await iterator.next();
            const frame = first.value;
            // Only a snapshot is a cut. An event frame first would mean the stream
            // opened mid-log, and paging at a cursor taken from the middle of one is
            // how half a turn ends up on the screen.
            if (frame === undefined || frame.type !== 'snapshot')
                return null;
            return typeof frame.cursor === 'number' && Number.isFinite(frame.cursor) ? frame.cursor : null;
        }
        finally {
            // Closes the stream. Without it the subscription outlives the request.
            // Best effort: a carrier that dies while being closed must not turn an
            // answered page into an error.
            try {
                await iterator.return?.();
            }
            catch {
                /* the frame was read; the subscription is the carrier's problem now */
            }
        }
    }
    catch {
        // An older host, a stream carrier that will not open, or a session that has
        // no log at all: the projections read below answers all three, and it is
        // also where a missing session is reported.
        return null;
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * How long a page read may take, projections fallback included.
 *
 * Unchanged from when this was the only step, and deliberately the same for
 * both: a follow opening frame that replays a long log and a projection fold
 * over that log cost about the same, and timing one out early would turn a slow
 * host into a screen with no history on it.
 */
const READ_TIMEOUT_MS = 30_000;
/**
 * The log cut, from a `session/projections` read.
 *
 * The fallback, for a host that cannot open a follow stream -- older than the
 * endpoint, or composed without a stream carrier -- and for a first frame that
 * is not a snapshot. It is one field of a much larger reply: `values` carries
 * every registered projection, which is why this is not the path taken when the
 * stream answers.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to read.
 * @returns the cut, or `null` when the session is unknown.
 */
async function projectionsCut(ctx, sessionId) {
    const value = (await invokeRemote(ctx, {
        namespace: 'session',
        method: 'projections',
        args: { request: { sessionId } },
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    }));
    return typeof value?.asOfSeq === 'number' && Number.isFinite(value.asOfSeq) ? value.asOfSeq : null;
}
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
export async function sessionMessages(ctx, sessionId, maxMessages, beforeSeq, afterSeq) {
    const cut = (await followCursor(ctx, sessionId)) ?? (await projectionsCut(ctx, sessionId));
    if (cut === null) {
        // No cut, no page: the session has no log to read.
        return { sessionId, asOfSeq: null, records: [], hasMore: false };
    }
    const value = (await invokeRemote(ctx, {
        namespace: 'session',
        method: 'page',
        args: {
            request: {
                address: { kind: 'session', sessionId },
                throughSeq: cut,
                // The lower bound. Without it a page starts at the beginning of the log,
                // which for a session with any history means a conversation view made
                // entirely of the first few turns -- and, because a single prompt emits
                // sixteen bookkeeping records for every two messages, very little of it
                // is conversation at all.
                ...(beforeSeq === undefined ? {} : { beforeSeq }),
                ...(maxMessages === undefined ? {} : { maxMessages }),
            },
        },
        signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    }));
    const records = Array.isArray(value?.records) ? value.records : [];
    const summarized = summaryRecords(records);
    // Only what the phone does not already hold. Filtered after the summary and
    // before the budget, for the same two reasons in opposite directions: the
    // summary decides which records are worth sending at all, and an old record
    // that survives it must not spend bytes the new ones need.
    //
    // A backwards page ignores the cursor: it is a window before `beforeSeq`, and
    // filtering it forward would return nothing an operator scrolling up asked
    // for.
    const floor = beforeSeq === undefined ? afterSeq : undefined;
    const fresh = floor === undefined
        ? summarized
        : summarized.filter((record) => {
            const seq = recordSeq(record);
            // A record with no position cannot be proven old, so it travels:
            // dropping it would be silent data loss on a host that stops
            // numbering, and phones merge by identity anyway.
            return seq === null || seq > floor;
        });
    return {
        sessionId,
        asOfSeq: cut,
        // Narrowed before it is trimmed, so the budget is spent on records that
        // travel rather than on narration that would have filled it and been
        // dropped a line later.
        records: withinBudget(fresh),
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
 * ### A directory is turned into a workspace first
 *
 * DSH attaches a session to a workspace in one place, and only when the request
 * names a `workspaceId`; a bare `cwd` creates a session that belongs to no
 * workspace at all. Membership is what the Mac's sidebar lists from, so a
 * session created here with a directory was invisible on the Mac -- while the
 * phone, which groups by working directory, showed it. Reported as "created a
 * session on the phone, sent a message, and the Mac never shows it".
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
export async function createSession(ctx, options) {
    // Never both: `session/create` refuses a request that names a workspace *and*
    // a directory, so resolving a cwd means replacing it rather than adding to it.
    const resolved = options.workspaceId !== undefined || options.cwd === undefined || options.sessionId !== undefined
        ? options.workspaceId
        : ((await resolveWorkspaceId(ctx, options.cwd)) ?? undefined);
    const value = (await invokeRemote(ctx, {
        namespace: 'session',
        method: 'create',
        args: {
            request: {
                ...(resolved === undefined ? {} : { workspaceId: resolved }),
                // Only when no workspace was found: a directory that DSH has no
                // workspace for is still a place to work, and refusing to create the
                // session there would be a worse answer than creating one the Mac does
                // not list.
                ...(resolved === undefined && options.cwd !== undefined ? { cwd: options.cwd } : {}),
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
    await invokeRemote(ctx, {
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
    await invokeRemote(ctx, {
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
    await invokeRemote(ctx, {
        namespace: 'session',
        method: 'rename',
        args: { request: { sessionId, title } },
        signal: AbortSignal.timeout(30_000),
    });
}
