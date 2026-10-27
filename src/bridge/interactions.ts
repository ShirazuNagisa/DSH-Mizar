/**
 * Approvals and questions: the two interactions that make remote guidance real.
 *
 * Both are Cordis **waterfall** events, and both are already answered by other
 * channels — the desktop GUI and the built-in terminal answerer. The rules below
 * are the ones `decision-0002` measured; each exists because the obvious version
 * was wrong.
 *
 * 1. **`prepend: true`.** Registration order is mount order, and this plugin
 *    mounts after the API layer. A plain listener would only run once every
 *    earlier listener had called `next()` — i.e. never, while the GUI is open.
 * 2. **`hasDesktop()` short-circuit.** With nothing connected, this plugin must
 *    change nothing at all: pure pass-through.
 * 3. **`unavailable` is not an answer.** The waterfall's terminal behaviour is
 *    "nobody answered", and it resolves immediately. Racing it verbatim would
 *    mean the desktop could never answer.
 * 4. **Losing the race abandons the request.** Otherwise the desktop keeps
 *    showing a card for a decision already taken, and the entry leaks for the
 *    life of the process.
 * 5. **Dropping to zero settles everything.** An approval is one-shot and tied to
 *    an open turn; a desktop that vanished must not leave an agent waiting. A
 *    refused tool action is recoverable, a hung agent is not.
 *
 * The 0.9.0 difference is only in transport: requests go out as raw DSH payloads
 * over the link instead of being narrowed into Mizar views. Nothing here
 * interprets what an approval is about.
 *
 * @module dsh-mizar/bridge/interactions
 */
import type { Context } from '../dsh.js'
import { toWire, type FrameToDesktop } from '../link/frames.js'
import { LINK_REFUSED, LinkError } from './errors.js'

/** Outcomes a desktop may choose. `cancelled` and `unavailable` are host-side. */
export const CLIENT_APPROVAL_OUTCOMES = ['allowed-once', 'rejected'] as const
/** One desktop-chosen approval outcome. */
export type ClientApprovalOutcome = (typeof CLIENT_APPROVAL_OUTCOMES)[number]
/** The full outcome vocabulary DSH accepts. */
export type ApprovalOutcome = ClientApprovalOutcome | 'cancelled' | 'unavailable'

/** A promise that never settles; parks one branch of a race. */
const NEVER = new Promise<never>(() => {})

/** A handle on one outstanding approval. */
export interface ApprovalHandle {
  readonly id: string
  readonly outcome: Promise<ApprovalOutcome>
  /** Withdraw without answering, reporting how it was settled elsewhere. */
  abandon(outcome: ApprovalOutcome): void
}

/** A handle on one outstanding question batch. */
export interface QuestionHandle {
  readonly id: string
  readonly answers: Promise<readonly unknown[]>
  /** Withdraw without answering. */
  abandon(): void
}

interface PendingApproval {
  readonly request: unknown
  readonly settle: (outcome: ApprovalOutcome) => void
}

interface PendingQuestion {
  readonly request: unknown
  /** The question ids this batch asked, for validating a reply. */
  readonly ids: readonly string[]
  readonly settle: (answers: readonly unknown[]) => void
}

/**
 * Route interactions to the desktop and take the first answer.
 *
 * Transport-agnostic: the sender is attached once the link exists, and a link
 * that goes away is reported through {@link setConnected}.
 */
export class InteractionBroker {
  #send: (frame: FrameToDesktop) => boolean = () => false
  #connected = false
  #counter = 0
  readonly #approvals = new Map<string, PendingApproval>()
  readonly #questions = new Map<string, PendingQuestion>()

  /** Attach the link. Before this, requests are recorded but not announced. */
  setSender(send: (frame: FrameToDesktop) => boolean): void {
    this.#send = send
  }

  /** Whether a desktop could answer right now. */
  hasDesktop(): boolean {
    return this.#connected
  }

