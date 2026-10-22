import { describe, expect, it } from 'vitest'
import type { Context } from '../src/dsh.js'
import { forkSession, sessionMessages } from '../src/bridge/sessions.js'

const event = (type: string, seq: number, data: Record<string, unknown>) => ({ type: 'event', event: { type, seq, time: 1700000000000 + seq, data } })
const complete = () => [
  event('turn/start', 1, { turn: 1 }),
  event('step/start', 2, { turn: 1, step: 1 }),
  event('assistant/message', 3, { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 }, message: { role: 'assistant', source: { provider: 'deepseek', model: 'deepseek-chat' }, content: [{ type: 'text', text: 'Completed summary' }] } }),
  event('step/end', 4, { turn: 1, step: 1 }),
  event('turn/end', 5, { turn: 1, reason: { kind: 'completed' } }),
]
function gateway(records: unknown[]) {
  const calls: Array<{ method: string; args: Record<string, unknown> }> = []
  const ctx = { effect: () => () => {}, typertGateway: {
    invoke: async (request: { method: string; args: Record<string, unknown> }) => {
      calls.push(request)
      if (request.method === 'page') return { records, hasMore: false }
      if (request.method === 'fork') return { sessionId: 'branch-child' }
      if (request.method === 'projections') return { asOfSeq: 5, values: {} }
      throw Error(`unexpected ${request.method}`)
    },
    stream: async () => ({ async *[Symbol.asyncIterator]() { yield { type: 'snapshot', records, throughSeq: 5 } } }),
  } } as unknown as Context
  return { ctx, calls }
}
describe('durable completed turn boundaries', () => {
  it('passes the exact inclusive end seq to native fork after validating a page', async () => {
    const { ctx, calls } = gateway(complete())
    await expect(forkSession(ctx, { sessionId: 'parent', atSeq: 5 })).resolves.toEqual({ sessionId: 'branch-child' })
    expect(calls.map(c => c.method)).toEqual(['projections', 'page', 'fork'])
    expect(calls[2]?.args).toEqual({ request: { sessionId: 'parent', atSeq: 5 } })
  })
  it('does not silently branch the latest turn for a message seq or missing start', async () => {
    for (const records of [complete(), complete().slice(1)]) {
      const { ctx, calls } = gateway(records)
      await expect(forkSession(ctx, { sessionId: 'parent', atSeq: records.length === 5 ? 3 : 5 })).rejects.toThrow()
      expect(calls.some(c => c.method === 'fork')).toBe(false)
    }
  })
  it('rejects appended tool output but permits replacement-only surface updates', async () => {
    for (const surfaceOp of ['append', 'replace']) {
      const records = complete()
      records[3] = event('tool/result', 4, { turn: 1, step: 1, result: 'tool output' })
      ;(records[3] as { event: Record<string, unknown> }).event['surfaceOp'] = surfaceOp
      const { ctx, calls } = gateway(records)
      if (surfaceOp === 'append') {
        await expect(forkSession(ctx, { sessionId: 'parent', atSeq: 5 })).rejects.toThrow()
        expect(calls.some(c => c.method === 'fork')).toBe(false)
      } else {
        await expect(forkSession(ctx, { sessionId: 'parent', atSeq: 5 })).resolves.toEqual({ sessionId: 'branch-child' })
      }
    }
  })
  it('leaves partial-page usage and branch metadata unknown', async () => {
    const { ctx } = gateway(complete().slice(1))
    const result = await sessionMessages(ctx, { sessionId: 'parent' })
    const end = result.records.map(r => (r as { event: { type: string; data: Record<string, unknown> } }).event).find(e => e.type === 'turn/end')
    expect(end?.data['mizarTokenUsage']).toBeUndefined()
    expect(end?.data['mizarBranchUnavailable']).toBeUndefined()
  })
  it('ships exact complete-turn token usage rather than inventing a zero', async () => {
    const { ctx } = gateway(complete())
    const result = await sessionMessages(ctx, { sessionId: 'parent' })
    const end = result.records.map(r => (r as { event: { type: string; data: Record<string, unknown> } }).event).find(e => e.type === 'turn/end')
    expect(end?.data['mizarBranchUnavailable']).toBe(false)
    expect(end?.data['mizarTokenUsage']).toMatchObject({ totalTokens: 15 })
  })
})
