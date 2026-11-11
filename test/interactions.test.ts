/**
 * The five approval rules, tested without a DSH host.
 *
 * These are the rules `decision-0002` measured; each one is a bug that shipped
 * once. The 0.9.0 transport changed, the semantics did not.
 *
 * @module dsh-mizar/test/interactions
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/dsh.js'
import {
  assertAnswerBatch,
  InteractionBroker,
  readApprovalRequest,
  readQuestionIds,
  readQuestionRequest,
  registerAnswerers,
} from '../src/bridge/interactions.js'
import type { FrameToDesktop } from '../src/link/frames.js'

/** One captured waterfall listener. */
interface Captured {
  readonly handler: (request: unknown, next: () => Promise<unknown>) => Promise<unknown>
  readonly prepend: boolean
}

/** A context that only implements `on`, which is all the answerers use. */
function fakeContext(): { ctx: Context; captured: Map<string, Captured> } {
  const captured = new Map<string, Captured>()
  const ctx = {
    on: (event: string, handler: Captured['handler'], options?: { prepend?: boolean }) => {
      captured.set(event, { handler, prepend: options?.prepend === true })
      return () => captured.delete(event)
    },
  } as unknown as Context
  return { ctx, captured }
}

/** A broker whose outbound frames are collected. */
function wiredBroker(): { broker: InteractionBroker; frames: FrameToDesktop[] } {
  const frames: FrameToDesktop[] = []
  const broker = new InteractionBroker()
  broker.setSender((frame) => {
    frames.push(frame)
    return true
  })
  return { broker, frames }
}

/** A promise that resolves after one macrotask, for race ordering. */
const later = <T>(value: T, ms = 5): Promise<T> =>
  new Promise((resolve) => setTimeout(() => resolve(value), ms))

