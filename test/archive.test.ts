/**
 * Archived Sessions must not answer `session/list`.
 *
 * DSH lists every Session it knows and the GUI filters with the workspace
 * registry's archive set, which is not a Remote endpoint. The desktop gets the
 * list through this bridge, so the bridge is the one place that can apply the
 * same filter — without it an archived Session keeps appearing on the phone
 * after every refresh.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '../src/dsh.js'
import { withoutArchivedSessions } from '../src/bridge/archive.js'
import { InteractionBroker } from '../src/bridge/interactions.js'
import { Dispatcher } from '../src/link/dispatch.js'
import type { FrameToDesktop, FrameToPlugin } from '../src/link/frames.js'

/** A context whose registry answers the archive set, or nothing at all. */
function contextWith(archived: string[] | null): Context {
  return {
    get: (name: string) =>
      name === 'workspaceRegistry' && archived !== null ? { archivedSessionIds: archived } : undefined,
    effect: () => {},
  } as unknown as Context
}

describe('withoutArchivedSessions', () => {
  it('drops rows named by sessionId or id', () => {
    const value = {
      items: [
        { sessionId: 'session-a' },
        { id: 'session-b' },
        { sessionId: 'session-c' },
      ],
    }
    expect(withoutArchivedSessions(contextWith(['session-a', 'session-b']), value, ['workspaceRegistry']))
      .toEqual({ items: [{ sessionId: 'session-c' }] })
  })

  it('returns the same object when every row is live', () => {
    const value = { items: [{ sessionId: 'session-a' }] }
    expect(withoutArchivedSessions(contextWith(['session-b']), value, ['workspaceRegistry'])).toBe(value)
  })

  it('passes through when the registry is absent or not allowlisted', () => {
    const value = { items: [{ sessionId: 'session-a' }] }
    expect(withoutArchivedSessions(contextWith(null), value, ['workspaceRegistry'])).toBe(value)
    expect(withoutArchivedSessions(contextWith(['session-a']), value, [])).toBe(value)
  })

  it('passes through when the archive set is empty', () => {
    const value = { items: [{ sessionId: 'session-a' }] }
    expect(withoutArchivedSessions(contextWith([]), value, ['workspaceRegistry'])).toBe(value)
  })
})

describe('Dispatcher session/list', () => {
  it('hides an archived Session from the result the desktop reads', async () => {
    const frames: FrameToDesktop[] = []
    const ctx = {
      ...contextWith(['session-a']),
      typertGateway: {
        invoke: async () => ({
          items: [{ sessionId: 'session-a' }, { sessionId: 'session-b' }],
        }),
      },
    } as unknown as Context
    const logs: string[] = []
    const dispatcher = new Dispatcher({
      ctx,
      send: (frame) => {
        frames.push(frame)
        return true
      },
      broker: new InteractionBroker(),
      services: ['workspaceRegistry'],
      log: (message) => logs.push(message),
      logCalls: false,
    })

    dispatcher.handle({
      v: 1,
      type: 'invoke',
      id: 'list-1',
      endpoint: 'session/list',
      args: {},
      mode: 'unary',
    } as FrameToPlugin)
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatchObject({
      type: 'result',
      id: 'list-1',
      ok: true,
      value: { items: [{ sessionId: 'session-b' }] },
    })
    expect(logs.some((line) => line.includes('hid 1 archived'))).toBe(true)
  })
})
