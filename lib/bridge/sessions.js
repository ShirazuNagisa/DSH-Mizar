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
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { recordSeq } from './delivery.js';
import { invokeRemote, streamRemote } from './invoke.js';
import { MethodError } from './method-error.js';
import { buildStatsFrame, STATS_KEYS } from './stats.js';
import { enforcePromptLimits, filePartName } from './uploads.js';
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
 * why every reply was once missing from the phone while the computer showed the
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
    return records
        .filter((record) => {
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
    })
        // Preserved byte for byte except for one case: a prompt that carried only an
        // image or a file has no text for the conversation to draw, so a placeholder
        // is appended. See {@link withAttachmentPlaceholders}.
        .map((record) => {
        const event = eventOf(record);
        return event?.['type'] === 'user/message' ? withAttachmentPlaceholders(record, event) : record;
    });
}
/**
 * Whether a content part is a text part with something to read in it.
 * @param part - one content part.
 * @returns whether it is text a person would see.
 */
function isReadableTextPart(part) {
    if (typeof part !== 'object' || part === null)
        return false;
    const record = part;
    return record.type === 'text' && typeof record.text === 'string' && record.text.trim() !== '';
}
/**
 * The `[Photo]` / `[File: name]` line an attachment-only prompt is summarised as.
 *
 * A user message whose content is only images or files has no text part, and the
 * conversation screen draws text. Without a placeholder the turn would show an
 * empty bubble and, worse, the `user/message` record would contribute nothing a
 * reader could see. The labels are appended in content order, one per
 * attachment, so a prompt carrying two files reads `[File: a]` / `[File: b]`.
 *
 * @param event - the unwrapped `user/message` event.
 * @returns the placeholder text, or `null` when no placeholder is needed.
 */
function attachmentPlaceholderText(event) {
    const data = event['data'];
    const content = data?.content;
    if (!Array.isArray(content))
        return null;
    // Text of any length means the prompt can be read without help, and the log's
    // own record already carries it.
    if (content.some(isReadableTextPart))
        return null;
    const labels = [];
    for (const part of content) {
        if (typeof part !== 'object' || part === null)
            continue;
        const type = part.type;
        if (type === 'image') {
            labels.push('[Photo]');
        }
        else if (type === 'file') {
            const name = filePartName(part);
            labels.push(name === null ? '[File]' : `[File: ${name}]`);
        }
    }
    return labels.length === 0 ? null : labels.join('\n');
}
/**
 * Append a placeholder text part to a user message that carried only attachments.
 *
 * The record is cloned, never mutated: the same object is the host's log record
 * and the page may contain it more than once in a caller's hands. Every field
 * travels unchanged, and a message that already has readable text is returned as
 * the identical object, which is what keeps "the bridge narrows, it does not
 * reshape" true for every ordinary prompt.
 *
 * @param record - one kept log record.
 * @param event - its unwrapped event, which is a `user/message`.
 * @returns the record, with the placeholder appended when one is needed.
 */
