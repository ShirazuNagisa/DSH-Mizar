/**
 * The two waterfall answerers.
 *
 * Each registers with `prepend: true` so the phone is asked as a peer alongside
 * the desktop GUI rather than after it, then races the phone against the
 * delegated chain. See `interactions.ts` for why both of those choices are
 * load-bearing.
 *
 * The delegated outcome is only treated as a claim when it is a *real* answer.
 * The waterfall's terminal behaviour is "nobody answered" — `unavailable` for an
 * approval — and racing that verbatim would resolve instantly, meaning the phone
 * could never answer at all.
 *
 * @module dsh-mizar/bridge/answerers
 */
import type { Context } from '../dsh.js'
import {
  assertAnswerBatch,
  InteractionBroker,
  readApprovalRequest,
  readQuestionRequest,
  type ApprovalOutcome,
  type QuestionAnswerItem,
  type QuestionItem,
} from './interactions.js'

/** A promise that never settles; used to park a branch of a race. */
const NEVER = new Promise<never>(() => {})

/**
 * Somewhere to announce an interaction that has just been asked for.
 *
 * Narrow on purpose: the answerers know about approvals and questions, and
 * nothing about notifications, sockets or Apple. Everything past this interface
 * lives in `push/`.
 */
export interface InteractionListener {
  /**
   * An agent is blocked on a permission prompt.
   * @param input - the narrowed request.
   */
  approvalNeeded(input: { sessionId: string | null; toolName: string; reason?: string }): void
  /**
   * An agent is blocked on a question.
   * @param input - the narrowed request.
   */
  questionAsked(input: {
    sessionId: string | null
    callId: string
    questions: readonly QuestionItem[]
  }): void
}

/**
 * Register both answerers on the plugin's context.
 *
 * @param ctx - the plugin context; listeners are effect-scoped to it and leave
 *   with the plugin.
 * @param broker - the interaction broker delivering questions to clients.
 * @param notify - told about every request, whether or not a phone is connected.
 *   Absent in compositions with no notification transport.
 */
export function registerAnswerers(
  ctx: Context,
  broker: InteractionBroker,
  notify?: InteractionListener,
): void {
  // `approval/request` is a waterfall: return an outcome to claim, call `next()`
  // to delegate. Only `allowed-once` grants the action.
  ctx.on(
    'approval/request',
    ((request: unknown, next: () => Promise<ApprovalOutcome>) => {
      return (async (): Promise<ApprovalOutcome> => {
        const input = readApprovalRequest(request)
        // Announced **before** the client check, and that ordering is the whole
        // point. A phone whose app is in the background has no socket here, so
        // "nobody is connected" is not a reason to stay quiet -- it is the
        // situation a notification exists for.
        announce(notify, (listener) => listener.approvalNeeded(input))

        // With no phone connected there is nothing to ask, so stay a pure
        // pass-through and leave the existing channels exactly as they were.
        if (!broker.hasClients()) return await next()

        const signal = (request as { signal?: AbortSignal } | null)?.signal

        const handle = broker.beginApproval(input, signal)
        const delegated = next().then((outcome) => {
          // The waterfall's terminal behaviour is "nobody answered". Racing that
          // verbatim would resolve instantly and the phone could never answer,
          // so only a real outcome counts as a claim.
          if (outcome === 'unavailable') return NEVER
          return { from: 'delegated' as const, outcome }
        })

        let winner: { from: 'phone' | 'delegated'; outcome: ApprovalOutcome }
        try {
          winner = await Promise.race([
            handle.outcome.then((outcome) => ({ from: 'phone' as const, outcome })),
            delegated,
          ])
        } catch (error) {
          // A listener further down the waterfall threw. Nothing is going to
          // answer this now, so the phone must stop showing it: left pending, it
          // is a card for a decision nobody can take, held in the broker for the
          // life of the process.
          handle.abandon('unavailable')
          throw error
        }

        // Losing the race must not leave a card on the phone for a decision that
        // was already taken elsewhere.
        if (winner.from === 'delegated') handle.abandon(winner.outcome)
        return winner.outcome
      })()
    }) as never,
    { prepend: true },
  )

  // `user-questions/request` is the same shape, returning an answer batch.
  // Unlike an approval it also has a late path — `question.answer` — so an
  // unanswered batch here is not lost.
  ctx.on(
    'user-questions/request',
    ((request: unknown, next: () => Promise<Record<string, unknown>>) => {
      return (async (): Promise<Record<string, unknown>> => {
        const input = readQuestionRequest(request)
        // A batch with no call id could never be routed back, so there is
        // nothing to announce either.
        if (input !== null) {
          announce(notify, (listener) => listener.questionAsked(input))
        }

        if (!broker.hasClients()) return await next()

        // A batch with no call id could never be routed back, so delegate rather
        // than claim something this layer cannot complete.
        if (input === null) return await next()

        const signal = (request as { signal?: AbortSignal } | null)?.signal
        const handle = broker.beginQuestions(input, signal)

        const phone = handle.answers.then((answers) =>
          answers.length === 0 ? NEVER : { from: 'phone' as const, answer: { answers } },
        )
        const delegated = next().then((answer) => {
          const answers = (answer as { answers?: unknown } | null)?.answers
          if (!Array.isArray(answers) || answers.length === 0) return NEVER
          return { from: 'delegated' as const, answer }
        })

        const winner = await Promise.race([phone, delegated]).catch((error: unknown) => {
          // Same as the approval path: a throw from further down the waterfall
          // must not leave the batch pending here for the life of the process.
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

/**
 * Tell the listener about a request without letting it break the request.
 *
 * The announcement is best-effort by construction -- it is about state that is
 * already recorded -- so a listener that throws must not be able to fail an
 * approval. Swallowing here rather than inside each listener keeps that promise
 * in one place.
 *
 * @param notify - the listener, when there is one.
 * @param tell - what to tell it.
 */
function announce(
  notify: InteractionListener | undefined,
  tell: (listener: InteractionListener) => unknown,
): void {
  if (notify === undefined) return
  try {
    void Promise.resolve(tell(notify)).catch(() => {})
  } catch {
    // Deliberately swallowed; see above.
  }
}

/**
 * Validate an answer batch the phone sent for a batch it was already shown.
 *
 * The expected question ids come from the broker's pending view, so this checks
 * the reply against what was actually asked rather than against whatever the
 * client claims.
 *
 * @param broker - the interaction broker.
 * @param callId - the question batch being answered.
 * @param answers - the client's batch.
 * @returns whether the batch was accepted and delivered.
 * @throws MethodError when the batch does not name every question exactly once.
 */
export function deliverQuestionAnswers(
  broker: InteractionBroker,
  callId: string,
  answers: readonly QuestionAnswerItem[],
): boolean {
  const pending = broker.listQuestions().find((view) => view.callId === callId)
  if (pending === undefined) return false
  assertAnswerBatch(pending.questions, answers)
  return broker.answerQuestion(callId, answers)
}
