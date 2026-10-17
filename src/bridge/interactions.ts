/**
 * Approval and question brokering.
 *
 * These are the two interactions that make remote *guidance* possible: an agent
 * that stops to ask permission, and an agent that stops to ask a question. Both
 * are Cordis **waterfall** events on the host, and both are already answered by
 * whatever else is composed — the desktop GUI, through the forwarded `$events`
 * source, and the built-in terminal answerer.
 *
 * ### Why this registers with `prepend: true`
 *
 * A waterfall runs its listeners outermost-first and stops at the first one that
 * does not call `next()`. Registration order is mount order, and this plugin
 * mounts *after* the API layer, so a plainly registered listener would only ever
 * run when nobody else claimed the request — which, with the desktop GUI open,
 * is never. The phone would silently never see an approval. Prepending puts the
 * phone in the race as a peer rather than as a last resort.
 *
 * ### Why `next()` is raced rather than awaited
 *
 * The waterfall's terminal `next()` returns the event's built-in behaviour,
 * which for both of these is "nobody is answering" — `unavailable` for an
 * approval. Racing that directly would resolve instantly and the phone could
 * never answer. So the delegated outcome is treated as *a claim only when it is
 * a real answer*, and `unavailable` is read as "the rest of the chain declined",
 * leaving the phone's question outstanding.
 *
 * The result is the documented multi-client semantic: every channel is asked at
 * once and the first real answer wins.
 *
 * @module dsh-mizar/bridge/interactions
 */
import { randomUUID } from 'node:crypto'
import type { Context } from '../dsh.js'
import { PROTOCOL_VERSION, type ServerFrame } from '../protocol/frames.js'
import { MethodError } from './method-error.js'

/** Outcomes a client may choose for an approval. */
export const CLIENT_APPROVAL_OUTCOMES = ['allowed-once', 'rejected'] as const
/** One client-chosen approval outcome. */
export type ClientApprovalOutcome = (typeof CLIENT_APPROVAL_OUTCOMES)[number]
/** The full outcome vocabulary DSH accepts. */
export type ApprovalOutcome = ClientApprovalOutcome | 'cancelled' | 'unavailable'

/** One option of a question. */
export interface QuestionOption {
  readonly label: string
  readonly description?: string
}

/** One question in a batch. */
export interface QuestionItem {
  readonly id: string
  readonly question: string
  readonly detail?: string
  readonly header?: string
  readonly options: readonly QuestionOption[]
  readonly multiSelect: boolean
  /** Set when the question is a plan awaiting approval. */
  readonly intent: { kind: 'plan-review'; approve: string } | null
}

/** A pending approval, as shown to the phone. */
export interface PendingApprovalView {
  readonly requestId: string
  readonly sessionId: string | null
  readonly toolName: string
  readonly callId: string | null
  readonly reason: string | null
  /** Localized presentation text, when the requesting tool supplied one. */
  readonly displayReason: Record<string, string> | null
  /** Epoch milliseconds the host first asked. */
  readonly requestedAt: number
}

/** A pending question batch, as shown to the phone. */
export interface PendingQuestionView {
  readonly callId: string
  readonly sessionId: string | null
  readonly questions: readonly QuestionItem[]
  readonly requestedAt: number
}

/** The answer to one question item. */
export interface QuestionAnswerItem {
  readonly id: string
  readonly selected: readonly string[]
  readonly custom?: string
}

/** A handle on one outstanding approval. */
export interface ApprovalHandle {
  /** The id the phone answers with. */
  readonly requestId: string
  /** Settles with the outcome, whenever it arrives. */
  readonly outcome: Promise<ApprovalOutcome>
  /**
   * Withdraw the question without answering it, reporting how it was settled.
   * @param outcome - the outcome another channel produced.
   */
  abandon(outcome: ApprovalOutcome): void
}

/** A handle on one outstanding question batch. */
export interface QuestionHandle {
  /** The call id the phone answers with. */
  readonly callId: string
  /** Settles with the answers, empty when withdrawn. */
  readonly answers: Promise<readonly QuestionAnswerItem[]>
  /** Withdraw the question without answering it. */
  abandon(): void
}

/** One in-flight approval. */
interface PendingApproval {
  readonly view: PendingApprovalView
  readonly settle: (outcome: ApprovalOutcome) => void
  readonly promise: Promise<ApprovalOutcome>
}

/** One in-flight question batch. */
interface PendingQuestion {
  readonly view: PendingQuestionView
  readonly settle: (answer: Record<string, unknown>) => void
  readonly promise: Promise<Record<string, unknown>>
}

