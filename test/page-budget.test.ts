import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The page budget, checked against the limit that actually bit.
 *
 * iOS's `URLSessionWebSocketTask` refuses any frame over one mebibyte and closes
 * the connection when one arrives:
 *
 *   input message size 2222614 exceeds maximum message size 1048576
 *   Read completed with an error Message too long
 *
 * A 2.1 MB page did not degrade the conversation, it killed the socket -- every
 * reply missing, history apparently lost on refresh, and no way back.
 */
const SOURCE = readFileSync(new URL('../src/bridge/sessions.ts', import.meta.url), 'utf8')

describe('the session page budget', () => {
  it('stays under the transport limit with room for framing', () => {
    const match = /MAX_PAGE_BYTES = ([0-9_* ]+)/.exec(SOURCE)
    expect(match, 'MAX_PAGE_BYTES is gone; the page can grow past what iOS accepts').not.toBeNull()
    // `512 * 1024` -- evaluated as written, not parsed as a number.
    const bytes = (match?.[1] ?? '')
      .split('*')
      .map((part) => Number(part.replace(/[_\s]/g, '')))
      .reduce((a, b) => a * b, 1)
    // 1048576 is the hard limit. Half of it leaves room for the JSON envelope
    // and for being wrong on the high side costing the connection.
    expect(bytes).toBeLessThanOrEqual(1048576 / 2)
    expect(bytes).toBeGreaterThan(0)
  })

  it('trims from the oldest end, so the newest turns survive', () => {
    // The newest records are what a conversation is looking at.
    expect(SOURCE).toContain('kept.reverse()')
    expect(SOURCE).toContain('index >= 0; index -= 1')
  })

  it('is applied to the records that go out', () => {
    // The budget is spent on the summary, not on the page the host returned:
    // trimming the full log first lets per-step narration fill the budget and
    // evict the prompt it was narrating. `summaries.test.ts` pins the behaviour;
    // this pins the order it depends on.
    expect(SOURCE).toContain('const summarized = await summaryRecords(records)')
    expect(SOURCE).toContain('records: withinBudget(fresh)')
    // And the incremental filter sits between the two: an old record that
    // survived the summary must not spend bytes the new ones need.
    expect(SOURCE).toContain('seq > floor')
    expect(SOURCE.indexOf('summaryRecords(records)')).toBeLessThan(
      SOURCE.indexOf('seq > floor'),
    )
    expect(SOURCE.indexOf('seq > floor')).toBeLessThan(SOURCE.indexOf('withinBudget(fresh)'))
  })
})

it('measures bytes, not UTF-16 code units', () => {
  // The bug this pins produced a five-megabyte frame from a half-megabyte
  // budget. `String.length` counts UTF-16 code units, and a Chinese character
  // is one of those but three bytes of UTF-8 -- so the page was budgeted in a
  // unit three times smaller than what the transport counts. The device log
  // showed the result twice, at 2.0 MB and again at 5.1 MB.
  expect(SOURCE).toContain('Buffer.byteLength')
  expect(SOURCE).not.toMatch(/JSON\.stringify\(record\)\?\.length/)
})

it('leaves the frame guard a margin under the transport limit', () => {
  const listener = readFileSync(new URL('../src/server/listener.ts', import.meta.url), 'utf8')
  expect(listener).toContain('MAX_FRAME_BYTES')
  // Per-method budgets only cover the methods that were measured; the guard is
  // what makes the limit hold for every answer.
  expect(listener).toContain('RESPONSE_TOO_LARGE')
  const match = /MAX_FRAME_BYTES = ([0-9 *]+)/.exec(listener)
  const bytes = (match?.[1] ?? '').split('*').map((p) => Number(p.trim())).reduce((a, b) => a * b, 1)
  expect(bytes).toBeGreaterThan(0)
  expect(bytes).toBeLessThan(1048576)
})
