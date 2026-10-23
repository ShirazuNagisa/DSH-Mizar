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
import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile } from 'node:fs/promises'
import type { Context } from '../dsh.js'
import { recordSeq } from './delivery.js'
import { invokeRemote, streamRemote } from './invoke.js'
import { MethodError } from './method-error.js'
import { buildContextPressure, buildStatsFrame, STATS_KEYS, type ContextPressureView, type SessionStatsFrame } from './stats.js'
import { enforcePromptLimits, filePartName, type PromptAttachment } from './uploads.js'
import { archivedSessionIds, resolveWorkspaceId } from './workspaces.js'

/** One row in the session list. */
export interface SessionRow {
  readonly sessionId: string
  /** Last activity, epoch milliseconds. */
  readonly updatedAt: number
  /** Whether a turn is currently executing. */
  readonly running: boolean
  /** Whether the session has no user prompt yet. */
  readonly blank: boolean
  /** Whether an agent can be resolved for it. */
  readonly agentAvailable: boolean
  /** The session's working directory, when recorded. */
  readonly cwd: string | null
  /** Present when this row is a subagent. */
  readonly parentSessionId: string | null
  /** `'subagent'` for delegated children. */
  readonly origin: string | null
}

/** A session's usage frame plus where it was read from. */
export interface SessionStatsResult {
  readonly sessionId: string
  /** The log cursor the frame reflects; `null` when the session is unknown. */
  readonly asOfSeq: number | null
  readonly stats: SessionStatsFrame | null
}

/** The projection key set requested for one session. */
export const SESSION_PROJECTION_KEYS = STATS_KEYS

/** Read a string field, or `null`. */
function str(source: Record<string, unknown>, key: string): string | null {
  const value = source[key]
  return typeof value === 'string' ? value : null
}

/** Read a boolean field, defaulting to `false`. */
function bool(source: Record<string, unknown>, key: string): boolean {
  return source[key] === true
}