/**
 * Route one interaction to every connected client and take the first answer.
 *
 * The broker is transport-agnostic: it is handed a `send` function by the host
 * once the listener is up, and it holds no reference to the socket layer.
 */
/**
 * A Map that reports every change to it.
 *
 * The alternative was calling a notify function from each of the twelve places
 * this broker mutates its pending sets, which is correct until somebody adds a
 * thirteenth -- and a missed one is not a dropped notification, it is a phone
 * that shows a card for a request that was already answered, forever. Wrapping
 * the container covers the existing sites and every future one by construction.
 *
 * @typeParam Value - what the map holds.
 */
class TrackedMap<Value> extends Map<string, Value> {
  readonly #onChange: () => void

  constructor(onChange: () => void) {
    super()
    this.#onChange = onChange
  }

  override set(key: string, value: Value): this {
    super.set(key, value)
    this.#onChange()
    return this
  }

  override delete(key: string): boolean {
    const removed = super.delete(key)
    // Only a real removal is a change; settling an id that is already gone is
    // the normal case when two answerers race.
    if (removed) this.#onChange()
    return removed
  }

  override clear(): void {
    const had = this.size > 0
    super.clear()
    if (had) this.#onChange()
  }
}

export class InteractionBroker {
  #send: (frame: ServerFrame) => void = () => {}
  #clients = 0
  #nextApprovalId = 0
  readonly #approvals = new TrackedMap<PendingApproval>(() => {
    this.#notifyPendingChanged()
  })
  readonly #questions = new TrackedMap<PendingQuestion>(() => {
    this.#notifyPendingChanged()
  })

  /**
   * Tell connected clients that the pending set moved.
   *
   * Pushed rather than left to the client's poll, because the operator is not the
   * only thing waiting: an agent blocked on an approval is stopped until
   * somebody answers, and every second the phone spends not knowing is a second
   * of a stalled turn. The frame carries only counts -- the client re-reads
   * `interactions.pending` for the detail, so the notification cannot go stale
   * the way a payload would.
   *
   * Nothing is sent when no client is connected: there is nobody to tell, and
   * the request remains visible through {@link listApprovals}.
   */
  #notifyPendingChanged(): void {
    if (this.#clients <= 0) return
    this.#emit({
      v: PROTOCOL_VERSION,
      type: 'event',
      event: 'interactions.changed',
      data: { approvals: this.#approvals.size, questions: this.#questions.size },
    })
  }

  /**
   * Send one frame, absorbing a transport failure.
   *
   * Every notification goes through here. Before, a throwing sender propagated
   * out of `beginApproval` and out of the settle path and into the answerer --
   * so a socket hiccup could fail the approval itself, not merely its
   * announcement. A notification is best-effort by nature; the state it
   * describes is not, and the two must not be able to take each other down.
   *
   * @param frame - the frame to deliver.
   */
  #emit(frame: ServerFrame): void {
    try {
      this.#send(frame)
    } catch {
      // Deliberately swallowed: the pending set is already updated, and the
      // client will pick it up on its next read.
    }
  }

  /**
   * Attach the transport. Called once the listener is listening; before that,
   * notifications are dropped rather than queued, because a client that is not
   * connected cannot answer anyway and the request is still visible through
   * {@link listPending}.
   * @param send - delivers one frame to every authenticated client.
   */
  setSender(send: (frame: ServerFrame) => void): void {
    this.#send = send
  }

  /** Whether any authenticated client could answer right now. */
  hasClients(): boolean {
    return this.#clients > 0
  }

  /**
   * Report the current authenticated client count.
   *
   * Dropping to zero is a fail-closed trigger rather than a silent state change:
   * an approval is a one-shot decision tied to an open turn, with no late-answer
   * path, so a phone that vanished mid-question must not leave the agent
   * waiting forever. Pending approvals settle `unavailable` — the same outcome
   * DSH itself uses when there is no answerer — and pending questions settle
   * empty, which the host records as unanswered.
   *
   * This can preempt a desktop UI that is still showing the card. That is the
   * deliberate trade: a refused tool action is recoverable, a hung agent is not.
   *
   * @param count - the number of authenticated clients.
   */
  setClientCount(count: number): void {
    this.#clients = Math.max(0, count)
    if (this.#clients > 0) return

    for (const [requestId, entry] of [...this.#approvals]) {
      this.#approvals.delete(requestId)
      this.#emit({
        v: 1,
        type: 'event',
        event: 'approval.resolved',
        data: { requestId, outcome: 'unavailable' },
      })
      entry.settle('unavailable')
    }
    for (const [callId, entry] of [...this.#questions]) {
      this.#questions.delete(callId)
      entry.settle({ answers: [] })
    }
  }

  /** Every approval still awaiting an answer. */
  listApprovals(): PendingApprovalView[] {
    return [...this.#approvals.values()].map((entry) => entry.view)
  }

  /** Every question batch still awaiting an answer. */
  listQuestions(): PendingQuestionView[] {
    return [...this.#questions.values()].map((entry) => entry.view)
  }

  /**
   * Answer one pending approval.
   * @param requestId - the approval to answer.
   * @param outcome - the client's choice.
   * @returns whether the approval was still pending.
   */
  answerApproval(requestId: string, outcome: ClientApprovalOutcome): boolean {
    const entry = this.#approvals.get(requestId)
    if (entry === undefined) return false
    // Delete first: a double tap must not settle twice.
    this.#approvals.delete(requestId)
    this.#emit({ v: 1, type: 'event', event: 'approval.resolved', data: { requestId, outcome } })
    entry.settle(outcome)
    return true
  }

  /**
   * Answer one pending question batch.
   * @param callId - the question batch to answer.
   * @param answers - one entry per question, naming each exactly once.
   * @returns whether the question was still pending here.
   */
  answerQuestion(callId: string, answers: readonly QuestionAnswerItem[]): boolean {
    const entry = this.#questions.get(callId)
    if (entry === undefined) return false
    this.#questions.delete(callId)
    this.#emit({ v: 1, type: 'event', event: 'question.resolved', data: { callId } })
    entry.settle({ answers })
    return true
  }

  /** Release everything still pending, for plugin unload. */
  dispose(): void {
    for (const entry of this.#approvals.values()) entry.settle('cancelled')
    this.#approvals.clear()
    for (const entry of this.#questions.values()) entry.settle({ answers: [] })
    this.#questions.clear()
  }

  /**
   * Ask the phone for an approval decision.
   *
   * Returns a handle rather than a bare promise so a caller that loses a race to
   * another channel can {@link ApprovalHandle.abandon} the question. Without
   * that, the phone keeps showing a card for a decision already taken
   * elsewhere — and the pending entry leaks for the life of the process.
   *
   * @param input - the agent's request, already narrowed from the Cordis event.
   * @param signal - aborts when the requesting tool withdraws the question.
   * @returns the request id and its outcome promise.
   */
  beginApproval(
    input: {
      sessionId: string | null
      toolName: string
      callId?: string
      reason?: string
      displayReason?: Record<string, string>
    },
    signal?: AbortSignal,
  ): ApprovalHandle {
    const requestId = `ap-${Date.now().toString(36)}-${(this.#nextApprovalId += 1).toString(36)}`

    let settle: (outcome: ApprovalOutcome) => void = () => {}
    const promise = new Promise<ApprovalOutcome>((resolve) => {
      settle = resolve
    })

    if (signal?.aborted === true) {
      return { requestId, outcome: Promise.resolve('cancelled'), abandon: () => {} }
    }

    const view: PendingApprovalView = {
      requestId,
      sessionId: input.sessionId,
      toolName: input.toolName,
      callId: input.callId ?? null,
      reason: input.reason ?? null,
      displayReason: input.displayReason ?? null,
      requestedAt: Date.now(),
    }
    this.#approvals.set(requestId, { view, settle, promise })
    this.#emit({ v: 1, type: 'event', event: 'approval.request', data: view })

    let onAbort: (() => void) | undefined
    const cancelled = new Promise<ApprovalOutcome>((resolve) => {
      onAbort = () => {
        this.#resolve(requestId, 'cancelled')
        resolve('cancelled')
      }
      signal?.addEventListener('abort', onAbort, { once: true })
    })

    const outcome = Promise.race([promise, cancelled]).finally(() => {
      if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
      this.#approvals.delete(requestId)
    })

    return {
      requestId,
      outcome,
      abandon: (answer) => {
        // Only announce if the entry was still ours: an answer that arrived
        // first has already told the clients.
        if (this.#approvals.delete(requestId)) {
          this.#emit({
            v: 1,
            type: 'event',
            event: 'approval.resolved',
            data: { requestId, outcome: answer, by: 'other' },
          })
        }
        settle(answer)
      },
    }
  }

  /**
   * Clear one pending approval and tell clients how it was settled.
   * @param requestId - the approval to settle.
   * @param outcome - the outcome to report.
   */
  #resolve(requestId: string, outcome: ApprovalOutcome): void {
    const entry = this.#approvals.get(requestId)
    if (entry === undefined) return
    this.#approvals.delete(requestId)
    this.#emit({ v: 1, type: 'event', event: 'approval.resolved', data: { requestId, outcome } })
    entry.settle(outcome)
  }

  /**
   * Ask the phone for answers to a question batch.
   *
   * There is no window of its own: the asking tool's signal is what withdraws a
   * batch, and a timer here would settle a question the operator can still
   * answer. (A constant claiming otherwise used to live above this class and was
   * read by nothing.)
   *
   * @param input - the question batch, already narrowed from the Cordis event.
   * @param signal - aborts when the asking tool withdraws.
   * @returns the call id and its answer promise.
   */
  beginQuestions(
    input: {
      sessionId: string | null
      callId: string
      questions: readonly QuestionItem[]
    },
    signal?: AbortSignal,
  ): QuestionHandle {
    const empty = Promise.resolve([] as readonly QuestionAnswerItem[])
    if (signal?.aborted === true) {
      return { callId: input.callId, answers: empty, abandon: () => {} }
    }

    let settle: (answer: Record<string, unknown>) => void = () => {}
    const promise = new Promise<Record<string, unknown>>((resolve) => {
      settle = resolve
    })

    let onAbort: (() => void) | undefined

    const view: PendingQuestionView = {
      callId: input.callId,
      sessionId: input.sessionId,
      questions: input.questions,
      requestedAt: Date.now(),
    }
    this.#questions.set(input.callId, { view, settle, promise })
    this.#emit({ v: 1, type: 'event', event: 'question.request', data: view })

    const withdrawn = new Promise<Record<string, unknown>>((resolve) => {
      onAbort = () => resolve({ answers: [] })
      signal?.addEventListener('abort', onAbort, { once: true })
    })

    const answers = Promise.race([promise, withdrawn])
      .then((value) => {
        const list = (value as { answers?: unknown }).answers
        return Array.isArray(list) ? (list as QuestionAnswerItem[]) : []
      })
      .finally(() => {
        // Off the signal the caller owns, which outlives this batch: a listener
        // left on it accumulates one closure per question ever asked, and past
        // ten Node starts saying so in the operator's log.
        if (onAbort !== undefined) signal?.removeEventListener('abort', onAbort)
        this.#questions.delete(input.callId)
      })

    return {
      callId: input.callId,
      answers,
      abandon: () => {
        if (this.#questions.delete(input.callId)) {
          this.#emit({
            v: 1,
            type: 'event',
            event: 'question.resolved',
            data: { callId: input.callId, by: 'other' },
          })
        }
        settle({ answers: [] })
      },
    }
  }
}

