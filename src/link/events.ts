/**
 * The event half of DSH Link v1: a firehose, on purpose.
 *
 * 0.8.x summarised every session into a mobile-shaped page and shipped only that,
 * because the phone reached this computer over a relay and a full history was the
 * largest thing on the wire. The desktop is on the same machine, so the trade
 * flips: send the records, and let the side that draws them decide what they
 * mean. That is also what makes a new DSH event type visible without a new
 * plugin — there is no projection here to update.
 *
 * ### Two feeds
 *
 * - **`session/event`** is the post-commit append feed. Unscoped, so it sees
 *   every session including subagents and forks. This is the durable record.
 * - **`projection/changed`** is one client-visible projection unit changing for
 *   one session. It carries the running flags and titles the desktop's session
 *   list draws, without re-reading a page.
 *
 * Streaming deltas that have not been committed are not in either feed; the
 * desktop opens `session/follow` through the `invoke` channel when it is drawing
 * a live turn.
 *
 * @module dsh-mizar/link/events
 */
import type { Context } from '../dsh.js'
import { toWire, type FrameToDesktop } from './frames.js'

/** The slice of a `Session` these frames need. */
interface SessionLike {
  readonly id: string
  readonly header?: unknown
}

/** The slice of a committed record these frames need. */
interface EventLike {
  readonly type?: unknown
}

export class EventFeed {
  readonly #send: (frame: FrameToDesktop) => boolean
  readonly #logEvents: boolean
  #seq = 0

  constructor(send: (frame: FrameToDesktop) => boolean, logEvents: boolean) {
    this.#send = send
    this.#logEvents = logEvents
  }

  /**
   * Subscribe to both feeds.
   *
   * @param ctx - the plugin context; subscriptions leave with it.
   * @returns a disposer, for a mount that stops before the plugin does.
   */
  bind(ctx: Context): () => void {
    const offEvent = ctx.on(
      'session/event',
      ((session: SessionLike, event: EventLike) => {
        this.#forward(session, 'session/event', { header: session.header, event })
      }) as never,
    )

    const offProjection = ctx.sessionProjections.onChanged((session, key, value, seq) => {
      this.#forward(session as SessionLike, 'projection/changed', { key, value, seq })
    })

    return () => {
      offEvent()
      offProjection()
    }
  }

  /** Forward one record, allocating its sequence number. */
  #forward(session: SessionLike, name: string, payload: unknown): void {
    const frame: FrameToDesktop = {
      v: 1,
      type: 'event',
      seq: (this.#seq += 1),
      at: new Date().toISOString(),
      sessionId: typeof session?.id === 'string' ? session.id : null,
      name,
      payload: toWire(payload),
    }
    if (this.#logEvents) {
      console.log(`[mizar] event ${frame.seq} ${name} ${frame.sessionId ?? '-'}`)
    }
    this.#send(frame)
  }

  /** The sequence number of the last forwarded record. Diagnostics only. */
  get sequence(): number {
    return this.#seq
  }
}
