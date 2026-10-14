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
import type { Context } from '../dsh.js'
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