/**
 * Narrow a raw `approval/request` event into the broker's input.
 * @param request - the Cordis event payload.
 * @returns the narrowed input.
 */
export function readApprovalRequest(request: unknown): {
  sessionId: string | null
  toolName: string
  callId?: string
  reason?: string
  displayReason?: Record<string, string>
} {
  const record = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>
  const agent = record['agent'] as { id?: unknown } | undefined
  const sessionId = typeof agent?.id === 'string' ? agent.id : null
  const displayReason =
    typeof record['displayReason'] === 'object' && record['displayReason'] !== null
      ? (record['displayReason'] as Record<string, string>)
      : undefined

  return {
    sessionId,
    toolName: typeof record['toolName'] === 'string' ? record['toolName'] : 'unknown tool',
    ...(typeof record['callId'] === 'string' ? { callId: record['callId'] } : {}),
    ...(typeof record['reason'] === 'string' ? { reason: record['reason'] } : {}),
    ...(displayReason === undefined ? {} : { displayReason }),
  }
}

/**
 * Narrow a raw `user-questions/request` event into the broker's input.
 *
 * ### The shapes this has to survive
 *
 * Measured on a real host, not guessed: the request that reaches this listener is
 * flat and carries **no call id at all** —
 *
 * ```json
 * { "questions": [ … ], "agent": { "id": "session-…" }, "signal": … }
 * ```
 *
 * so an earlier version of this function, which demanded `wait.callId` (or a
 * top-level `callId`), returned `null` for every real question. The answerer treats
 * `null` as "nothing this layer can complete" and delegates, so the batch was never
 * registered, `interactions.pending` stayed empty, and no client could ever show a
 * question. Every test passed because the fixtures carried a call id the host does
 * not send on this path.
 *
 * Three shapes are accepted, in this order of preference: the host's own id when it
 * supplies one (which the *late* answer path keys on, so it must win when present),
 * a nested `request.callId`, and finally an id minted here.
 *
 * A minted id is safe because the id is only an opaque string the client echoes
 * back: the broker registers its handle under it and `question.answer` settles that
 * same handle. It is prefixed so a log makes clear which ids came from the host.
 *
 * @param request - the Cordis event payload.
 * @returns the narrowed input, or `null` when there is nothing answerable in it.
 */
