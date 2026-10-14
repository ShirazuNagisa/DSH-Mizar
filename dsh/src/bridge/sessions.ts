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
