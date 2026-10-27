/**
 * DSH Link v1 frame parsing and serialisation.
 *
 * Two properties matter and are tested directly: a frame this version does not
 * understand is ignored rather than fatal, and `toWire` never drops a key just
 * because nobody expected it — that is what keeps a new DSH field visible without
 * a new plugin.
 *
 * @module dsh-mizar/test/frames
 */
import { describe, expect, it } from 'vitest'
import { parseDesktopFrame, toWire, LINK_VERSION } from '../src/link/frames.js'

describe('parseDesktopFrame', () => {
  it('reads a welcome', () => {
    const frame = parseDesktopFrame(
      JSON.stringify({ v: 1, type: 'welcome', linkVersion: 1, desktop: 'AGI Mizar 0.1.0' }),
    )
    expect(frame).toEqual({
      v: LINK_VERSION,
      type: 'welcome',
      linkVersion: 1,
      desktop: 'AGI Mizar 0.1.0',
    })
  })

  it('defaults a welcome with no link version to 0, which the client refuses', () => {
    const frame = parseDesktopFrame(JSON.stringify({ type: 'welcome' }))
    expect(frame).toMatchObject({ type: 'welcome', linkVersion: 0 })
  })

  it('reads an invoke with its mode', () => {
    const frame = parseDesktopFrame(
      JSON.stringify({ type: 'invoke', id: 'c1', endpoint: 'session/list', args: {}, mode: 'stream' }),
    )
    expect(frame).toMatchObject({ type: 'invoke', id: 'c1', endpoint: 'session/list', mode: 'stream' })
  })

  it('treats an absent mode as unary', () => {
    const frame = parseDesktopFrame(JSON.stringify({ type: 'invoke', id: 'c1', endpoint: 'a/b' }))
    expect(frame).toMatchObject({ mode: 'unary' })
  })

  it('rejects an invoke without an id or an endpoint', () => {
    expect(parseDesktopFrame(JSON.stringify({ type: 'invoke', endpoint: 'a/b' }))).toBeNull()
    expect(parseDesktopFrame(JSON.stringify({ type: 'invoke', id: 'c1' }))).toBeNull()
  })

  it('reads a service call and defaults missing args to an empty list', () => {
    const frame = parseDesktopFrame(
      JSON.stringify({ type: 'service', id: 's1', service: 'workspaceRegistry', method: 'list' }),
    )
    expect(frame).toEqual({
      v: LINK_VERSION,
      type: 'service',
      id: 's1',
      service: 'workspaceRegistry',
      method: 'list',
      args: [],
    })
  })

  it('reads an approval answer and a question answer', () => {
    expect(
      parseDesktopFrame(JSON.stringify({ type: 'answer', id: 'a1', outcome: 'allowed-once' })),
    ).toMatchObject({ type: 'answer', id: 'a1', outcome: 'allowed-once' })
    expect(
      parseDesktopFrame(JSON.stringify({ type: 'answer', id: 'q1', answers: [{ id: 'x' }] })),
    ).toMatchObject({ type: 'answer', id: 'q1', answers: [{ id: 'x' }] })
  })

  it('reads a filter and drops non-string entries', () => {
    const frame = parseDesktopFrame(
      JSON.stringify({ type: 'filter', drop: ['assistant/attempt', 42, null] }),
    )
    expect(frame).toEqual({ v: LINK_VERSION, type: 'filter', drop: ['assistant/attempt'] })
  })

  it('ignores an unknown frame type instead of failing the connection', () => {
    expect(parseDesktopFrame(JSON.stringify({ type: 'from-the-future', id: 'x' }))).toBeNull()
  })

  it('ignores text that is not JSON', () => {
    expect(parseDesktopFrame('not json')).toBeNull()
    expect(parseDesktopFrame('null')).toBeNull()
    expect(parseDesktopFrame('[]')).toBeNull()
  })
})

describe('toWire', () => {
  it('keeps every field it was given, including ones nobody expected', () => {
    const value = { a: 1, b: { c: [1, 2, 3], d: 'x' }, e: null, f: true }
    expect(toWire(value)).toEqual(value)
  })

  it('drops an AbortSignal, which JSON would otherwise render as an empty object', () => {
    const wire = toWire({ request: { toolName: 'bash' }, signal: new AbortController().signal })
    expect(wire).toEqual({ request: { toolName: 'bash' } })
  })

  it('renders a bigint as a string rather than throwing', () => {
    expect(toWire({ n: 10n })).toEqual({ n: '10' })
  })

  it('renders an Error as its parts', () => {
    const wire = toWire(new Error('boom')) as Record<string, unknown>
    expect(wire['message']).toBe('boom')
    expect(wire['name']).toBe('Error')
  })

  it('marks a cycle instead of throwing', () => {
    const cyclic: Record<string, unknown> = { a: 1 }
    cyclic['self'] = cyclic
    expect(toWire(cyclic)).toMatchObject({ __unserializable: true })
  })

  it('turns undefined into null, because a frame must carry something', () => {
    expect(toWire(undefined)).toBeNull()
  })
})