describe('registerAnswerers', () => {
  it('registers both waterfalls with prepend, so the desktop is a peer and not a fallback', () => {
    const { ctx, captured } = fakeContext()
    registerAnswerers(ctx, new InteractionBroker())
    expect(captured.get('approval/request')?.prepend).toBe(true)
    expect(captured.get('user-questions/request')?.prepend).toBe(true)
  })

  it('is a pure pass-through when no desktop is connected', async () => {
    const { ctx, captured } = fakeContext()
    const { broker, frames } = wiredBroker()
    registerAnswerers(ctx, broker)

    const next = vi.fn(async () => 'rejected')
    const outcome = await captured.get('approval/request')?.handler({ toolName: 'bash' }, next)
    expect(outcome).toBe('rejected')
    expect(next).toHaveBeenCalledOnce()
    expect(frames).toHaveLength(0)
  })

  it('claims the approval without opening the DSH GUI card', async () => {
    const { ctx, captured } = fakeContext()
    const { broker, frames } = wiredBroker()
    broker.setConnected(true)
    registerAnswerers(ctx, broker)

    const next = vi.fn(async () => later('rejected', 50))
    const pending = captured.get('approval/request')?.handler({ toolName: 'bash' }, next)
    await later(null)

    const approval = frames.find((frame) => frame.type === 'approval')
    expect(approval).toBeDefined()
    expect(broker.answer(approval?.type === 'approval' ? approval.id : '', { outcome: 'allowed-once' })).toBe(true)

    await expect(pending).resolves.toBe('allowed-once')
    // The GUI's own card is the one that cannot be withdrawn after a phone
    // answer, so the bridge never opens it while the phone is connected.
    expect(next).not.toHaveBeenCalled()
  })

  it('does not consult the terminal answerer while the desktop is connected', async () => {
    const { ctx, captured } = fakeContext()
    const { broker, frames } = wiredBroker()
    broker.setConnected(true)
    registerAnswerers(ctx, broker)

    const next = vi.fn(async () => 'unavailable')
    const pending = captured.get('approval/request')?.handler({ toolName: 'bash' }, next)
    await later(null)

    const approval = frames.find((frame) => frame.type === 'approval')
    broker.answer(approval?.type === 'approval' ? approval.id : '', { outcome: 'rejected' })
    await expect(pending).resolves.toBe('rejected')
    expect(next).not.toHaveBeenCalled()
  })

  it('turns prototype-getter fields into own fields before the wire', () => {
    // DSH can hand the waterfall a host object; JSON.stringify omits inherited
    // accessors even though reading them works. The desktop then sees an
    // approval with no session and draws it over every conversation.
    const request = Object.create({
      agent: { id: 'session-a' },
      toolName: 'bash',
      callId: 'call-1',
      reason: 'why',
    })
    const narrowed = readApprovalRequest(request)
    expect(JSON.parse(JSON.stringify(narrowed))).toEqual({
      agent: { id: 'session-a' },
      toolName: 'bash',
      callId: 'call-1',
      reason: 'why',
    })
  })

  it('does not open a DSH GUI card that a phone answer would strand', async () => {
    const { ctx, captured } = fakeContext()
    const { broker } = wiredBroker()
    broker.setConnected(true)
    registerAnswerers(ctx, broker)

    const next = vi.fn(() => new Promise<string>(() => {}))
    const request = { toolName: 'bash' }
    const pending = captured.get('approval/request')?.handler(request, next)
    await later(null)
    expect(broker.pendingApprovals).toBe(1)
    expect(next).not.toHaveBeenCalled()

    // Disposing settles the phone handle; there is no GUI promise left behind
    // to strand a card on screen.
    broker.dispose()
    await expect(pending).resolves.toBe('cancelled')
  })

  it('settles pending approvals unavailable when the desktop goes away', async () => {
    const { ctx, captured } = fakeContext()
    const { broker } = wiredBroker()
    broker.setConnected(true)
    registerAnswerers(ctx, broker)

    const next = vi.fn(() => new Promise<string>(() => {}))
    const pending = captured.get('approval/request')?.handler({ toolName: 'bash' }, next)
    await later(null)
    expect(broker.pendingApprovals).toBe(1)

    broker.setConnected(false)
    await expect(pending).resolves.toBe('unavailable')
    expect(broker.pendingApprovals).toBe(0)
  })

  it('narrows prototype-getter question fields as well', () => {
    const request = Object.create({
      questions: [{ id: 'q1', question: 'Which one?', options: [] }],
      agent: { id: 'session-a' },
    })
    expect(readQuestionRequest(request)).toEqual({
      questions: [{ id: 'q1', question: 'Which one?', options: [] }],
      agent: { id: 'session-a' },
    })
  })

  it('returns a desktop question batch in the shape DSH expects', async () => {
    const { ctx, captured } = fakeContext()
    const { broker, frames } = wiredBroker()
    broker.setConnected(true)
    registerAnswerers(ctx, broker)

    const request = {
      questions: [{ id: 'q1', question: 'Which one?', options: [{ label: 'a' }] }],
      agent: { id: 'session-1' },
    }
    const next = vi.fn(async () => ({ answers: [] }))
    const pending = captured.get('user-questions/request')?.handler(request, next)
    await later(null)

    const asked = frames.find((frame) => frame.type === 'question')
    const id = asked?.type === 'question' ? asked.id : ''
    expect(broker.answer(id, { answers: [{ id: 'q1', selected: ['a'] }] })).toBe(true)
    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['a'] }] })
  })

  it('tells the desktop when the DSH GUI answers a question instead', async () => {
    const { ctx, captured } = fakeContext()
    const { broker, frames } = wiredBroker()
    broker.setConnected(true)
    registerAnswerers(ctx, broker)

    const request = {
      questions: [{ id: 'q1', question: 'Which one?', options: [{ label: 'a' }] }],
      agent: { id: 'session-1' },
    }
    // The GUI answers through the delegated branch, so the phone's copy would
    // stay pending on the desktop without an explicit withdrawal.
    const next = vi.fn(async () => ({ answers: [{ id: 'q1', selected: ['a'] }] }))
    const pending = captured.get('user-questions/request')?.handler(request, next)

    await expect(pending).resolves.toEqual({ answers: [{ id: 'q1', selected: ['a'] }] })
    const asked = frames.find((frame) => frame.type === 'question')
    const id = asked?.type === 'question' ? asked.id : ''
    expect(id).not.toBe('')
    expect(frames).toContainEqual({ v: 1, type: 'interaction-resolved', id })
  })

  it('delegates a question batch it cannot parse', async () => {
    const { ctx, captured } = fakeContext()
    const { broker } = wiredBroker()
    broker.setConnected(true)
    registerAnswerers(ctx, broker)

    const next = vi.fn(async () => ({ answers: [{ id: 'x', selected: [] }] }))
    const outcome = await captured.get('user-questions/request')?.handler({ questions: [] }, next)
    expect(outcome).toEqual({ answers: [{ id: 'x', selected: [] }] })
    expect(next).toHaveBeenCalledOnce()
  })
})