function withAttachmentPlaceholders(record, event) {
    const placeholder = attachmentPlaceholderText(event);
    if (placeholder === null)
        return record;
    const data = event['data'];
    const content = data?.content;
    const nextContent = [...content, { type: 'text', text: placeholder }];
    const wrapper = record;
    // The gateway wraps records as `{type: 'event', event: {...}}`; the log itself
    // writes the event's fields at the top level. Both shapes are cloned in the
    // one place that corresponds to where the content lives.
    if (typeof wrapper.event === 'object' && wrapper.event !== null) {
        return { ...record, event: { ...event, data: { ...data, content: nextContent } } };
    }
    return { ...record, data: { ...data, content: nextContent } };
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
 * Read the current tail page of a session's raw log.
 *
 * The two-step shape is not optional: `session/page` is keyed by `address` and a
 * `throughSeq` cut, not by session id, and the cut comes from opening the
 * session's follow stream and reading one frame -- so a caller cannot ask "give
 * me the last N messages" without first asking "what is the log at".
 * `session.maxMessages` counts messages rather than raw events, so a page that
 * spans a long tool run still returns the requests around it rather than a
 * window of deltas.
 *
 * The cut comes from {@link followCursor}, and from {@link projectionsCut} when
 * that cannot answer. Works for a cold session: neither read activates an agent,
 * which was measured for the follow path before it was adopted here.
 *
 * Shared by {@link sessionMessages} and {@link sessionActivity}: both start from
 * exactly the same current page, and only differ in what they keep from it.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to read.
 * @param maxMessages - how many messages to ask for; absent uses the host default.
 * @param beforeSeq - the exclusive upper bound, for paging backwards.
 * @returns the page, or `null` when the session has no log to read.
 */
async function readLogPage(ctx, sessionId, maxMessages, beforeSeq) {
    const cut = (await followCursor(ctx, sessionId)) ?? (await projectionsCut(ctx, sessionId));
    if (cut === null) {
        // No cut, no page: the session has no log to read.
        return null;
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
    return {
        cut,
        records: Array.isArray(value?.records) ? value.records : [],
        hasMore: value?.hasMore === true,
    };
}
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
export async function sessionMessages(ctx, sessionId, maxMessages, beforeSeq, afterSeq) {
    const page = await readLogPage(ctx, sessionId, maxMessages, beforeSeq);
    if (page === null) {
        return { sessionId, asOfSeq: null, records: [], hasMore: false };
    }
    const records = page.records;
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
        asOfSeq: page.cut,
        // Narrowed before it is trimmed, so the budget is spent on records that
        // travel rather than on narration that would have filled it and been
        // dropped a line later.
        records: withinBudget(fresh),
        hasMore: page.hasMore,
    };
}
/** How many entries `session.activity` returns unless the client asks for fewer. */
const ACTIVITY_DEFAULT_ENTRIES = 200;
/**
 * The hard ceiling on entries per answer.
 *
 * The answer leaves as one websocket frame: the listener refuses anything over
 * 512 KiB and iOS closes the connection over 1 MiB. 300 compact rows stay far
 * below both even with 240-character text; the byte budget below is the real
 * bound, and this cap keeps the array shape bounded when the text is short.
 */
const ACTIVITY_MAX_ENTRIES = 300;
/**
 * The byte budget for `entries`, measured as the JSON the phone will read.
 *
 * A quarter of a mebibyte: envelope, tool titles and timestamps still fit well
 * under the listener's 512 KiB frame limit, with room for the relay's framing,
 * while being large enough that the default 200 rows usually fit intact.
 */
const ACTIVITY_MAX_BYTES = 256 * 1024;
/** Longest one-line detail text, in characters. */
const ACTIVITY_TEXT_CHARS = 240;
/** Longest tool title. A name is display text, not a payload, so it is bounded too. */
const ACTIVITY_TITLE_CHARS = 120;
/**
 * How many messages of log to ask for when looking for the running turn.
 *
 * `session.maxMessages` counts messages rather than raw events, and the running
 * turn is always a *tail*: this window is wide enough to hold a long tool loop's
 * calls and results while keeping the host-side read small. The entry cap and
 * byte budget do the rest.
 */
const ACTIVITY_PAGE_MESSAGES = 200;
/**
 * Clamp a requested entry cap.
 *
 * The client can ask for fewer rows; it cannot ask for an unbounded answer. An
 * absent, non-finite or non-positive request means the default, and the ceiling
 * is stated by the protocol rather than inferred from the request.
 *
 * @param value - the client's `maxEntries`, when it sent a number.
 * @returns the number of entries to keep.
 */
function normalizeMaxEntries(value) {
    if (value === undefined || !Number.isFinite(value) || value < 1)
        return ACTIVITY_DEFAULT_ENTRIES;
    return Math.min(ACTIVITY_MAX_ENTRIES, Math.floor(value));
}
/**
 * One line of display text, bounded.
 *
 * Tool output and model narration arrive with newlines and runs of indentation;
 * a detail row is one line, so every whitespace run collapses to one space
 * before the length bound is applied.
 *
 * @param value - the text to flatten, or anything else (which becomes empty).
 * @param limit - the maximum number of characters.
 * @returns the flattened, bounded line.
 */
function oneLine(value, limit) {
    if (typeof value !== 'string')
        return '';
    const flattened = value.replace(/\s+/gu, ' ').trim();
    return flattened.length > limit ? flattened.slice(0, limit) : flattened;
}
/**
 * The first line of a block of text.
 *
 * Tool output is often a whole transcript; a detail row shows one compact line,
 * and the first line is the one a reader scans.
 *
 * @param value - the text.
 * @returns its first line, trimmed.
 */
function firstLine(value) {
    const end = value.search(/[\r\n]/u);
    return (end === -1 ? value : value.slice(0, end)).trim();
}
/**
 * JSON text for an unknown value, never throwing on a hostile object.
 *
 * @param value - the value to render.
 * @returns its JSON text, or the value itself when it is already a string.
 */
function compactJson(value) {
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value) ?? '';
    }
    catch {
        return '';
    }
}
/** Tool names that mean "this runs a shell command", for the command row kind. */
const COMMAND_TOOL_NAME = /(?:^|[._:/-])(?:bash|sh|shell|zsh|exec|execute|command|run|terminal|powershell|cmd)(?:$|[._:/-])/iu;
/**
 * Whether a tool name is a shell-like command runner.
 *
 * The app draws `command` rows differently from `tool` rows (a terminal icon, a
 * command-shaped one-liner), and the host knows the vocabulary the app does not.
 * The match is on name tokens, so `run_command` and `bash` are commands while
 * `read_file` is not.
 *
 * @param name - the tool's DSH name.
 * @returns whether it runs a command.
 */
