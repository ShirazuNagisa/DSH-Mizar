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
import { randomUUID } from 'node:crypto'
import type { Context } from '../dsh.js'
import { MethodError } from './method-error.js'
import { buildStatsFrame, STATS_KEYS, type SessionStatsFrame } from './stats.js'
import { resolveWorkspaceId } from './workspaces.js'

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
 * @param ctx - a context observing `ctx.typertGateway`.
 * @returns the rows.
 */
export async function listSessions(ctx: Context): Promise<{ items: SessionRow[] }> {
  const value = (await ctx.typertGateway.invoke({
    namespace: 'session',
    method: 'list',
    args: { _request: {} },
    signal: AbortSignal.timeout(30_000),
  })) as { items?: readonly unknown[] } | undefined

  const items = (value?.items ?? [])
    .map(toRow)
    .filter((row): row is SessionRow => row !== null)
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
  const value = (await ctx.typertGateway.invoke({
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
  const event = (record as { event?: { type?: unknown; data?: { source?: { kind?: unknown } } } })
    ?.event
  if (event?.type !== 'user/message') return false
  const kind = event.data?.source?.kind
  return kind === 'runtime-context' || kind === 'skill-catalog'
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
export async function sessionMessages(
  ctx: Context,
  sessionId: string,
  maxMessages?: number,
  beforeSeq?: number,
): Promise<SessionMessagesResult> {
  const snapshot = (await ctx.typertGateway.invoke({
    namespace: 'session',
    method: 'projections',
    args: { request: { sessionId } },
    signal: AbortSignal.timeout(30_000),
  })) as { asOfSeq?: unknown } | null | undefined

  const asOfSeq = typeof snapshot?.asOfSeq === 'number' ? snapshot.asOfSeq : null
  if (asOfSeq === null) {
    // No cut, no page: the session has no log to read.
    return { sessionId, asOfSeq: null, records: [], hasMore: false }
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
  })) as { records?: unknown; hasMore?: unknown } | null | undefined

  const records = Array.isArray(value?.records) ? value.records : []
  const useful = records.filter((record) => !isInjectedContext(record))

  return {
    sessionId,
    asOfSeq,
    records: withinBudget(useful),
    hasMore: value?.hasMore === true,
  }
}

/** One page of a session's log. */
export interface SessionMessagesResult {
  readonly sessionId: string
  /** The log cut the page was taken at; `null` when the session is unknown. */
  readonly asOfSeq: number | null
  /**
   * The records exactly as the host reported them.
   *
   * Deliberately unnormalised. Event names are merge-extensible by design, so
   * the set of record shapes is open; reshaping them in the bridge would mean
   * this plugin has to be redeployed whenever DSH adds one. The phone decides
   * what it recognises, and anything it does not is still visible.
   */
  readonly records: readonly unknown[]
  readonly hasMore: boolean
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

  const value = (await ctx.typertGateway.invoke({
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

/** Acceptance of a prompt. */
export interface PromptResult {
  /** Always true when the call succeeds; the host rejects rather than queues silently. */
  readonly accepted: true
  /** The idempotency key the host recorded, echoed for the client's own retry bookkeeping. */
  readonly requestId: string
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
export async function promptSession(
  ctx: Context,
  options: {
    sessionId: string
    text: string
    mode?: 'queue' | 'steer'
    requestId?: string
    clientTimeZone?: string
  },
): Promise<PromptResult> {
  const requestId = options.requestId ?? randomUUID()

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
  await ctx.typertGateway.invoke({
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
  await ctx.typertGateway.invoke({
    namespace: 'session',
    method: 'rename',
    args: { request: { sessionId, title } },
    signal: AbortSignal.timeout(30_000),
  })
}