/** Read a numeric field, defaulting to `0`. */
function count(source: Record<string, unknown>, key: string): number {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
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
function eventOf(record: unknown): Record<string, unknown> | null {
  if (typeof record !== 'object' || record === null) return null
  const wrapper = record as { event?: unknown }
  const value =
    typeof wrapper.event === 'object' && wrapper.event !== null ? wrapper.event : record
  const event = value as { type?: unknown }
  return typeof event.type === 'string' ? (event as Record<string, unknown>) : null
}

/**
 * Narrow one `SessionSummary` into a row.
 * @param value - the raw summary.
 * @returns the row, or `null` when it carries no usable id.
 */
function toRow(value: unknown): SessionRow | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const sessionId = str(record, 'sessionId')
  if (sessionId === null) return null
  return {
    sessionId,
    updatedAt: count(record, 'updatedAt'),
    running: bool(record, 'running'),
    blank: bool(record, 'blank'),
    agentAvailable: bool(record, 'agentAvailable'),
    cwd: str(record, 'cwd'),
    parentSessionId: str(record, 'parentSessionId'),
    origin: str(record, 'origin'),
  }
}

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
export async function listSessions(ctx: Context): Promise<{ items: SessionRow[] }> {
  const value = (await invokeRemote(ctx, {
    namespace: 'session',
    method: 'list',
    args: { _request: {} },
    signal: AbortSignal.timeout(30_000),
  })) as { items?: readonly unknown[] } | undefined

  const archived = archivedSessionIds(ctx)
  const items = (value?.items ?? [])
    .map(toRow)
    .filter((row): row is SessionRow => row !== null)
    .filter((row) => archived === null || !archived.has(row.sessionId))
    .sort((a, b) => b.updatedAt - a.updatedAt)

  return { items }
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
export async function sessionStats(ctx: Context, sessionId: string): Promise<SessionStatsResult> {
  const value = (await invokeRemote(ctx, {
    namespace: 'session',
    method: 'projections',
    args: { request: { sessionId } },
    signal: AbortSignal.timeout(30_000),
  })) as { asOfSeq?: unknown; values?: unknown } | null | undefined

  if (value === null || value === undefined || typeof value !== 'object') {
    return { sessionId, asOfSeq: null, stats: null }
  }

  const asOfSeq = typeof value.asOfSeq === 'number' ? value.asOfSeq : null
  const values =
    typeof value.values === 'object' && value.values !== null
      ? (value.values as Record<string, unknown>)
      : {}

  return { sessionId, asOfSeq, stats: buildStatsFrame(values) }
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
const MAX_PAGE_BYTES = 256 * 1024

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
function withinBudget(records: readonly unknown[]): unknown[] {
  const kept: unknown[] = []
  let total = 0
  for (let index = records.length - 1; index >= 0; index -= 1) {
    const record = records[index]
    // Bytes, not `String.length`. `length` counts UTF-16 code units, and a
    // Chinese character is one of those but three bytes of UTF-8 -- so a budget
    // written with `length` sent roughly three times what it claimed. That is
    // exactly what the device log showed: a page budgeted at half a megabyte
    // arriving as two, then five.
    const size = Buffer.byteLength(JSON.stringify(record) ?? '', 'utf8')
    if (total + size > MAX_PAGE_BYTES && kept.length > 0) break
    total += size
    kept.push(record)
  }
  return kept.reverse()
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
function isInjectedContext(record: unknown): boolean {
  // Through `eventOf`, so an unwrapped record is read as itself. Reading only
  // the wrapper meant a host that returns the log's own shape leaked the whole
  // runtime context and skill catalogue back into every page.
  const event = eventOf(record)
  if (event?.['type'] !== 'user/message') return false
  const kind = (event['data'] as { source?: { kind?: unknown } } | undefined)?.source?.kind
  return kind === 'runtime-context' || kind === 'skill-catalog'
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
function assistantText(event: Record<string, unknown>): string | null {
  const data = event['data'] as { message?: { content?: unknown } } | undefined
  const parts = data?.message?.content
  if (!Array.isArray(parts)) return null
  const text = parts
    .filter(
      (part): part is { type: string; text: string } =>
        typeof part === 'object' &&
        part !== null &&
        (part as { type?: unknown }).type === 'text' &&
        typeof (part as { text?: unknown }).text === 'string',
    )
    .map((part) => part.text)
    .join('\n')
  return text === '' ? null : text
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
type UsageFold = typeof import('@deepseek-ai/dsh-token-meter/client').deriveTurnTokenUsage
let usageFold: Promise<UsageFold | undefined> | undefined
function loadUsageFold(): Promise<UsageFold | undefined> {
  // Local published bundle: missing/broken accounting never breaks session reads.
  return usageFold ??= import('./turn-usage-fold.js').then((module) => module.deriveTurnTokenUsage).catch(() => undefined)
}

/** Keep only complete contiguous turn-local windows; never sum a paged fragment. */
function turnWindows(records: readonly unknown[]): Map<unknown, Record<string, unknown>[]> {
  const windows = new Map<unknown, Record<string, unknown>[]>()
  let current: Record<string, unknown>[] = []
  let turn: unknown
  let previous: number | undefined
  for (const record of records) {
    const event = eventOf(record)
    if (event === null) continue
    const seq = event['seq']
    if (event['type'] === 'turn/start') {
      current = []
      turn = turnOf(event)
      previous = undefined
    }
    if (turn === undefined) continue
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || (previous !== undefined && seq !== previous + 1)) {
      current = []; turn = undefined; previous = undefined; continue
    }
    current.push(event)
    previous = seq
    if (event['type'] === 'turn/end') {
      if (turnOf(event) === turn) windows.set(turn, current)
      current = []; turn = undefined; previous = undefined
    }
  }
  return windows
}

/** Desktop tail rule: the last text must also be the last transcript content. */
function branchUnavailable(events: readonly Record<string, unknown>[]): boolean {
  let closing: number | undefined
  let latest: number | undefined
  for (const event of events) {
    const seq = event['seq']
    if (typeof seq !== 'number') continue
    const type = event['type']
    if (type === 'assistant/message') {
      latest = seq
      if (assistantText(event) !== null) closing = seq
    } else if (type === 'tool/call' || (type === 'tool/result' && event['surfaceOp'] === 'append') || type === 'llm/retry'
      || (type === 'turn/end' && (event['data'] as { reason?: { kind?: string } } | undefined)?.reason?.kind === 'error')) latest = seq
  }
  return closing === undefined || latest !== closing
}

async function summaryRecords(records: readonly unknown[]): Promise<unknown[]> {
  const derive = await loadUsageFold()
  const windows = turnWindows(records)
  /** Assistant messages that are their turn's last word, and have one. */
  const summaries = new Set<unknown>()
  const ended = new Set<unknown>()
  const lastPerTurn = new Map<unknown, unknown>()
  for (const record of records) {
    const event = eventOf(record)
    if (event?.['type'] === 'turn/end') {
      ended.add(turnOf(event))
    } else if (event?.['type'] === 'assistant/message') {
      // The last message *with text*, not merely the last message: a turn that
      // narrated and then ended on a step whose message carries only tool calls
      // has its answer in the earlier record. Recording the tool-only one and
      // requiring text of it afterwards dropped the answer entirely, and the
      // turn rendered as a prompt with no reply.
      if (assistantText(event) !== null) lastPerTurn.set(turnOf(event), record)
    }
  }
  for (const [turn, last] of lastPerTurn) {
    if (ended.has(turn)) summaries.add(last)
  }

  return records
    .filter((record) => {
      const event = eventOf(record)
      switch (event?.['type']) {
        case 'turn/start':
        case 'turn/end':
        case 'step/start':
          return true
        case 'user/message':
          return !isInjectedContext(record)
        case 'assistant/message':
          return summaries.has(record)
        default:
          return false
      }
    })
    // Preserved byte for byte except for one case: a prompt that carried only an
    // image or a file has no text for the conversation to draw, so a placeholder
    // is appended. See {@link withAttachmentPlaceholders}.
    .map((record) => {
      const event = eventOf(record)
      if (event?.['type'] === 'turn/end') {
        const events = windows.get(turnOf(event))
        // A partial page cannot establish branch safety either. Re-reading a
        // complete turn may upgrade this metadata, but never invents usage.
        let usage: ReturnType<UsageFold>
        try { usage = events === undefined ? undefined : derive?.(events as unknown as Parameters<UsageFold>[0]) } catch { usage = undefined }
        const enriched = {
          ...event,
          data: {
            ...(event['data'] as Record<string, unknown>),
            ...(events === undefined ? {} : { mizarBranchUnavailable: branchUnavailable(events) }),
            ...(usage === undefined ? {} : { mizarTokenUsage: usage }),
          },
        }
        return typeof (record as { event?: unknown }).event === 'object'
          ? { ...(record as Record<string, unknown>), event: enriched } : enriched
      }
      return event?.['type'] === 'user/message' ? withAttachmentPlaceholders(record, event) : record
    })
}

/**
 * Whether a content part is a text part with something to read in it.
 * @param part - one content part.
 * @returns whether it is text a person would see.
 */
function isReadableTextPart(part: unknown): boolean {
  if (typeof part !== 'object' || part === null) return false
  const record = part as { type?: unknown; text?: unknown }
  return record.type === 'text' && typeof record.text === 'string' && record.text.trim() !== ''
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
function attachmentPlaceholderText(event: Record<string, unknown>): string | null {
  const data = event['data'] as { content?: unknown } | undefined
  const content = data?.content
  if (!Array.isArray(content)) return null
  // Text of any length means the prompt can be read without help, and the log's
  // own record already carries it.
  if (content.some(isReadableTextPart)) return null

  const labels: string[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) continue
    const type = (part as { type?: unknown }).type
    if (type === 'image') {
      labels.push('[Photo]')
    } else if (type === 'file') {
      const name = filePartName(part)
      labels.push(name === null ? '[File]' : `[File: ${name}]`)
    }
  }
  return labels.length === 0 ? null : labels.join('\n')
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
function withAttachmentPlaceholders(record: unknown, event: Record<string, unknown>): unknown {
  const placeholder = attachmentPlaceholderText(event)
  if (placeholder === null) return record

  const data = event['data'] as { content?: unknown } | undefined
  const content = data?.content as readonly unknown[]
  const nextContent = [...content, { type: 'text', text: placeholder }]
  const wrapper = record as { event?: unknown }
  // The gateway wraps records as `{type: 'event', event: {...}}`; the log itself
  // writes the event's fields at the top level. Both shapes are cloned in the
  // one place that corresponds to where the content lives.
  if (typeof wrapper.event === 'object' && wrapper.event !== null) {
    return { ...(record as object), event: { ...event, data: { ...data, content: nextContent } } }
  }
  return { ...(record as object), data: { ...data, content: nextContent } }
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
function turnOf(event: Record<string, unknown>): unknown {
  return (event['data'] as { turn?: unknown } | undefined)?.turn
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
const FOLLOW_TIMEOUT_MS = 30_000

/**
 * The durable address DSH reads one log by.
 *
 * An ordinary session is addressed by its id alone. A delegated child is **not**
 * a session as far as the history API is concerned: `session/follow` and
 * `session/page` refuse `{kind: 'session'}` for a log whose header says
 * `origin: 'subagent'` --
 *
 *     session/agent-busy: subagent Sessions require their durable parent address
 *
 * -- and require the child to be named through its parent instead. The failure
 * is raised before any log is read, so a phone that only knew a session id could
 * never page a child's history at all; that is why the parent travels with the
 * request.
 *
 * The mode is `'unknown'` on purpose: `session/list` carries the child's lineage
 * but not its delegation mode (`one-shot` or `continuable`), and the host treats
 * `unknown` as "either" rather than as a mismatch. Guessing a mode would trade a
 * readable page for a `subagent/unauthorized`.
 */
type SessionLogAddress =
  | { readonly kind: 'session'; readonly sessionId: string }
  | {
      readonly kind: 'subagent'
      readonly parentSessionId: string
      readonly childSessionId: string
      readonly mode: 'unknown'
    }

/**
 * Address one session's log, as a child when its parent is known.
 *
 * @param sessionId - the session whose log is being read.
 * @param parentSessionId - the parent of a delegated child, or absent for an
 *   ordinary conversation (and for a fork, which is a session of its own).
 * @returns the address to send.
 */
function logAddress(sessionId: string, parentSessionId?: string): SessionLogAddress {
  return parentSessionId === undefined
    ? { kind: 'session', sessionId }
    : { kind: 'subagent', parentSessionId, childSessionId: sessionId, mode: 'unknown' }
}

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
 * The same frame also carries the projection baseline, which is where
 * {@link readLogPage} gets the page's context figure. It is the read a page
 * already pays for; the context figure costs no second one.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param address - the durable address to open; see {@link logAddress}.
 * @returns the opening frame, or `null` when the host would not answer this way.
 */
async function followOpening(ctx: Context, address: SessionLogAddress): Promise<ProjectionBaseline | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), FOLLOW_TIMEOUT_MS)
  try {
    const iterable = await streamRemote(ctx, {
      namespace: 'session',
      method: 'follow',
      args: { request: { address } },
      signal: controller.signal,
    })
    const iterator = iterable[Symbol.asyncIterator]()
    try {
      const first = await iterator.next()
      const frame = first.value as {
        type?: unknown
        cursor?: unknown
        projections?: unknown
      } | undefined
      // Only a snapshot is a cut. An event frame first would mean the stream
      // opened mid-log, and paging at a cursor taken from the middle of one is
      // how half a turn ends up on the screen.
      if (frame === undefined || frame.type !== 'snapshot') return null
      if (typeof frame.cursor !== 'number' || !Number.isFinite(frame.cursor)) return null
      // The same frame carries the projection baseline, which is where the
      // page's context figure comes from -- no second read. See
      // {@link projectionValues}.
      return { cut: frame.cursor, values: projectionValues(frame.projections) }
    } finally {
      // Closes the stream. Without it the subscription outlives the request.
      // Best effort: a carrier that dies while being closed must not turn an
      // answered page into an error.
      try {
        await iterator.return?.()
      } catch {
        /* the frame was read; the subscription is the carrier's problem now */
      }
    }
  } catch {
    // An older host, a stream carrier that will not open, or a session that has
    // no log at all: the projections read below answers all three, and it is
    // also where a missing session is reported.
    return null
  } finally {
    clearTimeout(timer)
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
const READ_TIMEOUT_MS = 30_000

/** A cut and the projection values read at it. */
interface ProjectionBaseline {
  /** The inclusive log cut, or `null` when the host named none. */
  readonly cut: number | null
  /** Every projection value available at that cut; empty when none came back. */
  readonly values: Readonly<Record<string, unknown>>
}

/**
 * Projection values from a baseline-shaped object, or an empty set.
 *
 * Both reads that can name the cut -- the follow opening frame and the
 * `session/projections` fallback -- carry the projection baseline. The page
 * derives the context figure from those values rather than paying for another
 * projections read on every refresh, which is the read this file already
 * refuses to make when the stream answers. A host that sends no baseline (or
 * an older one without the context projections) yields no values, and with
 * them no context figure: unknown, never zero.
 *
 * @param value - a projection baseline, or anything else.
 * @returns its `values` object, or an empty record.
 */
function projectionValues(value: unknown): Readonly<Record<string, unknown>> {
  const values = (value as { values?: unknown } | null | undefined)?.values
  return typeof values === 'object' && values !== null
    ? (values as Record<string, unknown>)
    : {}
}

/**
 * The log cut and projection values, from a `session/projections` read.
 *
 * The fallback, for a host that cannot open a follow stream -- older than the
 * endpoint, or composed without a stream carrier -- and for a first frame that
 * is not a snapshot. It is one field of a much larger reply: `values` carries
 * every registered projection, which is why this is not the path taken when the
 * stream answers.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to read.
 * @returns the cut (or `null` when the session is unknown) and its values.
 */
async function projectionsAt(ctx: Context, sessionId: string): Promise<ProjectionBaseline> {
  const value = (await invokeRemote(ctx, {
    namespace: 'session',
    method: 'projections',
    args: { request: { sessionId } },
    signal: AbortSignal.timeout(READ_TIMEOUT_MS),
  })) as { asOfSeq?: unknown } | null | undefined

  return {
    cut: typeof value?.asOfSeq === 'number' && Number.isFinite(value.asOfSeq) ? value.asOfSeq : null,
    values: projectionValues(value),
  }
}

/** One raw page of a session's log, as the host returned it. */
interface LogPage {
  /** The inclusive log cut the page was taken at. */
  readonly cut: number
  /** Raw records, oldest first, exactly as the gateway reported them. */
  readonly records: readonly unknown[]
  /** Whether the host says older records exist before this page. */
  readonly hasMore: boolean
  /**
   * Context-window occupancy and breakdown at the page's cut, or `null` when
   * the host answered from a baseline without the context projections.
   */
  readonly context: ContextPressureView | null
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
 * The cut comes from {@link followOpening}, and from {@link projectionsAt} when
 * that cannot answer. Works for a cold session: neither read activates an agent,
 * which was measured for the follow path before it was adopted here. Both reads
 * already carry the projection baseline, which is where the page's
 * {@link LogPage.context} comes from -- the page does not make a second
 * projections read for it.
 *
 * Shared by {@link sessionMessages} and {@link sessionActivity}: both start from
 * exactly the same current page, and only differ in what they keep from it.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to read.
 * @param maxMessages - how many messages to ask for; absent uses the host default.
 * @param beforeSeq - the exclusive upper bound, for paging backwards.
 * @param parentSessionId - the parent of a delegated child; absent reads the
 *   session as a session. See {@link logAddress}.
 * @returns the page, or `null` when the session has no log to read.
 */
async function readLogPage(
  ctx: Context,
  sessionId: string,
  maxMessages?: number,
  beforeSeq?: number,
  parentSessionId?: string,
): Promise<LogPage | null> {
  const address = logAddress(sessionId, parentSessionId)
  const baseline = (await followOpening(ctx, address)) ?? (await projectionsAt(ctx, sessionId))
  const cut = baseline.cut
  if (cut === null) {
    // No cut, no page: the session has no log to read.
    return null
  }

  const value = (await invokeRemote(ctx, {
    namespace: 'session',
    method: 'page',
    args: {
      request: {
        address,
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
  })) as { records?: unknown; hasMore?: unknown } | null | undefined

  return {
    cut,
    records: Array.isArray(value?.records) ? value.records : [],
    hasMore: value?.hasMore === true,
    // The same derivation `session.stats` uses for its `context` field: the
    // full and incremental page alike carries the occupancy and its breakdown,
    // so a refresh the open screen actually runs keeps the figure current.
    context: buildContextPressure(baseline.values['contextPressure'], baseline.values['contextBreakdown']),
  }
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
 * @param parentSessionId - the parent of a delegated child. Supplying it is what
 *   makes a child's history readable at all: without it the host refuses the
 *   read outright (`session/agent-busy`), because a child is not addressable as
 *   a session. See {@link logAddress}.
 * @returns the page, or no records when the session is unknown.
 */
export async function sessionMessages(
  ctx: Context,
  sessionId: string,
  maxMessages?: number,
  beforeSeq?: number,
  afterSeq?: number,
  parentSessionId?: string,
): Promise<SessionMessagesResult> {
  const page = await readLogPage(ctx, sessionId, maxMessages, beforeSeq, parentSessionId)
  if (page === null) {
    return { sessionId, asOfSeq: null, records: [], hasMore: false, context: null }
  }

  const records = page.records
  const summarized = await summaryRecords(records)
  // Only what the phone does not already hold. Filtered after the summary and
  // before the budget, for the same two reasons in opposite directions: the
  // summary decides which records are worth sending at all, and an old record
  // that survives it must not spend bytes the new ones need.
  //
  // A backwards page ignores the cursor: it is a window before `beforeSeq`, and
  // filtering it forward would return nothing an operator scrolling up asked
  // for.
  const floor = beforeSeq === undefined ? afterSeq : undefined
  const fresh =
    floor === undefined
      ? summarized
      : summarized.filter((record) => {
          const seq = recordSeq(record)
          // A record with no position cannot be proven old, so it travels:
          // dropping it would be silent data loss on a host that stops
          // numbering, and phones merge by identity anyway.
          return seq === null || seq > floor
        })

  // Carried by the same read that named the cut, so neither the full nor the
  // incremental refresh pays for an extra projections read: see
  // {@link projectionValues}.
  return {
    sessionId,
    asOfSeq: page.cut,
    // Narrowed before it is trimmed, so the budget is spent on records that
    // travel rather than on narration that would have filled it and been
    // dropped a line later.
    records: withinBudget(fresh),
    hasMore: page.hasMore,
    context: page.context,
  }
}

/** One page of a session's log. */
export interface SessionMessagesResult {
  readonly sessionId: string
  /**
   * The log cut the page was taken at; `null` when the session is unknown.
   *
   * The follow opening frame's `cursor` normally, and the projections
   * `asOfSeq` when the stream could not answer. Both are positions in the same
   * log and the app passes it back as the next page's `beforeSeq`.
   */
  readonly asOfSeq: number | null
  /**
   * The records the conversation screen draws, in the log's order.
   *
   * Not the whole page: see {@link summaryRecords} for what is kept and why.
   * Individual records are passed through exactly as the host reported them --
   * event names are merge-extensible by design, so the set of record shapes is
   * open and reshaping them here would mean this plugin has to be redeployed
   * whenever DSH adds one.
   */
  readonly records: readonly unknown[]
  readonly hasMore: boolean
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
  readonly context: ContextPressureView | null
}

/** One compact line of a running turn's process. */
export interface SessionActivityEntry {
  /** Stable across polls: `seq-<n>` when the record has a log position. */
  readonly id: string
  /** The record's log position, or `null` when the host numbered nothing. */
  readonly seq: number | null
  /** When the record was written, epoch milliseconds. */
  readonly at: number
  /** Narration (`thinking`), a shell-like `command`, its `output`, or another `tool`. */
  readonly kind: 'thinking' | 'command' | 'output' | 'tool'
  /** The tool name for command/tool rows, the matching name for output; may be empty. */
  readonly title: string
  /** Compact one-line detail, at most {@link ACTIVITY_TEXT_CHARS} characters. */
  readonly text: string
}

/** What `session.activity` answers: the running turn's compact process detail. */
export interface SessionActivityResult {
  readonly sessionId: string
  /** The log cut the page was taken at; `null` when the session is unknown. */
  readonly asOfSeq: number | null
  /** The currently running turn, or `null` when nothing is running. */
  readonly turn: number | null
  /**
   * Only the running turn's process rows, oldest first.
   *
   * No committed user/assistant messages and no step markers: the summary page
   * already carries those, and this feed exists to answer "what is it doing
   * right now" without repeating the conversation.
   */
  readonly entries: readonly SessionActivityEntry[]
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
  readonly hasMore: boolean
  /**
   * The smallest log position in the page the host read; `null` when nothing
   * was read or no record in it named a position.
   *
   * The cursor for paging back: the phone sends this value back as
   * `beforeSeq`. It is the page's own lower bound rather than the oldest
   * *returned* row, so it says where reading stopped rather than how many rows
   * survived the caps.
   */
  readonly oldestSeq: number | null
}

/** How many entries `session.activity` returns unless the client asks for fewer. */
const ACTIVITY_DEFAULT_ENTRIES = 200

/**
 * The hard ceiling on entries per answer.
 *
 * The answer leaves as one websocket frame: the listener refuses anything over
 * 512 KiB and iOS closes the connection over 1 MiB. 300 compact rows stay far
 * below both even with 240-character text; the byte budget below is the real
 * bound, and this cap keeps the array shape bounded when the text is short.
 */
const ACTIVITY_MAX_ENTRIES = 300

/**
 * The byte budget for `entries`, measured as the JSON the phone will read.
 *
 * A quarter of a mebibyte: envelope, tool titles and timestamps still fit well
 * under the listener's 512 KiB frame limit, with room for the relay's framing,
 * while being large enough that the default 200 rows usually fit intact.
 */
const ACTIVITY_MAX_BYTES = 256 * 1024

/** Longest one-line detail text, in characters. */
const ACTIVITY_TEXT_CHARS = 240

/** Longest tool title. A name is display text, not a payload, so it is bounded too. */
const ACTIVITY_TITLE_CHARS = 120

/**
 * How many messages of log to ask for when looking for the running turn.
 *
 * `session.maxMessages` counts messages rather than raw events, and the running
 * turn is always a *tail*: this window is wide enough to hold a long tool loop's
 * calls and results while keeping the host-side read small. The entry cap and
 * byte budget do the rest.
 */
const ACTIVITY_PAGE_MESSAGES = 200

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
function normalizeMaxEntries(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return ACTIVITY_DEFAULT_ENTRIES
  return Math.min(ACTIVITY_MAX_ENTRIES, Math.floor(value))
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
function oneLine(value: unknown, limit: number): string {
  if (typeof value !== 'string') return ''
  const flattened = value.replace(/\s+/gu, ' ').trim()
  return flattened.length > limit ? flattened.slice(0, limit) : flattened
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
function firstLine(value: string): string {
  const end = value.search(/[\r\n]/u)
  return (end === -1 ? value : value.slice(0, end)).trim()
}

/**
 * JSON text for an unknown value, never throwing on a hostile object.
 *
 * @param value - the value to render.
 * @returns its JSON text, or the value itself when it is already a string.
 */
function compactJson(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? ''
  } catch {
    return ''
  }
}

/** Tool names that mean "this runs a shell command", for the command row kind. */
const COMMAND_TOOL_NAME =
  /(?:^|[._:/-])(?:bash|sh|shell|zsh|exec|execute|command|run|terminal|powershell|cmd)(?:$|[._:/-])/iu

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
function isCommandTool(name: string): boolean {
  return COMMAND_TOOL_NAME.test(name)
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
function attemptText(data: Record<string, unknown>): string {
  const stream = data['stream']
  if (!Array.isArray(stream)) return ''
  const deltas: string[] = []
  const blocks: string[] = []
  for (const record of stream) {
    if (typeof record !== 'object' || record === null) continue
    const item = record as Record<string, unknown>
    const type = item['type']
    if (type === 'text-chunks' || type === 'reasoning-chunks') {
      const texts = item['texts']
      if (Array.isArray(texts)) {
        for (const text of texts) if (typeof text === 'string') deltas.push(text)
      }
      continue
    }
    // Two raw shapes are in the wild: the durable `{type: 'chunk', chunk}` and a
    // live `TimedStreamChunk` that is just `{time, chunk}`. Reading the nested
    // chunk rather than switching on the wrapper covers both.
    const chunk = item['chunk']
    if (typeof chunk !== 'object' || chunk === null) continue
    const chunkRecord = chunk as Record<string, unknown>
    const chunkType = chunkRecord['type']
    if (chunkType === 'text-delta' || chunkType === 'reasoning-delta') {
      const text = chunkRecord['text']
      if (typeof text === 'string') deltas.push(text)
      continue
    }
    if (chunkType === 'block-end') {
      const block = chunkRecord['block']
      if (typeof block !== 'object' || block === null) continue
      const blockRecord = block as Record<string, unknown>
      const blockType = blockRecord['type']
      const text = blockRecord['text']
      if ((blockType === 'text' || blockType === 'reasoning') && typeof text === 'string') {
        blocks.push(text)
      }
    }
  }
  return deltas.length > 0 ? deltas.join('') : blocks.join('')
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
function toolCallText(raw: unknown): string {
  if (typeof raw !== 'string') return oneLine(compactJson(raw), ACTIVITY_TEXT_CHARS)
  const text = raw.trim()
  if (text === '') return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return oneLine(text, ACTIVITY_TEXT_CHARS)
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const record = parsed as Record<string, unknown>
    for (const key of ['command', 'description']) {
      const value = record[key]
      if (typeof value === 'string' && value.trim() !== '') {
        return oneLine(value, ACTIVITY_TEXT_CHARS)
      }
    }
  }
  return oneLine(text, ACTIVITY_TEXT_CHARS)
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
function toolResultText(data: Record<string, unknown>): string {
  const message = data['message']
  if (typeof message === 'object' && message !== null) {
    const content = (message as { content?: unknown }).content
    if (Array.isArray(content)) {
      const lines: string[] = []
      for (const part of content) {
        if (typeof part !== 'object' || part === null) continue
        const record = part as { type?: unknown; text?: unknown }
        if (record.type === 'text' && typeof record.text === 'string') lines.push(record.text)
      }
      if (lines.length > 0) {
        const line = firstLine(lines.join('\n'))
        if (line !== '') return line
      }
    }
  }
  for (const key of ['output', 'result', 'content']) {
    const value = data[key]
    if (typeof value === 'string') {
      const line = firstLine(value)
      if (line !== '') return line
    } else if (typeof value === 'object' && value !== null) {
      const line = firstLine(compactJson(value))
      if (line !== '') return line
    }
  }
  const error = data['error']
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    for (const key of ['reason', 'name', 'code']) {
      const value = record[key]
      if (typeof value === 'string') {
        const line = firstLine(value)
        if (line !== '') return line
      }
    }
  }
  return ''
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
function activityId(seq: number | null, at: number, kind: string): string {
  return seq === null ? `at-${at}-${kind}` : `seq-${seq}`
}

/**
 * When one event was written.
 * @param event - the unwrapped event.
 * @returns its time in epoch milliseconds, or `0` when it names none.
 */
function activityTime(event: Record<string, unknown>): number {
  const time = event['time']
  return typeof time === 'number' && Number.isFinite(time) ? time : 0
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
function activityEntryOf(
  record: unknown,
  callNames: ReadonlyMap<string, string>,
): SessionActivityEntry | null {
  const event = eventOf(record)
  if (event === null) return null
  const data = event['data']
  if (typeof data !== 'object' || data === null) return null
  const fields = data as Record<string, unknown>
  const seq = recordSeq(record)
  const at = activityTime(event)
  const callId = typeof fields['callId'] === 'string' ? fields['callId'] : null

  switch (event['type']) {
    case 'assistant/attempt': {
      const text = oneLine(attemptText(fields), ACTIVITY_TEXT_CHARS)
      // An attempt with no readable narration would be an empty row; there is
      // nothing for the phone to draw and nothing worth a frame.
      if (text === '') return null
      const kind = 'thinking' as const
      return { id: activityId(seq, at, kind), seq, at, kind, title: '', text }
    }
    case 'tool/call': {
      const name = typeof fields['name'] === 'string' && fields['name'] !== '' ? fields['name'] : 'tool'
      const kind = isCommandTool(name) ? 'command' : 'tool'
      return {
        id: activityId(seq, at, kind),
        seq,
        at,
        kind,
        title: oneLine(name, ACTIVITY_TITLE_CHARS),
        text: toolCallText(fields['arguments']),
      }
    }
    case 'tool/result': {
      const text = oneLine(toolResultText(fields), ACTIVITY_TEXT_CHARS)
      if (text === '') return null
      const kind = 'output' as const
      const title = callId === null ? '' : oneLine(callNames.get(callId) ?? '', ACTIVITY_TITLE_CHARS)
      return { id: activityId(seq, at, kind), seq, at, kind, title, text }
    }
    default:
      // `user/message`, `assistant/message`, `step/*`, `turn/*`, request
      // headers, inbox splices and whatever DSH adds next: the summary page
      // carries the conversation, and this feed carries the process.
      return null
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
function findRunningTurn(records: readonly unknown[]): number | null {
  const active = new Set<number>()
  const ended = new Set<number>()
  for (const record of records) {
    const event = eventOf(record)
    if (event === null) continue
    const turn = turnOf(event)
    if (typeof turn !== 'number' || !Number.isFinite(turn)) continue
    if (event['type'] === 'turn/end') {
      ended.add(turn)
      continue
    }
    active.add(turn)
  }
  let running: number | null = null
  for (const turn of active) {
    if (ended.has(turn)) continue
    if (running === null || turn > running) running = turn
  }
  return running
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
function collectToolNames(records: readonly unknown[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const record of records) {
    const event = eventOf(record)
    if (event?.['type'] !== 'tool/call') continue
    const data = event['data']
    if (typeof data !== 'object' || data === null) continue
    const fields = data as Record<string, unknown>
    const callId = fields['callId']
    const name = fields['name']
    if (typeof callId === 'string' && typeof name === 'string' && name !== '') {
      names.set(callId, name)
    }
  }
  return names
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
function withinActivityBudget(
  entries: readonly SessionActivityEntry[],
): SessionActivityEntry[] {
  const kept: SessionActivityEntry[] = []
  // The budget is about the JSON array the phone reads, not the sum of the
  // entries: the brackets and the separators between them are bytes too. Two
  // brackets up front and one separator per row is a slight over-estimate,
  // which is the safe direction.
  let total = 2
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as SessionActivityEntry
    // Bytes, not `length`: a Chinese character is one UTF-16 unit and three
    // bytes of UTF-8, and the budget is about what leaves the host.
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8') + 1
    if (total + size > ACTIVITY_MAX_BYTES && kept.length > 0) break
    total += size
    kept.push(entry)
  }
  return kept.reverse()
}

/**
 * The smallest log position in one raw page.
 *
 * This is the cursor the phone pages back with: `session.activity` answers it as
 * `oldestSeq`, and the client sends it straight back as `beforeSeq`. It is the
 * page's own lower bound rather than the oldest *returned* row, so it says where
 * reading stopped rather than how many rows survived the caps.
 *
 * @param records - one raw page, oldest first.
 * @returns the position, or `null` when no record in the page names one.
 */
function oldestPageSeq(records: readonly unknown[]): number | null {
  let oldest: number | null = null
  for (const record of records) {
    const seq = recordSeq(record)
    if (seq === null) continue
    if (oldest === null || seq < oldest) oldest = seq
  }
  return oldest
}

/**
 * Apply the entry cap and the byte budget to the rows a page mapped.
 *
 * The newest rows are kept when either bound forces a cut, which is the same
 * rule both directions use: a phone watching a running turn looks at its tail,
 * and even while scrolling back the rows closest to what it already holds are
 * the ones that join up with it.
 *
 * @param entries - the rows, oldest first.
 * @param maxEntries - the client's requested cap; normalized here.
 * @returns as many of the newest as fit.
 */
function cappedActivityEntries(
  entries: readonly SessionActivityEntry[],
  maxEntries: number | undefined,
): SessionActivityEntry[] {
  const limit = normalizeMaxEntries(maxEntries)
  const capped = entries.length > limit ? entries.slice(entries.length - limit) : entries
  return withinActivityBudget(capped)
}

/**
 * The forward read: the newest page, narrowed to the turn that is still running.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to inspect.
 * @param maxEntries - how many rows the client wants; capped, default 200.
 * @param parentSessionId - the parent of a delegated child, naming the log
 *   through its lineage. See {@link logAddress}.
 * @returns the running turn's rows, or an empty feed when nothing runs.
 */
async function currentActivity(
  ctx: Context,
  sessionId: string,
  maxEntries: number | undefined,
  parentSessionId: string | undefined,
): Promise<SessionActivityResult> {
  const page = await readLogPage(ctx, sessionId, ACTIVITY_PAGE_MESSAGES, undefined, parentSessionId)
  if (page === null) {
    // No cut, no page: the session has no log to read.
    return { sessionId, asOfSeq: null, turn: null, entries: [], hasMore: false, oldestSeq: null }
  }

  const oldestSeq = oldestPageSeq(page.records)
  const running = findRunningTurn(page.records)
  if (running === null) {
    // Not an error: a session between turns is the normal state, and the phone
    // hides the detail area instead of drawing an empty one.
    return { sessionId, asOfSeq: page.cut, turn: null, entries: [], hasMore: false, oldestSeq }
  }

  const callNames = collectToolNames(page.records)
  const mapped: SessionActivityEntry[] = []
  for (const record of page.records) {
    const event = eventOf(record)
    // Only the running turn's process. Earlier turns are history, and the
    // summary page already carries what the conversation screen draws of them.
    if (event === null || turnOf(event) !== running) continue
    const entry = activityEntryOf(record, callNames)
    if (entry !== null) mapped.push(entry)
  }

  const entries = cappedActivityEntries(mapped, maxEntries)
  return {
    sessionId,
    asOfSeq: page.cut,
    turn: running,
    entries,
    // Wider than "this answer was trimmed", deliberately: the feed may be able
    // to page back even when every row fitted, because the running turn can
    // extend before the page window. The phone asks once more; the next
    // answer's `hasMore: false` (no row of the turn) is what ends the walk.
    hasMore: entries.length !== mapped.length || page.hasMore,
    oldestSeq,
  }
}

/**
 * The backwards read: the page before a cursor, narrowed to the named turn.
 *
 * A page is a window cut out of the log, so it normally starts before the
 * requested turn did -- earlier turns' rows are expected and skipped. No
 * `turn/start` is required: the turn number on each record is the whole
 * membership test, and a window that begins inside the turn has no start
 * marker in it. The page's own `hasMore` then says whether older records
 * exist at all; rows of the turn in it say whether that matters.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to inspect.
 * @param beforeSeq - read the page before this log position.
 * @param turn - the running turn the page belongs to.
 * @param maxEntries - how many rows the client wants; capped, default 200.
 * @param parentSessionId - the parent of a delegated child, naming the log
 *   through its lineage. See {@link logAddress}.
 * @returns the turn's rows in that page, oldest first.
 */
async function olderActivity(
  ctx: Context,
  sessionId: string,
  beforeSeq: number,
  turn: number,
  maxEntries: number | undefined,
  parentSessionId: string | undefined,
): Promise<SessionActivityResult> {
  const page = await readLogPage(ctx, sessionId, ACTIVITY_PAGE_MESSAGES, beforeSeq, parentSessionId)
  if (page === null) {
    // The session is unknown, or has no readable log. The turn is echoed
    // because the caller named it, and `hasMore: false` is the stop it needs.
    return { sessionId, asOfSeq: null, turn, entries: [], hasMore: false, oldestSeq: null }
  }

  const callNames = collectToolNames(page.records)
  const mapped: SessionActivityEntry[] = []
  for (const record of page.records) {
    const event = eventOf(record)
    if (event === null || turnOf(event) !== turn) continue
    const entry = activityEntryOf(record, callNames)
    if (entry !== null) mapped.push(entry)
  }

  const entries = cappedActivityEntries(mapped, maxEntries)
  return {
    sessionId,
    asOfSeq: page.cut,
    turn,
    entries,
    // Two different reasons there could be more rows, and the phone needs both:
    //
    //   - the page held more rows of this turn than the caps allowed. The phone
    //     pages from the oldest *returned* row, so the trimmed rows sit between
    //     that cursor and the page start and are still reachable -- but only if
    //     this answer says the walk is not over. Reporting only `page.hasMore`
    //     here would end the walk on a full page and silently drop them;
    //   - the page itself is older than the turn's beginning. A page with no
    //     row of the turn means the walk passed the start: the phone needs a
    //     definitive stop, not just "no rows this time".
    hasMore:
      entries.length !== mapped.length || (page.hasMore && mapped.length > 0),
    oldestSeq: oldestPageSeq(page.records),
  }
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
export async function sessionActivity(
  ctx: Context,
  sessionId: string,
  maxEntries?: number,
  beforeSeq?: number,
  turn?: number,
  parentSessionId?: string,
): Promise<SessionActivityResult> {
  if (beforeSeq !== undefined) {
    // The wire refuses this pair in the other order too; here it is a caller
    // contract, and guessing a turn would append another turn's rows to a feed.
    if (turn === undefined) {
      throw new MethodError('MALFORMED_FRAME', 'session.activity: a backwards page needs a turn')
    }
    return olderActivity(ctx, sessionId, beforeSeq, turn, maxEntries, parentSessionId)
  }
  return currentActivity(ctx, sessionId, maxEntries, parentSessionId)
}

/** A newly created or resumed session. */
export interface CreateSessionResult {
  readonly sessionId: string
  /** The agent preset the session runs under, when the host reported one. */
  readonly agentPreset: string | null
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
export async function createSession(
  ctx: Context,
  options: {
    workspaceId?: string
    cwd?: string
    sessionId?: string
    agentPreset?: string
  },
): Promise<CreateSessionResult> {
  // Never both: `session/create` refuses a request that names a workspace *and*
  // a directory, so resolving a cwd means replacing it rather than adding to it.
  const resolved =
    options.workspaceId !== undefined || options.cwd === undefined || options.sessionId !== undefined
      ? options.workspaceId
      : ((await resolveWorkspaceId(ctx, options.cwd)) ?? undefined)

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
  })) as { sessionId?: unknown; agentPreset?: unknown } | undefined

  if (typeof value?.sessionId !== 'string' || value.sessionId === '') {
    throw new MethodError('REMOTE_ERROR', 'session.create returned no session id')
  }
  return {
    sessionId: value.sessionId,
    agentPreset: typeof value.agentPreset === 'string' ? value.agentPreset : null,
  }
}

/** Fork only a proven completed response boundary, never a guessed latest turn. */
export async function forkSession(
  ctx: Context,
  options: { sessionId: string; atSeq: number },
): Promise<{ sessionId: string }> {
  if (!Number.isSafeInteger(options.atSeq) || options.atSeq < 0 || options.atSeq >= Number.MAX_SAFE_INTEGER) {
    throw new MethodError('MALFORMED_FRAME', 'The branch boundary is not a safe log position.')
  }
  const page = await readLogPage(ctx, options.sessionId, 1000, options.atSeq + 1)
  const end = page?.records.map(eventOf).find((event) => event?.['seq'] === options.atSeq)
  if (end?.['type'] !== 'turn/end') {
    throw new MethodError('REMOTE_ERROR', 'The selected completed turn boundary could not be verified. Refresh the conversation and try again.')
  }
  const events = turnWindows(page?.records ?? []).get(turnOf(end))
  if (events === undefined || branchUnavailable(events)) {
    throw new MethodError('REMOTE_ERROR', 'This response cannot be branched: its complete closing boundary is unavailable or later tool activity or an error follows it.')
  }
  const value = await invokeRemote(ctx, {
    namespace: 'session',
    method: 'fork',
    args: { request: { sessionId: options.sessionId, atSeq: options.atSeq } },
    signal: AbortSignal.timeout(60_000),
  }) as { sessionId?: unknown } | undefined
  if (typeof value?.sessionId !== 'string' || value.sessionId === '') {
    throw new MethodError('REMOTE_ERROR', 'session.fork returned no session id')
  }
  return { sessionId: value.sessionId }
}

/** Acceptance of a prompt. */
export interface PromptResult {
  /** Always true when the call succeeds; the host rejects rather than queues silently. */
  readonly accepted: true
  /** The idempotency key the host recorded, echoed for the client's own retry bookkeeping. */
  readonly requestId: string
}

/** One content part of a prompt the bridge builds. */
type PromptPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image'
      readonly data: string
      readonly mediaType: string
      readonly name?: string
    }
  | { readonly type: 'file'; readonly receiptId: string }

/**
 * The slice of the host's `fileUploads` service the bridge uses, declared
 * structurally.
 *
 * Not imported from DSH: the plugin compiles against 0.2.1-rc.2, where the
 * service may not exist, and a composition without it must still send prompts
 * (the fallback path below). Naming the one method here is what keeps the
 * optional dependency optional while still type-checking the call.
 */
interface FileUploadsService {
  uploadStream(request: {
    readonly sessionId: string
    readonly data: AsyncIterable<Uint8Array>
    readonly signal?: AbortSignal
    readonly name?: string
  }): Promise<unknown>
}

/** How long staging one file with the host may take. */
const FILE_STAGE_TIMEOUT_MS = 60_000

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
function fileUploadsOf(ctx: Context): FileUploadsService | undefined {
  let service: unknown
  try {
    service = ctx.get('fileUploads')
  } catch {
    // A context from an older composition, or a test double without service
    // lookup at all: either way there is no service to use.
    return undefined
  }
  if (typeof service !== 'object' || service === null) return undefined
  const uploadStream = (service as { uploadStream?: unknown }).uploadStream
  if (typeof uploadStream !== 'function') return undefined
  return service as FileUploadsService
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
async function* readFileChunks(path: string, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  const stream = createReadStream(path)
  try {
    for await (const chunk of stream) {
      signal.throwIfAborted()
      yield chunk as Uint8Array
    }
  } finally {
    stream.destroy()
  }
}

/** Render an unknown thrown value as one line. */
function describeFailure(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
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
async function stageFile(
  service: FileUploadsService,
  sessionId: string,
  attachment: PromptAttachment,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(new Error('staging the file timed out')),
    FILE_STAGE_TIMEOUT_MS,
  )
  try {
    const value = await service.uploadStream({
      sessionId,
      data: readFileChunks(attachment.path, controller.signal),
      signal: controller.signal,
      ...(attachment.name === '' ? {} : { name: attachment.name }),
    })
    const receiptId =
      typeof value === 'object' && value !== null
        ? (value as { receiptId?: unknown }).receiptId
        : undefined
    if (typeof receiptId !== 'string' || receiptId === '') {
      throw new MethodError(
        'ATTACHMENT_FAILED',
        `session.prompt: fileUploads returned no receipt for "${attachment.name}"`,
      )
    }
    return receiptId
  } catch (error) {
    if (error instanceof MethodError) throw error
    throw new MethodError(
      'ATTACHMENT_FAILED',
      `session.prompt: could not stage file "${attachment.name}" — ${describeFailure(error)}`,
      error,
    )
  } finally {
    clearTimeout(timer)
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
async function promptPart(
  ctx: Context,
  sessionId: string,
  attachment: PromptAttachment,
): Promise<PromptPart> {
  if (attachment.kind === 'image') {
    let bytes: Buffer
    try {
      bytes = await readFile(attachment.path)
    } catch (error) {
      throw new MethodError(
        'ATTACHMENT_FAILED',
        `session.prompt: could not read image "${attachment.name}" — ${describeFailure(error)}`,
        error,
      )
    }
    if (bytes.byteLength !== attachment.byteSize) {
      throw new MethodError(
        'ATTACHMENT_FAILED',
        `session.prompt: image "${attachment.name}" is ${bytes.byteLength} bytes, expected ${attachment.byteSize}`,
      )
    }
    return {
      type: 'image',
      data: bytes.toString('base64'),
      mediaType: attachment.mediaType,
      ...(attachment.name === '' ? {} : { name: attachment.name }),
    }
  }

  const service = fileUploadsOf(ctx)
  if (service === undefined) {
    // The host this plugin is running on predates `fileUploads`, or was composed
    // without it. Saving the bytes somewhere durable and naming the path is the
    // only handle the agent can actually use.
    const saved = await attachment.saveFallback()
    return { type: 'text', text: `[File: ${attachment.name}]\n${saved}` }
  }
  return { type: 'file', receiptId: await stageFile(service, sessionId, attachment) }
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
export async function promptSession(
  ctx: Context,
  options: {
    sessionId: string
    text?: string
    attachments?: readonly PromptAttachment[]
    mode?: 'queue' | 'steer'
    requestId?: string
    clientTimeZone?: string
  },
): Promise<PromptResult> {
  const requestId = options.requestId ?? randomUUID()
  const attachments = options.attachments ?? []
  // Checked again here rather than only in the upload store: this is the last
  // place before bytes are read and encoded, and a caller that assembles the
  // attachment list itself must get the same answer.
  enforcePromptLimits(attachments)

  const content: PromptPart[] = []
  if (options.text !== undefined && options.text !== '') {
    content.push({ type: 'text', text: options.text })
  }
  for (const attachment of attachments) {
    content.push(await promptPart(ctx, options.sessionId, attachment))
  }
  if (content.length === 0) {
    throw new MethodError(
      'MALFORMED_FRAME',
      'session.prompt: a prompt needs text or at least one attachment',
    )
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
  })

  return { accepted: true, requestId }
}

/**
 * Interrupt the running turn.
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to interrupt.
 * @returns the acceptance.
 */
export async function cancelSession(ctx: Context, sessionId: string): Promise<{ accepted: true }> {
  await invokeRemote(ctx, {
    namespace: 'session',
    method: 'cancel',
    args: { request: { sessionId } },
    signal: AbortSignal.timeout(30_000),
  })
  return { accepted: true }
}

/**
 * Rename a session.
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param sessionId - the session to rename.
 * @param title - the new title.
 */
export async function renameSession(ctx: Context, sessionId: string, title: string): Promise<void> {
  await invokeRemote(ctx, {
    namespace: 'session',
    method: 'rename',
    args: { request: { sessionId, title } },
    signal: AbortSignal.timeout(30_000),
  })
}