function isCommandTool(name) {
    return COMMAND_TOOL_NAME.test(name);
}
/**
 * The readable narration carried by one `assistant/attempt` stream.
 *
 * A durable attempt stores model output as compact runs (`text-chunks` and
 * `reasoning-chunks` carrying `texts`) and, for anything the accumulator cannot
 * pack, raw `chunk` records. Both are read; delta text wins over settled blocks
 * so the same sentence is not joined twice, and a host that stores only
 * `block-end` chunks still gets its narration from the block.
 *
 * @param data - the attempt event's `data`.
 * @returns the joined narration, empty when it has none.
 */
function attemptText(data) {
    const stream = data['stream'];
    if (!Array.isArray(stream))
        return '';
    const deltas = [];
    const blocks = [];
    for (const record of stream) {
        if (typeof record !== 'object' || record === null)
            continue;
        const item = record;
        const type = item['type'];
        if (type === 'text-chunks' || type === 'reasoning-chunks') {
            const texts = item['texts'];
            if (Array.isArray(texts)) {
                for (const text of texts)
                    if (typeof text === 'string')
                        deltas.push(text);
            }
            continue;
        }
        // Two raw shapes are in the wild: the durable `{type: 'chunk', chunk}` and a
        // live `TimedStreamChunk` that is just `{time, chunk}`. Reading the nested
        // chunk rather than switching on the wrapper covers both.
        const chunk = item['chunk'];
        if (typeof chunk !== 'object' || chunk === null)
            continue;
        const chunkRecord = chunk;
        const chunkType = chunkRecord['type'];
        if (chunkType === 'text-delta' || chunkType === 'reasoning-delta') {
            const text = chunkRecord['text'];
            if (typeof text === 'string')
                deltas.push(text);
            continue;
        }
        if (chunkType === 'block-end') {
            const block = chunkRecord['block'];
            if (typeof block !== 'object' || block === null)
                continue;
            const blockRecord = block;
            const blockType = blockRecord['type'];
            const text = blockRecord['text'];
            if ((blockType === 'text' || blockType === 'reasoning') && typeof text === 'string') {
                blocks.push(text);
            }
        }
    }
    return deltas.length > 0 ? deltas.join('') : blocks.join('');
}
/**
 * The compact detail for one tool call's arguments.
 *
 * `arguments` is a JSON string in DSH's log. A shell command or a short
 * description is what a reader needs; the rest of the object is noise on a
 * one-line row. A non-JSON argument string is already the most readable thing
 * there is, so it is shown as-is.
 *
 * @param raw - the `arguments` field of a `tool/call`.
 * @returns the one-line detail.
 */