  /**
   * Report the link's state.
   *
   * Going down settles every pending interaction — `unavailable` for approvals,
   * an empty batch for questions. Coming up re-announces whatever is still
   * pending, which after a down transition is nothing; the re-announce exists for
   * a reconnect that never observed the down edge.
   *
   * @param connected - whether the handshake is currently complete.
   */
  setConnected(connected: boolean): void {
    const was = this.#connected
    this.#connected = connected
    if (connected) {
      if (!was) this.republish()
      return
    }
    if (!was) return

    for (const [id, entry] of [...this.#approvals]) {
      this.#approvals.delete(id)
      entry.settle('unavailable')
    }
    for (const [id, entry] of [...this.#questions]) {
      this.#questions.delete(id)
      entry.settle([])
    }
  }

  /** Re-send every pending request, for a desktop that just connected. */
  republish(): void {
    for (const [id, entry] of this.#approvals) {
      this.#send({ v: 1, type: 'approval', id, request: toWire(entry.request) })
    }
    for (const [id, entry] of this.#questions) {
      this.#send({ v: 1, type: 'question', id, request: toWire(entry.request) })
    }
  }

  /**
   * Ask the desktop for an approval decision.
   * @param request - DSH's own payload, forwarded as-is.
   * @param signal - aborts when the requesting tool withdraws.
   */
  beginApproval(request: unknown, signal?: AbortSignal): ApprovalHandle {
    const id = `ap-${Date.now().toString(36)}-${(this.#counter += 1).toString(36)}`
    if (signal?.aborted === true) {
      return { id, outcome: Promise.resolve('cancelled'), abandon: () => {} }
    }

    let settle: (outcome: ApprovalOutcome) => void = () => {}
    const promise = new Promise<ApprovalOutcome>((resolve) => {
      settle = resolve
    })
    this.#approvals.set(id, { request, settle })
    this.#send({ v: 1, type: 'approval', id, request: toWire(request) })

    let onAbort: (() => void) | undefined
    const cancelled = new Promise<ApprovalOutcome>((resolve) => {
      onAbort = () => {
        this.#approvals.delete(id)
        settle('cancelled')
        resolve('cancelled')
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })

    const outcome = Promise.race([promise, cancelled]).finally(() => {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
      this.#approvals.delete(id)
    })

    return {
      id,
      outcome,
      abandon: (answer) => {
        this.#approvals.delete(id)
        settle(answer)
      },
    }
  }

  /**
   * Ask the desktop for answers to a question batch.
   * @param request - DSH's own payload, forwarded as-is.
   * @param ids - the question ids in the batch, for validating the reply.
   * @param signal - aborts when the asking tool withdraws.
   */
  beginQuestions(request: unknown, ids: readonly string[], signal?: AbortSignal): QuestionHandle {
    const id = `qs-${Date.now().toString(36)}-${(this.#counter += 1).toString(36)}`
    if (signal?.aborted === true) {
      return { id, answers: Promise.resolve([]), abandon: () => {} }
    }

    let settle: (answers: readonly unknown[]) => void = () => {}
    const promise = new Promise<readonly unknown[]>((resolve) => {
      settle = resolve
    })
    this.#questions.set(id, { request, ids, settle })
    this.#send({ v: 1, type: 'question', id, request: toWire(request) })

    let onAbort: (() => void) | undefined
    const withdrawn = new Promise<readonly unknown[]>((resolve) => {
      onAbort = () => resolve([])
      signal?.addEventListener('abort', onAbort, { once: true })
    })

    const answers = Promise.race([promise, withdrawn]).finally(() => {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
      this.#questions.delete(id)
    })

    return {
      id,
      answers,
      abandon: () => {
        this.#questions.delete(id)
        settle([])
      },
    }
  }

  /**
   * Apply one answer frame.
   *
   * @param id - the request id the desktop was given.
   * @param frame - the answer, as parsed from the link.
   * @returns whether it settled something still pending.
   * @throws LinkError when a question reply does not name each question once.
   */
  answer(id: string, frame: { outcome?: string; answers?: readonly unknown[] }): boolean {
    const approval = this.#approvals.get(id)
    if (approval !== undefined) {
      const outcome = frame.outcome
      if (outcome !== 'allowed-once' && outcome !== 'rejected') {
        throw new LinkError(LINK_REFUSED, `approval "${id}" needs outcome allowed-once or rejected`)
      }
      this.#approvals.delete(id)
      approval.settle(outcome)
      return true
    }

    const question = this.#questions.get(id)
    if (question !== undefined) {
      const answers = Array.isArray(frame.answers) ? frame.answers : []
      assertAnswerBatch(question.ids, answers)
      this.#questions.delete(id)
      question.settle(answers)
      return true
    }

    return false
  }

  /** Release everything still pending, for plugin unload. */
  dispose(): void {
    for (const entry of this.#approvals.values()) entry.settle('cancelled')
    this.#approvals.clear()
    for (const entry of this.#questions.values()) entry.settle([])
    this.#questions.clear()
  }

  /** The approvals still awaiting an answer. Diagnostics only. */
  get pendingApprovals(): number {
    return this.#approvals.size
  }

  /** The question batches still awaiting an answer. Diagnostics only. */
  get pendingQuestions(): number {
    return this.#questions.size
  }
}

/**
 * Check a reply against the questions that were actually asked.
 *
 * DSH rejects a whole batch that does not name every question exactly once, so
 * catching it here avoids discarding an answer the operator already committed to.
 *
 * @param ids - the question ids from the request.
 * @param answers - the desktop's batch.
 * @throws LinkError when the batch does not match.
 */
export function assertAnswerBatch(ids: readonly string[], answers: readonly unknown[]): void {
  const expected = new Set(ids)
  const seen = new Set<string>()
  for (const answer of answers) {
    const id =
      typeof answer === 'object' && answer !== null
        ? (answer as Record<string, unknown>)['id']
        : undefined
    if (typeof id !== 'string' || !expected.has(id)) {
      throw new LinkError(LINK_REFUSED, `answer names unknown question "${String(id)}"`)
    }
    if (seen.has(id)) {
      throw new LinkError(LINK_REFUSED, `answer names question "${id}" twice`)
    }
    seen.add(id)
  }
  for (const id of ids) {
    if (!seen.has(id)) throw new LinkError(LINK_REFUSED, `answer omits question "${id}"`)
  }
}

/**
 * Pull the question ids out of a `user-questions/request` payload.
 *
 * Measured shapes, not guesses: the real request is flat and often carries no
 * call id at all. Both are accepted, and a batch with no questions is `null` —
 * there would be nothing to answer.
 *
 * @param request - the Cordis event payload.
 * @returns the ids, or `null` when the payload has no answerable batch.
 */
export function readQuestionIds(request: unknown): string[] | null {
  const record = (typeof request === 'object' && request !== null ? request : {}) as Record<
    string,
    unknown
  >
  const inner = (
    typeof record['request'] === 'object' && record['request'] !== null ? record['request'] : {}
  ) as Record<string, unknown>

  const raw = Array.isArray(record['questions'])
    ? (record['questions'] as unknown[])
    : Array.isArray(inner['questions'])
      ? (inner['questions'] as unknown[])
      : []
  const ids = raw
    .map((entry) =>
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)['id']
        : undefined,
    )
    .filter((id): id is string => typeof id === 'string' && id !== '')

  return ids.length === 0 ? null : ids
}

/**
 * Register both waterfall answerers.
 *
 * @param ctx - the plugin context; listeners leave with it.
 * @param broker - the interaction broker.
 */
export function registerAnswerers(ctx: Context, broker: InteractionBroker): void {
  // `approval/request` is a waterfall: return an outcome to claim, call `next()`
  // to delegate. Only `allowed-once` grants the action.
  ctx.on(
    'approval/request',
    ((request: unknown, next: () => Promise<ApprovalOutcome>) => {
      return (async (): Promise<ApprovalOutcome> => {
        // With nothing connected there is nothing to ask, so stay a pure
        // pass-through and leave the existing channels exactly as they were.
        if (!broker.hasDesktop()) return await next()

        const signal = (request as { signal?: AbortSignal } | null)?.signal
        const handle = broker.beginApproval(request, signal)

        const delegated = next().then((outcome) => {
          // The terminal behaviour is "nobody answered"; racing it verbatim
          // would resolve instantly and the desktop could never answer.
          if (outcome === 'unavailable') return NEVER
          return { from: 'delegated' as const, outcome }
        })

        let winner: { from: 'desktop' | 'delegated'; outcome: ApprovalOutcome }
        try {
          winner = await Promise.race([
            handle.outcome.then((outcome) => ({ from: 'desktop' as const, outcome })),
            delegated,
          ])
        } catch (error) {
          // A listener further down threw. Nothing will answer this now, so the
          // desktop must stop showing it.
          handle.abandon('unavailable')
          throw error
        }

        if (winner.from === 'delegated') handle.abandon(winner.outcome)
        return winner.outcome
      })()
    }) as never,
    { prepend: true },
  )

  // `user-questions/request` is the same shape, returning an answer batch.
  ctx.on(
    'user-questions/request',
    ((request: unknown, next: () => Promise<Record<string, unknown>>) => {
      return (async (): Promise<Record<string, unknown>> => {
        if (!broker.hasDesktop()) return await next()

        const ids = readQuestionIds(request)
        // A batch with no questions could never be answered, so delegate rather
        // than claim something this layer cannot complete.
        if (ids === null) return await next()

        const signal = (request as { signal?: AbortSignal } | null)?.signal
        const handle = broker.beginQuestions(request, ids, signal)

        const desktop = handle.answers.then((answers) =>
          answers.length === 0 ? NEVER : { from: 'desktop' as const, answer: { answers } },
        )
        const delegated = next().then((answer) => {
          const answers = (answer as { answers?: unknown } | null)?.answers
          if (!Array.isArray(answers) || answers.length === 0) return NEVER
          return { from: 'delegated' as const, answer }
        })

        const winner = await Promise.race([desktop, delegated]).catch((error: unknown) => {
          handle.abandon()
          throw error
        })
        if (winner.from === 'delegated') handle.abandon()
        return winner.answer
      })()
    }) as never,
    { prepend: true },
  )
}
