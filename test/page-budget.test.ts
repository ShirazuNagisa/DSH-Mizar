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
    expect(SOURCE).toContain('records: withinBudget(useful)')
  })
})
