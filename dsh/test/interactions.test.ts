/**
 * Tests for approval and question brokering.
 *
 * The decisions worth pinning here are the ones a reader would otherwise have
 * to re-derive from DSH's waterfall implementation:
 *
 *   - the phone is asked as a *peer*, not as a fallback, so the answerer is
 *     registered `prepend`;
 *   - a terminal `next()` returning "nobody answered" must **not** preempt a
 *     question the phone is still being asked;
 *   - a phone that disconnects mid-approval settles it rather than leaving an
 *     agent holding a turn open forever.
 *
 * @module dsh-mizar/test/interactions
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '../src/dsh.js'
import { registerAnswerers } from '../src/bridge/answerers.js'
import {
  assertAnswerBatch,
  InteractionBroker,
  readApprovalRequest,
  readQuestionRequest,
  type QuestionItem,
} from '../src/bridge/interactions.js'
import type { ServerFrame } from '../src/protocol/frames.js'

/** Collect frames the broker emits. */
function collector(): { frames: ServerFrame[]; send: (frame: ServerFrame) => void } {
  const frames: ServerFrame[] = []
  return { frames, send: (frame) => frames.push(frame) }
}

/** A question item for tests. */
function question(id: string, multiSelect = false): QuestionItem {
  return {
    id,
    question: `Question ${id}?`,
    options: [{ label: 'yes' }, { label: 'no' }],
    multiSelect,
    intent: null,
  }
}

/** Capture the listeners a context registers. */
function fakeContext(): {
  ctx: Context
  registered: { event: string; listener: (...args: never[]) => unknown; options: unknown }[]
} {
  const registered: { event: string; listener: (...args: never[]) => unknown; options: unknown }[] = []
  const ctx = {
    on: (event: string, listener: (...args: never[]) => unknown, options: unknown) => {
      registered.push({ event, listener, options })
      return () => {}
    },
  } as unknown as Context
  return { ctx, registered }
}

describe('readApprovalRequest', () => {
  it('reads the tool, agent and presentation text', () => {
    const input = readApprovalRequest({
      agent: { id: 'session-1' },
      toolName: 'bash',
      callId: 'call-9',
      reason: 'needs network',
      displayReason: { en: 'Run a command', zh: '执行命令' },
    })
    expect(input).toEqual({
      sessionId: 'session-1',
      toolName: 'bash',
      callId: 'call-9',
      reason: 'needs network',
      displayReason: { en: 'Run a command', zh: '执行命令' },
    })
  })

  it('survives a request with nothing usable in it', () => {
    expect(readApprovalRequest(null)).toEqual({ sessionId: null, toolName: 'unknown tool' })
    expect(readApprovalRequest({})).toEqual({ sessionId: null, toolName: 'unknown tool' })
  })
})

describe('readQuestionRequest', () => {
  const base = {
    agent: { id: 'session-1' },
    wait: { callId: 'call-1' },
    questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'a' }] }],
  }

  it('narrows a batch', () => {
    const input = readQuestionRequest(base)
    expect(input?.callId).toBe('call-1')
    expect(input?.sessionId).toBe('session-1')
    expect(input?.questions[0]?.id).toBe('q1')
    expect(input?.questions[0]?.options).toEqual([{ label: 'a' }])
  })

  it('returns null when there is no call id, because nothing could be routed back', () => {
    expect(readQuestionRequest({ ...base, wait: undefined })).toBeNull()
  })

  it('returns null when there are no usable questions', () => {
    expect(readQuestionRequest({ ...base, questions: [] })).toBeNull()
    expect(readQuestionRequest({ ...base, questions: [{ question: 'no id' }] })).toBeNull()
  })

  it('keeps a plan-review intent', () => {
    const input = readQuestionRequest({
      ...base,
      questions: [
        {
          id: 'q1',
          question: 'Approve the plan?',
          options: [{ label: 'Approve' }, { label: 'Keep planning' }],
          intent: { kind: 'plan-review', approve: 'Approve' },
        },
      ],
    })
    expect(input?.questions[0]?.intent).toEqual({ kind: 'plan-review', approve: 'Approve' })
  })
})