function toolCallText(raw) {
    if (typeof raw !== 'string')
        return oneLine(compactJson(raw), ACTIVITY_TEXT_CHARS);
    const text = raw.trim();
    if (text === '')
        return '';
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return oneLine(text, ACTIVITY_TEXT_CHARS);
    }
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed;
        for (const key of ['command', 'description']) {
            const value = record[key];
            if (typeof value === 'string' && value.trim() !== '') {
                return oneLine(value, ACTIVITY_TEXT_CHARS);
            }
        }
    }
    return oneLine(text, ACTIVITY_TEXT_CHARS);
}
/**
 * The compact detail for one tool result.
 *
 * The normal shape is a tool-role message whose content blocks are text. Hosts
 * that report the outcome differently are still usable: `output`/`result`/
 * `content` are read next, then the error object, in the order the protocol
 * names them. Only the first line is kept.
 *
 * @param data - the `tool/result` event's `data`.
 * @returns the one-line detail, empty when the result carries nothing readable.
 */
function toolResultText(data) {
    const message = data['message'];
    if (typeof message === 'object' && message !== null) {
        const content = message.content;
        if (Array.isArray(content)) {
            const lines = [];
            for (const part of content) {
                if (typeof part !== 'object' || part === null)
                    continue;
                const record = part;
                if (record.type === 'text' && typeof record.text === 'string')
                    lines.push(record.text);
            }
            if (lines.length > 0) {
                const line = firstLine(lines.join('\n'));
                if (line !== '')
                    return line;
            }
        }
    }
    for (const key of ['output', 'result', 'content']) {
        const value = data[key];
        if (typeof value === 'string') {
            const line = firstLine(value);
            if (line !== '')
                return line;
        }
        else if (typeof value === 'object' && value !== null) {
            const line = firstLine(compactJson(value));
            if (line !== '')
                return line;
        }
    }
    const error = data['error'];
    if (typeof error === 'object' && error !== null) {
        const record = error;
        for (const key of ['reason', 'name', 'code']) {
            const value = record[key];
            if (typeof value === 'string') {
                const line = firstLine(value);
                if (line !== '')
                    return line;
            }
        }
    }
    return '';
}
/**
 * A stable id for one row.
 *
 * The phone merges the feed by id across polls, so the id must not depend on
 * the row's position in the page. A log position is exactly that; a host that
 * numbers nothing falls back to the event's timestamp, which is stable for as
 * long as the row is inside the window.
 *
 * @param seq - the record's log position, when it has one.
 * @param at - the record's timestamp.
 * @param kind - the row kind.
 * @returns the id.
 */
function activityId(seq, at, kind) {
    return seq === null ? `at-${at}-${kind}` : `seq-${seq}`;
}
/**
 * When one event was written.
 * @param event - the unwrapped event.
 * @returns its time in epoch milliseconds, or `0` when it names none.
 */
function activityTime(event) {
    const time = event['time'];
    return typeof time === 'number' && Number.isFinite(time) ? time : 0;
}
/**
 * Narrow one running-turn record into a detail row.
 *
 * Only three event types are mapped, and everything else is skipped rather than
 * dumped: the feed exists to be drawn as one-liners, and a shape this build does
 * not know is a payload the phone cannot use.
 *
 * @param record - one log record.
 * @param callNames - tool names by call id, for titling output rows.
 * @returns the row, or `null` when the record is not process detail.
 */