export function readQuestionRequest(request: unknown): {
  sessionId: string | null
  callId: string
  questions: QuestionItem[]
} | null {
  const record = (typeof request === 'object' && request !== null ? request : {}) as Record<string, unknown>
  // Some paths nest the real request (`ask({ request, wait })`); accept that too
  // rather than fall back to `null` for a shape that merely moved.
  const inner = (
    typeof record['request'] === 'object' && record['request'] !== null ? record['request'] : {}
  ) as Record<string, unknown>

  const agent = (record['agent'] ?? inner['agent']) as { id?: unknown } | undefined
  const sessionId = typeof agent?.id === 'string' ? agent.id : null

  const wait = record['wait'] as { callId?: unknown } | undefined
  const supplied =
    typeof wait?.callId === 'string' && wait.callId !== ''
      ? wait.callId
      : typeof record['callId'] === 'string' && record['callId'] !== ''
        ? record['callId']
        : typeof inner['callId'] === 'string' && inner['callId'] !== ''
          ? inner['callId']
          : undefined
  const callId = supplied ?? `mizar-${randomUUID()}`

  const rawQuestions = Array.isArray(record['questions'])
    ? (record['questions'] as unknown[])
    : Array.isArray(inner['questions'])
      ? (inner['questions'] as unknown[])
      : []
  const questions: QuestionItem[] = rawQuestions
    .map((entry): QuestionItem | null => {
      if (typeof entry !== 'object' || entry === null) return null
      const item = entry as Record<string, unknown>
      if (typeof item['id'] !== 'string' || item['id'] === '') return null
      const rawOptions = Array.isArray(item['options']) ? (item['options'] as unknown[]) : []
      const options: QuestionOption[] = rawOptions
        .map((option): QuestionOption | null => {
          if (typeof option !== 'object' || option === null) return null
          const candidate = option as Record<string, unknown>
          if (typeof candidate['label'] !== 'string') return null
          return {
            label: candidate['label'],
            ...(typeof candidate['description'] === 'string'
              ? { description: candidate['description'] }
              : {}),
          }
        })
        .filter((option): option is QuestionOption => option !== null)

      const intent = item['intent'] as { kind?: unknown; approve?: unknown } | undefined
      return {
        id: item['id'],
        question: typeof item['question'] === 'string' ? item['question'] : '',
        ...(typeof item['detail'] === 'string' ? { detail: item['detail'] } : {}),
        ...(typeof item['header'] === 'string' ? { header: item['header'] } : {}),
        options,
        multiSelect: item['multiSelect'] === true,
        intent:
          intent?.kind === 'plan-review' && typeof intent.approve === 'string'
            ? { kind: 'plan-review', approve: intent.approve }
            : null,
      }
    })
    .filter((item): item is QuestionItem => item !== null)

  if (questions.length === 0) return null
  return { sessionId, callId, questions }
}

/**
 * Validate a client's answer batch against the questions it answers.
 *
 * DSH requires the batch to name every question of the call exactly once, and
 * rejects the whole reply otherwise, so the check happens here rather than
 * letting the host refuse a reply the operator already committed to.
 *
 * @param questions - the questions that were asked.
 * @param answers - the client's batch.
 * @throws MethodError when the batch does not match.
 */
export function assertAnswerBatch(
  questions: readonly QuestionItem[],
  answers: readonly QuestionAnswerItem[],
): void {
  const expected = new Set(questions.map((question) => question.id))
  const seen = new Set<string>()
  for (const answer of answers) {
    if (!expected.has(answer.id)) {
      throw new MethodError('MALFORMED_FRAME', `answer names unknown question "${answer.id}"`)
    }
    if (seen.has(answer.id)) {
      throw new MethodError('MALFORMED_FRAME', `answer names question "${answer.id}" twice`)
    }
    seen.add(answer.id)
  }
  for (const question of questions) {
    if (!seen.has(question.id)) {
      throw new MethodError('MALFORMED_FRAME', `answer omits question "${question.id}"`)
    }
  }
}

/** Re-exported so the wiring module can build the Cordis listener signature. */
export type { Context }