describe('assertAnswerBatch', () => {
  const questions = [question('q1'), question('q2')]

  it('accepts a batch naming every question exactly once', () => {
    expect(() =>
      assertAnswerBatch(questions, [
        { id: 'q1', selected: ['yes'] },
        { id: 'q2', selected: [] },
      ]),
    ).not.toThrow()
  })

  it('rejects a batch that omits a question', () => {
    // DSH rejects the whole reply for this, so catching it here avoids
    // discarding an answer the operator already committed to.
    expect(() => assertAnswerBatch(questions, [{ id: 'q1', selected: ['yes'] }])).toThrow(/omits question "q2"/)
  })

  it('rejects a batch naming a question twice', () => {
    expect(() =>
      assertAnswerBatch(questions, [
        { id: 'q1', selected: ['yes'] },
        { id: 'q1', selected: ['no'] },
        { id: 'q2', selected: [] },
      ]),
    ).toThrow(/twice/)
  })

  it('rejects a batch naming a question that was never asked', () => {
    expect(() =>
      assertAnswerBatch(questions, [
        { id: 'q1', selected: [] },
        { id: 'q2', selected: [] },
        { id: 'q9', selected: [] },
      ]),
    ).toThrow(/unknown question/)
  })
})

describe('InteractionBroker — approvals', () => {
  it('emits a request frame and settles when answered', async () => {
    const broker = new InteractionBroker()
    const { frames, send } = collector()
    broker.setSender(send)

    const pending = broker.beginApproval({ sessionId: 's1', toolName: 'bash', reason: 'why' }).outcome
    const view = broker.listApprovals()[0]
    expect(view?.toolName).toBe('bash')
    expect(frames[0]).toMatchObject({ type: 'event', event: 'approval.request' })

    expect(broker.answerApproval(view?.requestId ?? '', 'allowed-once')).toBe(true)
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('refuses a second answer to the same request', async () => {
    const broker = new InteractionBroker()
    broker.setSender(() => {})
    const pending = broker.beginApproval({ sessionId: 's1', toolName: 'bash' }).outcome
    const id = broker.listApprovals()[0]?.requestId ?? ''

    expect(broker.answerApproval(id, 'allowed-once')).toBe(true)
    // A double tap must not settle twice.
    expect(broker.answerApproval(id, 'rejected')).toBe(false)
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('refuses an answer for an unknown request', () => {
    const broker = new InteractionBroker()
    expect(broker.answerApproval('nope', 'rejected')).toBe(false)
  })

  it('settles cancelled when the requesting tool withdraws', async () => {
    const broker = new InteractionBroker()
    broker.setSender(() => {})
    const controller = new AbortController()
    const pending = broker.beginApproval({ sessionId: 's1', toolName: 'bash' }, controller.signal).outcome
    controller.abort()
    await expect(pending).resolves.toBe('cancelled')
    expect(broker.listApprovals()).toHaveLength(0)
  })

  it('returns cancelled immediately when already aborted', async () => {
    const broker = new InteractionBroker()
    await expect(broker.beginApproval({ sessionId: 's1', toolName: 'bash' }, AbortSignal.abort()).outcome).resolves.toBe(
      'cancelled',
    )
  })

  it('fails closed when the last client disconnects', async () => {
    // The property that keeps a vanished phone from hanging an agent: an
    // approval is one-shot with no late-answer path, so it must settle.
    const broker = new InteractionBroker()
    broker.setSender(() => {})
    broker.setClientCount(1)
    const pending = broker.beginApproval({ sessionId: 's1', toolName: 'bash' }).outcome
    expect(broker.hasClients()).toBe(true)

    broker.setClientCount(0)
    await expect(pending).resolves.toBe('unavailable')
    expect(broker.listApprovals()).toHaveLength(0)
  })

  it('keeps waiting while at least one client remains', async () => {
    const broker = new InteractionBroker()
    broker.setSender(() => {})
    broker.setClientCount(2)
    let settled = false
    const pending = broker.beginApproval({ sessionId: 's1', toolName: 'bash' }).outcome.then((outcome) => {
      settled = true
      return outcome
    })

    broker.setClientCount(1)
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(settled).toBe(false)

    broker.answerApproval(broker.listApprovals()[0]?.requestId ?? '', 'rejected')
    await expect(pending).resolves.toBe('rejected')
  })

  it('releases everything pending on dispose', async () => {
    const broker = new InteractionBroker()
    broker.setSender(() => {})
    const approval = broker.beginApproval({ sessionId: 's1', toolName: 'bash' }).outcome
    const questions = broker.beginQuestions({ sessionId: 's1', callId: 'c1', questions: [question('q1')] }).answers
    broker.dispose()
    await expect(approval).resolves.toBe('cancelled')
    await expect(questions).resolves.toEqual([])
  })
})

describe('InteractionBroker — questions', () => {
  it('emits a request frame and settles with the answers', async () => {
    const broker = new InteractionBroker()
    const { frames, send } = collector()
    broker.setSender(send)

    const pending = broker.beginQuestions({ sessionId: 's1', callId: 'c1', questions: [question('q1')] }).answers
    expect(frames[0]).toMatchObject({ type: 'event', event: 'question.request' })
    expect(broker.listQuestions()[0]?.callId).toBe('c1')

    expect(broker.answerQuestion('c1', [{ id: 'q1', selected: ['yes'] }])).toBe(true)
    await expect(pending).resolves.toEqual([{ id: 'q1', selected: ['yes'] }])
  })

  it('settles empty when the asking tool withdraws', async () => {
    const broker = new InteractionBroker()
    broker.setSender(() => {})
    const controller = new AbortController()
    const pending = broker.beginQuestions(
      { sessionId: 's1', callId: 'c1', questions: [question('q1')] },
      controller.signal,
    ).answers
    controller.abort()
    await expect(pending).resolves.toEqual([])
  })
})

describe('registerAnswerers', () => {
  /** Invoke one registered listener. */
  function invoke(
    registered: { event: string; listener: (...args: never[]) => unknown; options: unknown }[],
    event: string,
    request: unknown,
    next: () => Promise<unknown>,
  ): Promise<unknown> {
    const entry = registered.find((candidate) => candidate.event === event)
    if (entry === undefined) throw new Error(`no listener for ${event}`)
    return (entry.listener as unknown as (r: unknown, n: () => Promise<unknown>) => Promise<unknown>)(
      request,
      next,
    )
  }

  it('registers both answerers prepended, so the phone is a peer not a fallback', () => {
    const { ctx, registered } = fakeContext()
    registerAnswerers(ctx, new InteractionBroker())
    expect(registered.map((entry) => entry.event).sort()).toEqual([
      'approval/request',
      'user-questions/request',
    ])
    for (const entry of registered) {
      expect(entry.options).toEqual({ prepend: true })
    }
  })

  it('delegates untouched when no client could answer', async () => {
    // With no phone connected the plugin must not change existing behaviour.
    const { ctx, registered } = fakeContext()
    const broker = new InteractionBroker()
    registerAnswerers(ctx, broker)

    const outcome = await invoke(registered, 'approval/request', { toolName: 'bash' }, async () => 'allowed-once')
    expect(outcome).toBe('allowed-once')
  })

  it('returns the phone answer when it arrives first', async () => {
    const { ctx, registered } = fakeContext()
    const broker = new InteractionBroker()
    broker.setSender(() => {})
    broker.setClientCount(1)
    registerAnswerers(ctx, broker)

    // The delegated chain never answers, standing in for a desktop GUI whose
    // user is away from the machine.
    const pending = invoke(registered, 'approval/request', { toolName: 'bash' }, () => new Promise(() => {}))
    await new Promise((resolve) => setTimeout(resolve, 5))
    broker.answerApproval(broker.listApprovals()[0]?.requestId ?? '', 'rejected')

    await expect(pending).resolves.toBe('rejected')
  })

  it('does not let a terminal "nobody answered" preempt the phone', async () => {
    // This is the whole reason the delegated outcome is filtered: the waterfall's
    // terminal behaviour resolves immediately with `unavailable`, and racing it
    // verbatim would mean the phone could never answer.
    const { ctx, registered } = fakeContext()
    const broker = new InteractionBroker()
    broker.setSender(() => {})
    broker.setClientCount(1)
    registerAnswerers(ctx, broker)

    let settled = false
    const pending = invoke(registered, 'approval/request', { toolName: 'bash' }, async () => 'unavailable').then(
      (outcome) => {
        settled = true
        return outcome
      },
    )

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)

    broker.answerApproval(broker.listApprovals()[0]?.requestId ?? '', 'allowed-once')
    await expect(pending).resolves.toBe('allowed-once')
  })

  it('lets a real delegated answer win when it arrives first', async () => {
    const { ctx, registered } = fakeContext()
    const broker = new InteractionBroker()
    broker.setSender(() => {})
    broker.setClientCount(1)
    registerAnswerers(ctx, broker)

    const outcome = await invoke(registered, 'approval/request', { toolName: 'bash' }, async () => 'allowed-once')
    expect(outcome).toBe('allowed-once')
    // The phone's outstanding question is cleaned up.
    expect(broker.listApprovals()).toHaveLength(0)
  })

  it('delegates a question batch with no call id rather than claiming it', async () => {
    const { ctx, registered } = fakeContext()
    const broker = new InteractionBroker()
    broker.setSender(() => {})
    broker.setClientCount(1)
    registerAnswerers(ctx, broker)

    const outcome = await invoke(
      registered,
      'user-questions/request',
      { questions: [{ id: 'q1', question: 'x' }] },
      async () => ({ answers: [{ id: 'q1', selected: [] }] }),
    )
    expect(outcome).toEqual({ answers: [{ id: 'q1', selected: [] }] })
  })

  it('does not let an empty delegated answer preempt the phone', async () => {
    const { ctx, registered } = fakeContext()
    const broker = new InteractionBroker()
    broker.setSender(() => {})
    broker.setClientCount(1)
    registerAnswerers(ctx, broker)

    let settled = false
    const pending = invoke(
      registered,
      'user-questions/request',
      { wait: { callId: 'c1' }, questions: [{ id: 'q1', question: 'x' }] },
      async () => ({}),
    ).then((value) => {
      settled = true
      return value
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(settled).toBe(false)

    broker.answerQuestion('c1', [{ id: 'q1', selected: ['a'] }])
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['a'] }] })
  })
})

/**
 * The push notification.
 *
 * An agent blocked on an approval is stopped until somebody answers, so a phone
 * that has to wait for its next poll is a stalled turn. These assert the host
 * announces the change rather than leaving the client to discover it.
 */
describe('InteractionBroker — pending-change notifications', () => {
  /**
   * The change notifications in a frame list.
   *
   * Filtered to a typed list rather than matched with a nested
   * `expect.objectContaining`, which does not unwrap through `toContainEqual`
   * and reports a missing frame that is visibly present.
   *
   * @param frames - every frame the broker sent.
   * @returns just the change notifications.
   */
  function changed(frames: readonly ServerFrame[]): { data: unknown }[] {
    return frames.filter(
      (frame): frame is Extract<ServerFrame, { type: 'event' }> =>
        frame.type === 'event' && frame.event === 'interactions.changed',
    )
  }

  /** A broker wired to a frame recorder. */
  function wired(): { broker: InteractionBroker; frames: ServerFrame[] } {
    const frames: ServerFrame[] = []
    const broker = new InteractionBroker()
    broker.setSender((frame) => frames.push(frame))
    broker.setClientCount(1)
    return { broker, frames }
  }

  it('announces a new approval', async () => {
    const { broker, frames } = wired()
    const handle = broker.beginApproval({ sessionId: 's1', toolName: 'bash' })
    // `contains`, not `at(-1)`: the broker also announces `approval.request`,
    // and which of the two lands last is an ordering detail these tests have no
    // business pinning.
    expect(changed(frames)).toHaveLength(1)
    expect(changed(frames)[0]?.data).toEqual({ approvals: 1, questions: 0 })
    handle.abandon('rejected')
    await handle.outcome
  })

  it('announces a settled approval', async () => {
    const { broker, frames } = wired()
    const handle = broker.beginApproval({ sessionId: 's1', toolName: 'bash' })
    frames.length = 0
    handle.abandon('rejected')
    await handle.outcome
    expect(changed(frames)).toHaveLength(1)
    expect(changed(frames)[0]?.data).toEqual({ approvals: 0, questions: 0 })
  })

  it('announces a question batch', async () => {
    const { broker, frames } = wired()
    const handle = broker.beginQuestions({
      sessionId: 's1',
      callId: 'q1',
      questions: [{ id: 'q1', question: 'Which?', options: [{ label: 'A' }], multiSelect: false }],
    })
    expect(changed(frames)).toHaveLength(1)
    expect(changed(frames)[0]?.data).toEqual({ approvals: 0, questions: 1 })
    handle.abandon()
    await handle.answers
  })

  it('says nothing when nobody is connected', async () => {
    // Not "no frames at all": the broker announces `approval.request` to its
    // sender regardless, and in production that sender is a broadcast that
    // reaches nobody. What must not happen is a change notification aimed at an
    // empty room.
    const frames: ServerFrame[] = []
    const broker = new InteractionBroker()
    broker.setSender((frame) => frames.push(frame))
    broker.setClientCount(0)
    const handle = broker.beginApproval({ sessionId: 's1', toolName: 'bash' })
    expect(changed(frames)).toHaveLength(0)
    handle.abandon('rejected')
    await handle.outcome
    expect(changed(frames)).toHaveLength(0)
  })

  it('does not announce when an already-settled id is settled again', async () => {
    // Two answerers racing is normal, and the second one changes nothing.
    const { broker, frames } = wired()
    const handle = broker.beginApproval({ sessionId: 's1', toolName: 'bash' })
    handle.abandon('rejected')
    await handle.outcome
    const before = frames.length
    expect(broker.answerApproval('a1', 'allowed-once')).toBe(false)
    expect(frames).toHaveLength(before)
  })

  it('keeps the change when the transport throws', async () => {
    // A socket hiccup must not roll back a state change: the approval is still
    // there, and dropping it would lose the operator's only chance to answer.
    const broker = new InteractionBroker()
    broker.setSender(() => {
      throw new Error('socket gone')
    })
    broker.setClientCount(1)
    const handle = broker.beginApproval({ sessionId: 's1', toolName: 'bash' })
    expect(broker.listApprovals()).toHaveLength(1)
    handle.abandon('rejected')
    await handle.outcome
    expect(broker.listApprovals()).toHaveLength(0)
  })
})