function activityEntryOf(record, callNames) {
    const event = eventOf(record);
    if (event === null)
        return null;
    const data = event['data'];
    if (typeof data !== 'object' || data === null)
        return null;
    const fields = data;
    const seq = recordSeq(record);
    const at = activityTime(event);
    const callId = typeof fields['callId'] === 'string' ? fields['callId'] : null;
    switch (event['type']) {
        case 'assistant/attempt': {
            const text = oneLine(attemptText(fields), ACTIVITY_TEXT_CHARS);
            // An attempt with no readable narration would be an empty row; there is
            // nothing for the phone to draw and nothing worth a frame.
            if (text === '')
                return null;
            const kind = 'thinking';
            return { id: activityId(seq, at, kind), seq, at, kind, title: '', text };
        }
        case 'tool/call': {
            const name = typeof fields['name'] === 'string' && fields['name'] !== '' ? fields['name'] : 'tool';
            const kind = isCommandTool(name) ? 'command' : 'tool';
            return {
                id: activityId(seq, at, kind),
                seq,
                at,
                kind,
                title: oneLine(name, ACTIVITY_TITLE_CHARS),
                text: toolCallText(fields['arguments']),
            };
        }
        case 'tool/result': {
            const text = oneLine(toolResultText(fields), ACTIVITY_TEXT_CHARS);
            if (text === '')
                return null;
            const kind = 'output';
            const title = callId === null ? '' : oneLine(callNames.get(callId) ?? '', ACTIVITY_TITLE_CHARS);
            return { id: activityId(seq, at, kind), seq, at, kind, title, text };
        }
        default:
            // `user/message`, `assistant/message`, `step/*`, `turn/*`, request
            // headers, inbox splices and whatever DSH adds next: the summary page
            // carries the conversation, and this feed carries the process.
            return null;
    }
}
/**
 * The turn the feed is about: the highest-numbered turn with activity in this
 * page and no `turn/end` for it.
 *
 * The page is a window, and a window can start inside the running turn, so a
 * missing `turn/start` is not evidence that nothing runs -- the highest turn
 * with activity and no end is, and that is exactly what a window cut through a
 * running turn looks like. `turn/end` is the only record that ends a turn.
 *
 * @param records - one raw page, oldest first.
 * @returns the running turn number, or `null` when none is running.
 */
function findRunningTurn(records) {
    const active = new Set();
    const ended = new Set();
    for (const record of records) {
        const event = eventOf(record);
        if (event === null)
            continue;
        const turn = turnOf(event);
        if (typeof turn !== 'number' || !Number.isFinite(turn))
            continue;
        if (event['type'] === 'turn/end') {
            ended.add(turn);
            continue;
        }
        active.add(turn);
    }
    let running = null;
    for (const turn of active) {
        if (ended.has(turn))
            continue;
        if (running === null || turn > running)
            running = turn;
    }
    return running;
}
/**
 * Tool names by call id, for titling output rows.
 *
 * A `tool/result` names the call, not the tool; the call that named it may be
 * in this page (it normally is) or in the page before it (not known here, so
 * the title stays empty rather than invented).
 *
 * @param records - one raw page, oldest first.
 * @returns tool names keyed by call id.
 */
function collectToolNames(records) {
    const names = new Map();
    for (const record of records) {
        const event = eventOf(record);
        if (event?.['type'] !== 'tool/call')
            continue;
        const data = event['data'];
        if (typeof data !== 'object' || data === null)
            continue;
        const fields = data;
        const callId = fields['callId'];
        const name = fields['name'];
        if (typeof callId === 'string' && typeof name === 'string' && name !== '') {
            names.set(callId, name);
        }
    }
    return names;
}
/**
 * Trim a running turn's rows to the byte budget, keeping the newest.
 *
 * The newest rows are the ones a running-turn feed is looking at, so the oldest
 * go first -- the same rule the summary page uses. A single row larger than the
 * budget still travels: it is bounded by its own 240 characters, and an empty
 * answer would be worse than one slightly over budget.
 *
 * @param entries - the rows, oldest first.
 * @returns as many of the newest as fit.
 */