describe('InteractionBroker', () => {
  it('withdraws an abandoned approval on the desktop', () => {
    const { broker, frames } = wiredBroker()
    broker.setConnected(true)
    const handle = broker.beginApproval({ toolName: 'bash' })
    handle.abandon('cancelled')
    expect(frames).toContainEqual({ v: 1, type: 'interaction-resolved', id: handle.id })
  })

  it('re-announces pending requests when a desktop reconnects', async () => {
    const { broker, frames } = wiredBroker()
    broker.setConnected(true)
    broker.beginApproval({ toolName: 'bash' })
    expect(frames).toHaveLength(1)

    broker.setConnected(false)
    // The down edge settles it, so a reconnect has nothing to re-announce.
    broker.setConnected(true)
    expect(frames).toHaveLength(1)
  })

  it('refuses an approval answer that is not in the client vocabulary', () => {
    const { broker } = wiredBroker()
    broker.setConnected(true)
    const handle = broker.beginApproval({ toolName: 'bash' })
    expect(() => broker.answer(handle.id, { outcome: 'unavailable' })).toThrow(/allowed-once or rejected/)
    expect(broker.pendingApprovals).toBe(1)
  })

  it('reports an unknown id rather than throwing', () => {
    const { broker } = wiredBroker()
    expect(broker.answer('nope', { outcome: 'rejected' })).toBe(false)
  })

  it('settles every pending approval cancelled on dispose', async () => {
    const { broker } = wiredBroker()
    broker.setConnected(true)
    const handle = broker.beginApproval({ toolName: 'bash' })
    broker.dispose()
    await expect(handle.outcome).resolves.toBe('cancelled')
  })
})

describe('assertAnswerBatch', () => {
  it('accepts a batch that names each question once', () => {
    expect(() =>
      assertAnswerBatch(['a', 'b'], [
        { id: 'a', selected: ['x'] },
        { id: 'b', selected: ['y'] },
      ]),
    ).not.toThrow()
  })

  it('rejects an unknown, a duplicate and a missing question', () => {
    expect(() => assertAnswerBatch(['a'], [{ id: 'z', selected: [] }])).toThrow(/unknown question/)
    expect(() =>
      assertAnswerBatch(['a'], [
        { id: 'a', selected: [] },
        { id: 'a', selected: [] },
      ]),
    ).toThrow(/twice/)
    expect(() => assertAnswerBatch(['a', 'b'], [{ id: 'a', selected: [] }])).toThrow(/omits question/)
  })
})

describe('readQuestionIds', () => {
  it('reads a flat payload, which is what a real host sends', () => {
    expect(readQuestionIds({ questions: [{ id: 'q1' }, { id: 'q2' }] })).toEqual(['q1', 'q2'])
  })

  it('reads a nested payload too', () => {
    expect(readQuestionIds({ request: { questions: [{ id: 'q1' }] } })).toEqual(['q1'])
  })

  it('returns null when there is nothing answerable', () => {
    expect(readQuestionIds({ questions: [] })).toBeNull()
    expect(readQuestionIds(null)).toBeNull()
    expect(readQuestionIds({ questions: [{ id: '' }] })).toBeNull()
  })
})
