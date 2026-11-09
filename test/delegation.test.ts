import { describe, expect, it, vi } from 'vitest'
import { DelegationBridge } from '../src/bridge/delegation.js'
import type { DelegationNoticeFrame } from '../src/link/frames.js'

function fakeHost(followup = vi.fn()) {
  let handler: ((session: unknown, event: unknown) => void) | null = null
  const ctx = {
    on: (name: string, next: (session: unknown, event: unknown) => void) => {
      if (name !== 'session/event') return () => undefined
      handler = next
      return () => {
        handler = null
      }
    },
    get: (name: string) =>
      name === 'agents'
        ? {
            get: (session: string) =>
              session === 's1'
                ? {
                    followup,
                  }
                : undefined,
          }
        : undefined,
  }
  const emit = (session: unknown, event: unknown) => handler?.(session, event)
  return { ctx, emit, followup }
}

const notice = (overrides: Partial<DelegationNoticeFrame> = {}): DelegationNoticeFrame => ({
  v: 1,
  type: 'delegation_notice',
  id: 'n1',
  delegationId: 'd1',
  kind: 'settled',
  text: 'remote result',
  ...overrides,
})

describe('DelegationBridge', () => {
  it('maps a tool-result marker to its session and injects one followup', () => {
    const { ctx, emit, followup } = fakeHost()
    const bridge = new DelegationBridge(ctx as never, () => undefined)
    bridge.bind()
    emit(
      { id: 's1' },
      {
        type: 'tool/result',
        data: {
          output: 'AGI_MIZAR_DELEGATION d1\n{"delegationId":"d1"}',
        },
      },
    )
    bridge.deliver(notice())
    expect(followup).toHaveBeenCalledTimes(1)
    const message = followup.mock.calls[0]?.[0] as Record<string, unknown>
    // The agents service persists this object verbatim as the `user/message`
    // event data, so replay needs an identified user role here.
    expect(message['role']).toBe('user')
    expect(typeof message['id']).toBe('string')
    expect((message['id'] as string).length).toBeGreaterThan(0)
    expect(message['source']).toMatchObject({
      kind: 'subagent-settled',
      form: 'notice',
      senderSessionId: 'd1',
    })
    expect((message['content'] as Array<Record<string, unknown>>)[0]?.['text']).toBe('remote result')

    // The same notice id is delivered once.
    bridge.deliver(notice())
    expect(followup).toHaveBeenCalledTimes(1)
  })

  it('drops an unknown delegation and a host without the agents service', () => {
    const log = vi.fn()
    const { ctx } = fakeHost()
    const bridge = new DelegationBridge(ctx as never, log)
    bridge.deliver(notice())
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no parent session'))

    const host = { on: () => () => undefined, get: () => undefined }
    const quiet = new DelegationBridge(host as never, log)
    quiet.deliver(notice({ id: 'n2', delegationId: 'missing' }))
    expect(log).toHaveBeenCalledWith(expect.stringContaining('no parent session'))
  })
})