function withinActivityBudget(entries) {
    const kept = [];
    // The budget is about the JSON array the phone reads, not the sum of the
    // entries: the brackets and the separators between them are bytes too. Two
    // brackets up front and one separator per row is a slight over-estimate,
    // which is the safe direction.
    let total = 2;
    for (let index = entries.length - 1; index >= 0; index -= 1) {
        const entry = entries[index];
        // Bytes, not `length`: a Chinese character is one UTF-16 unit and three
        // bytes of UTF-8, and the budget is about what leaves the host.
        const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1;
        if (total + size > ACTIVITY_MAX_BYTES && kept.length > 0)
            break;
        total += size;
        kept.push(entry);
    }
    return kept.reverse();
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
export async function sessionActivity(ctx, sessionId, maxEntries) {
    const page = await readLogPage(ctx, sessionId, ACTIVITY_PAGE_MESSAGES);
    if (page === null) {
        return { sessionId, asOfSeq: null, turn: null, entries: [], hasMore: false };
    }
    const running = findRunningTurn(page.records);
    if (running === null) {
        // Not an error: a session between turns is the normal state, and the phone
        // hides the detail area instead of drawing an empty one.
        return { sessionId, asOfSeq: page.cut, turn: null, entries: [], hasMore: false };
    }
    const callNames = collectToolNames(page.records);
    const mapped = [];
    for (const record of page.records) {
        const event = eventOf(record);
        // Only the running turn's process. Earlier turns are history, and the
        // summary page already carries what the conversation screen draws of them.
        if (event === null || turnOf(event) !== running)
            continue;
        const entry = activityEntryOf(record, callNames);
        if (entry !== null)
            mapped.push(entry);
    }
    const limit = normalizeMaxEntries(maxEntries);
    const capped = mapped.length > limit ? mapped.slice(mapped.length - limit) : mapped;
    const entries = withinActivityBudget(capped);
    return {
        sessionId,
        asOfSeq: page.cut,
        turn: running,
        entries,
        hasMore: entries.length !== mapped.length,
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
                // session there would be a worse answer than creating one the computer does
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
/** How long staging one file with the host may take. */
const FILE_STAGE_TIMEOUT_MS = 60_000;
/**
 * The host's `fileUploads` service, when this composition has one.
 *
 * `ctx.get` reads a service without declaring it in `inject`, which is the
 * whole point: requiring `fileUploads` would make every older host unable to
 * load the plugin at all, and the fallback path exists precisely for those.
 *
 * @param ctx - the plugin context.
 * @returns the service, or `undefined` when the host has none.
 */
function fileUploadsOf(ctx) {
    let service;
    try {
        service = ctx.get('fileUploads');
    }
    catch {
        // A context from an older composition, or a test double without service
        // lookup at all: either way there is no service to use.
        return undefined;
    }
    if (typeof service !== 'object' || service === null)
        return undefined;
    const uploadStream = service.uploadStream;
    if (typeof uploadStream !== 'function')
        return undefined;
    return service;
}
/**
 * Stream one attachment's bytes as the chunks the host's uploader asks for.
 *
 * Read through a stream rather than `readFile` on purpose: this path exists so
 * that a 32 MiB document does not have to be held in memory twice, and it is
 * the reason the host offers `uploadStream` instead of an encoded upload.
 *
 * @param path - the staged file.
 * @param signal - aborted when the staging call gives up.
 * @returns the bytes in order.
 */
async function* readFileChunks(path, signal) {
    const stream = createReadStream(path);
    try {
        for await (const chunk of stream) {
            signal.throwIfAborted();
            yield chunk;
        }
    }
    finally {
        stream.destroy();
    }
}
/** Render an unknown thrown value as one line. */
function describeFailure(error) {
    if (error instanceof Error)
        return `${error.name}: ${error.message}`;
    return String(error);
}
/**
 * Stage one file with the host's `fileUploads` service and return its receipt.
 *
 * The receipt is what a `{type: "file"}` prompt part carries; the host resolves
 * it against the receiving Agent for the same prompt request, which is what
 * binds the bytes to this Session.
 *
 * @param service - the host service.
 * @param sessionId - the session the prompt is for.
 * @param attachment - the file to stage.
 * @returns the receipt id.
 * @throws MethodError `ATTACHMENT_FAILED` when the host cannot stage it.
 */
async function stageFile(service, sessionId, attachment) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('staging the file timed out')), FILE_STAGE_TIMEOUT_MS);
    try {
        const value = await service.uploadStream({
            sessionId,
            data: readFileChunks(attachment.path, controller.signal),
            signal: controller.signal,
            ...(attachment.name === '' ? {} : { name: attachment.name }),
        });
        const receiptId = typeof value === 'object' && value !== null
            ? value.receiptId
            : undefined;
        if (typeof receiptId !== 'string' || receiptId === '') {
            throw new MethodError('ATTACHMENT_FAILED', `session.prompt: fileUploads returned no receipt for "${attachment.name}"`);
        }
        return receiptId;
    }
    catch (error) {
        if (error instanceof MethodError)
            throw error;
        throw new MethodError('ATTACHMENT_FAILED', `session.prompt: could not stage file "${attachment.name}" — ${describeFailure(error)}`, error);
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * Build the prompt content part for one attachment.
 *
 * Images travel inline as canonical base64, which is what DSH's prompt format
 * accepts and what it promotes to a durable image reference. Files travel as a
 * receipt when the host has `fileUploads`; otherwise the bytes are copied under
 * `<stateDir>/attachments` and their path is appended as readable text, because
 * an older host has no other way to tell the agent where the file is.
 *
 * @param ctx - the plugin context, read for `fileUploads`.
 * @param sessionId - the session the prompt is for.
 * @param attachment - the finished upload.
 * @returns the content part.
 * @throws MethodError `ATTACHMENT_FAILED` when the bytes cannot be used.
 */
async function promptPart(ctx, sessionId, attachment) {
    if (attachment.kind === 'image') {
        let bytes;
        try {
            bytes = await readFile(attachment.path);
        }
        catch (error) {
            throw new MethodError('ATTACHMENT_FAILED', `session.prompt: could not read image "${attachment.name}" — ${describeFailure(error)}`, error);
        }
        if (bytes.byteLength !== attachment.byteSize) {
            throw new MethodError('ATTACHMENT_FAILED', `session.prompt: image "${attachment.name}" is ${bytes.byteLength} bytes, expected ${attachment.byteSize}`);
        }
        return {
            type: 'image',
            data: bytes.toString('base64'),
            mediaType: attachment.mediaType,
            ...(attachment.name === '' ? {} : { name: attachment.name }),
        };
    }
    const service = fileUploadsOf(ctx);
    if (service === undefined) {
        // The host this plugin is running on predates `fileUploads`, or was composed
        // without it. Saving the bytes somewhere durable and naming the path is the
        // only handle the agent can actually use.
        const saved = await attachment.saveFallback();
        return { type: 'text', text: `[File: ${attachment.name}]\n${saved}` };
    }
    return { type: 'file', receiptId: await stageFile(service, sessionId, attachment) };
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
export async function promptSession(ctx, options) {
    const requestId = options.requestId ?? randomUUID();
    const attachments = options.attachments ?? [];
    // Checked again here rather than only in the upload store: this is the last
    // place before bytes are read and encoded, and a caller that assembles the
    // attachment list itself must get the same answer.
    enforcePromptLimits(attachments);
    const content = [];
    if (options.text !== undefined && options.text !== '') {
        content.push({ type: 'text', text: options.text });
    }
    for (const attachment of attachments) {
        content.push(await promptPart(ctx, options.sessionId, attachment));
    }
    if (content.length === 0) {
        throw new MethodError('MALFORMED_FRAME', 'session.prompt: a prompt needs text or at least one attachment');
    }
    await invokeRemote(ctx, {
        namespace: 'session',
        method: 'prompt',
        args: {
            request: {
                requestId,
                sessionId: options.sessionId,
                mode: options.mode ?? 'queue',
                content,
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
