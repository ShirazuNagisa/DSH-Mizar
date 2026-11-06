/**
 * The delegation notice bridge.
 *
 * The desktop drives a remote DSH agent through MCP. The tool result's first
 * line is `AGI_MIZAR_DELEGATION <id>`, so this bridge can map a delegation back
 * to the session that started it without knowing anything about the MCP tool.
 * When the delegation settles, the desktop sends a `delegation_notice`; this
 * module hands it to the DSH agents service as a settlement follow-up, which is
 * what wakes an idle parent model in a new turn.
 *
 * Everything here is best-effort. A missing `agents` service, an unknown
 * delegation, or a follow-up that throws is logged and dropped; `remote_wait`
 * remains the fallback.
 *
 * @module dsh-mizar/bridge/delegation
 */
import type { Context } from '../dsh.js'
import type { DelegationNoticeFrame } from '../link/frames.js'
import { toWire } from '../link/frames.js'

/** How many delegation→session mappings to keep. */
const MAX_LINKS = 128

/** How many notice ids to remember for duplicate suppression. */
const MAX_SEEN = 512

/** The marker the MCP tool writes on its first line. */
const MARKER = /AGI_MIZAR_DELEGATION\s+([A-Za-z0-9._:-]+)/

/** The slice of the DSH agents service this bridge uses. */
interface AgentsLike {
  get?: (sessionId: string) => AgentLike | undefined
}

interface AgentLike {
  followup?: (message: unknown) => unknown
}

export class DelegationBridge {
  readonly #ctx: Context
  readonly #log: (message: string) => void
  readonly #sessions = new Map<string, string>()
  readonly #seen = new Set<string>()

  constructor(ctx: Context, log: (message: string) => void) {
    this.#ctx = ctx
    this.#log = log
  }

  /**
   * Watch session events for tool results that carry the marker.
   *
   * The mapping is deliberately session→delegation, not the other way: the
   * marker arrives in a tool result before the notice can, and a notice that
   * lands while the parent is idle must still find its session.
   */
  bind(): () => void {
    const on = (this.#ctx as unknown as {
      on?: (name: string, handler: (session: unknown, event: unknown) => void) => () => void
    }).on
    if (typeof on !== 'function') return () => undefined
    return on.call(this.#ctx, 'session/event', (session, event) => {
      const id = this.#sessionId(session)
      if (id === null) return
      const match = MARKER.exec(JSON.stringify(toWire(event)))
      if (match === null) return
      this.#remember(match[1] as string, id)
    })
  }

  /** Deliver one notice from the desktop, if it maps to a live session. */
  deliver(notice: DelegationNoticeFrame): void {
    if (this.#seen.has(notice.id)) return
    this.#seen.add(notice.id)
    while (this.#seen.size > MAX_SEEN) {
      const oldest = this.#seen.values().next().value
      if (oldest === undefined) break
      this.#seen.delete(oldest)
    }
    const session = this.#sessions.get(notice.delegationId)
    if (session === undefined) {
      this.#log(`delegation notice ${notice.id}: no parent session for ${notice.delegationId}`)
      return
    }
    const agents = (this.#ctx as unknown as { get?: (name: string) => unknown }).get?.call(this.#ctx, 'agents') as
      | AgentsLike
      | undefined
    const agent = agents?.get?.(session)
    if (typeof agent?.followup !== 'function') {
      this.#log(`delegation notice ${notice.id}: the agents service cannot follow up`)
      return
    }
    const summary = notice.text.split('\n').find((line) => line.trim() !== '') ?? notice.kind
    try {
      const answer = agent.followup({
        content: [{ type: 'text', text: notice.text }],
        source: {
          kind: 'subagent-settled',
          form: 'notice',
          summary,
          senderSessionId: notice.delegationId,
        },
      })
      if (answer !== null && typeof answer === 'object' && 'catch' in answer) {
        ;(answer as Promise<unknown>).catch((error: unknown) => {
          this.#log(`delegation notice ${notice.id}: followup failed — ${String(error)}`)
        })
      }
    } catch (error) {
      this.#log(`delegation notice ${notice.id}: followup failed — ${String(error)}`)
    }
  }

  #remember(delegation: string, session: string): void {
    if (this.#sessions.get(delegation) === session) return
    this.#sessions.set(delegation, session)
    while (this.#sessions.size > MAX_LINKS) {
      const oldest = this.#sessions.keys().next().value
      if (oldest === undefined) break
      this.#sessions.delete(oldest)
    }
  }

  #sessionId(session: unknown): string | null {
    if (session === null || typeof session !== 'object') return null
    const id = (session as { id?: unknown }).id
    return typeof id === 'string' && id !== '' ? id : null
  }
}
