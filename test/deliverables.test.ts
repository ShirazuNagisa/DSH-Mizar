/**
 * Tests for the deliverable list a turn carries.
 *
 * The shape under test is not invented: every case below is a `present` call as
 * it appears in a real session log — `arguments` is a JSON *string*, the paths
 * are relative to the session's working directory, and `description` is prose
 * the model wrote for the operator.
 *
 * The failure that matters is the quiet one: a turn whose cards silently
 * disappear because a `tool/call` was read as something else, or because a
 * malformed call threw and took the page with it.
 *
 * @module dsh-mizar/test/deliverables
 */
import { describe, expect, it } from 'vitest'
import { deliverablesOf } from '../src/bridge/deliverables.js'

/**
 * One log event, in the shape `turnWindows` produces.
 *
 * @param type - the event name.
 * @param data - the event payload.
 * @returns the event.
 */
function event(type: string, data: Record<string, unknown> = {}): Record<string, unknown> {
  return { type, data }
}

/**
 * A `tool/call` event.
 *
 * @param name - the tool name.
 * @param args - the arguments, as the log stores them: a JSON string.
 * @returns the event.
 */
function call(name: string, args: unknown): Record<string, unknown> {
  return event('tool/call', {
    turn: 1,
    step: 3,
    callId: 'call_00_test',
    name,
    arguments: typeof args === 'string' ? args : JSON.stringify(args),
  })
}

describe('deliverablesOf', () => {
  it('reads the files a present call declared', () => {
    const files = deliverablesOf([
      event('turn/start', { turn: 1 }),
      call('present', {
        files: [{ path: 'Build/perf-glass/measurements.md', description: '玻璃层 A/B 的全部原始测量值' }],
      }),
    ])
    expect(files).toEqual([
      { path: 'Build/perf-glass/measurements.md', description: '玻璃层 A/B 的全部原始测量值' },
    ])
  })

  it('keeps a file whose description was left out', () => {
    const files = deliverablesOf([call('present', { files: [{ path: 'docs/report.pdf' }] })])
    expect(files).toEqual([{ path: 'docs/report.pdf' }])
  })

  it('ignores every tool that is not present', () => {
    const files = deliverablesOf([
      call('write', { path: 'src/a.ts', content: '…' }),
      call('read', { path: 'src/b.ts' }),
      call('bash', { command: 'ls' }),
    ])
    expect(files).toEqual([])
  })

  it('survives arguments that never parsed', () => {
    const files = deliverablesOf([
      call('present', '{"files": [{"path": "a.md"'),
      call('present', { files: [{ path: 'b.md' }] }),
    ])
    expect(files).toEqual([{ path: 'b.md' }])
  })

  it('survives arguments that are not an object', () => {
    const files = deliverablesOf([call('present', '[1,2,3]'), call('present', { files: 'nope' })])
    expect(files).toEqual([])
  })

  it('accepts arguments already parsed, as a replayed log may carry them', () => {
    const files = deliverablesOf([
      event('tool/call', {
        name: 'present',
        arguments: { files: [{ path: 'a.md', description: 'A' }] },
      }),
    ])
    expect(files).toEqual([{ path: 'a.md', description: 'A' }])
  })

  it('lets the last declaration of a path win, at its latest position', () => {
    const files = deliverablesOf([
      call('present', {
        files: [
          { path: 'report.md', description: 'first draft' },
          { path: 'notes.md', description: 'notes' },
        ],
      }),
      call('present', { files: [{ path: 'report.md', description: 'corrected' }] }),
    ])
    expect(files).toEqual([
      { path: 'notes.md', description: 'notes' },
      { path: 'report.md', description: 'corrected' },
    ])
  })

  it('trims noise off a path and drops one that is only noise', () => {
    const files = deliverablesOf([
      call('present', { files: [{ path: '  ./docs/a.md  ' }, { path: '   ' }] }),
    ])
    expect(files).toEqual([{ path: 'docs/a.md' }])
  })

  it('treats a blank description as none', () => {
    const files = deliverablesOf([call('present', { files: [{ path: 'a.md', description: '   ' }] })])
    expect(files).toEqual([{ path: 'a.md' }])
  })

  it('keeps at most eight, and keeps the most recent', () => {
    const many = Array.from({ length: 12 }, (_, index) => ({ path: `file-${index}.md` }))
    const files = deliverablesOf([call('present', { files: many })])
    expect(files).toHaveLength(8)
    expect(files[0]?.path).toBe('file-4.md')
    expect(files[7]?.path).toBe('file-11.md')
  })

  it('answers an empty list for a turn that presented nothing', () => {
    expect(deliverablesOf([event('turn/start', { turn: 1 }), event('turn/end', { turn: 1 })])).toEqual([])
  })
})
