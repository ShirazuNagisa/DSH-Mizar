/**
 * Tests for incremental delivery.
 *
 * A refresh used to cost the whole tail of a session, every time: the phone
 * already held every record in the page and downloaded it again on each pull,
 * reconnect and poll. `session.messages` now takes the position the phone has
 * read to, and the plugin remembers what it has actually delivered to a device
 * for the requests that do not carry one.
 *
 * The tests pin the three claims the feature rests on:
 *
 *   - only records after the claimed position travel, and a record with no
 *     position is never dropped (it cannot be proven old);
 *   - a phone's own cursor outranks the ledger in both directions, so a cleared
 *     cache can pull the answer back instead of losing history;
 *   - `null` means "I hold nothing" and bypasses the ledger entirely.
 *
 * @module dsh-mizar/test/delivery
 */
import { describe, expect, it } from 'vitest'
import { DeliveryLedger, recordSeq } from '../src/bridge/delivery.js'
import { createMethodTable, type MethodContext } from '../src/bridge/index.js'
import { InteractionBroker } from '../src/bridge/interactions.js'
import { sessionMessages, type SessionMessagesResult } from '../src/bridge/sessions.js'
import type { Context } from '../src/dsh.js'

/** The authenticated connection a method call arrives on. */
const context: MethodContext = { deviceId: 'd1', deviceName: 'iPhone', remote: '127.0.0.1' }

/** Host identity, as the method table reports it. */
const facts = { hostId: 'h1', hostName: 'mac', home: '/home', protocolVersion: 1 }

/**
 * A gateway that answers `session/page` with one fixed set of records.
 *
 * The follow stream is made to fail so the cut comes from `session/projections`;
 * both paths end at the same page, and the cursor itself is not what these tests
 * are about.
 *
 * @param records - the records every page returns.
 * @returns a context the bridge can drive.
 */
function fakeGateway(records: readonly unknown[]): Context {
  return {
    typertGateway: {
      stream: async () => {
        throw new Error('no follow stream in this test')
      },
      invoke: async (request: { method: string }) =>
        request.method === 'page' ? { records, hasMore: false } : { asOfSeq: 99, values: {} },
    },
    effect: () => () => {},
  } as unknown as Context
}

/**
 * One log record, in the shape the gateway returns.
 *
 * @param type - the event name.
 * @param seq - the log position, or `undefined` for a host that numbers nothing.
 * @param data - the event payload.
 * @returns the record.
 */
function record(type: string, seq: number | undefined, data: Record<string, unknown>): unknown {
  const event: Record<string, unknown> = { type, time: 1_700_000_000_000, data }
  if (seq !== undefined) event['seq'] = seq
  return { type: 'event', event }
}

/** A prompt a person typed. */
function prompt(seq: number | undefined, text: string): unknown {
  return record('user/message', seq, {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  })
}

/** The positions in a page, in order. */
function seqs(records: readonly unknown[]): (number | null)[] {
  return records.map((entry) => recordSeq(entry))
}

const page = [prompt(1, 'one'), prompt(2, 'two'), prompt(3, 'three'), prompt(4, 'four'), prompt(5, 'five')]

describe('record positions', () => {
  it('reads a position out of a wrapped record', () => {
    expect(recordSeq({ type: 'event', event: { type: 'user/message', seq: 8 } })).toBe(8)
  })

  it('reads a position out of an unwrapped record', () => {
    // The log writes records with `seq` at the top level; the gateway wraps
    // them. A reader that only knew one shape re-sent the other forever.
    expect(recordSeq({ type: 'user/message', seq: 9 })).toBe(9)
  })

  it('returns null when the record names no position', () => {
    expect(recordSeq({ type: 'event', event: { type: 'step/start' } })).toBeNull()
    expect(recordSeq(null)).toBeNull()
    expect(recordSeq('seq-1')).toBeNull()
  })
})

describe('the delivery ledger', () => {
  it('keeps positions per device and per session', () => {
    const ledger = new DeliveryLedger()
    ledger.record('d1', 's1', 10)
    ledger.record('d2', 's1', 4)
    ledger.record('d1', 's2', 7)
    expect(ledger.deliveredThrough('d1', 's1')).toBe(10)
    expect(ledger.deliveredThrough('d2', 's1')).toBe(4)
    expect(ledger.deliveredThrough('d1', 's2')).toBe(7)
    expect(ledger.deliveredThrough('d2', 's2')).toBeUndefined()
  })

  it('never moves a position backwards', () => {
    // Scrolling back through history delivers an older page; letting that pull
    // the watermark down would make the next refresh re-send what was read.
    const ledger = new DeliveryLedger()
    ledger.record('d1', 's1', 10)
    ledger.record('d1', 's1', 3)
    expect(ledger.deliveredThrough('d1', 's1')).toBe(10)
  })

  it('records the highest position a delivered page carried, not the log cut', () => {
    // `asOfSeq` is the cut a page was taken at; the budget may have trimmed
    // older records out of that window. Claiming the cut would tell the phone it
    // holds records that never travelled.
    const ledger = new DeliveryLedger()
    ledger.recordResult('d1', { sessionId: 's1', asOfSeq: 99, records: page.slice(2) })
    expect(ledger.deliveredThrough('d1', 's1')).toBe(5)
  })

  it('ignores a result that is not a session page', () => {
    const ledger = new DeliveryLedger()
    ledger.recordResult('d1', { ok: true })
    ledger.recordResult('d1', null)
    expect(ledger.deliveredThrough('d1', 's1')).toBeUndefined()
  })

  it('forgets one device without touching another', () => {
    const ledger = new DeliveryLedger()
    ledger.record('d1', 's1', 10)
    ledger.record('d2', 's1', 10)
    ledger.forgetDevice('d1')
    expect(ledger.deliveredThrough('d1', 's1')).toBeUndefined()
    expect(ledger.deliveredThrough('d2', 's1')).toBe(10)
  })
})

describe('a page asked for from a position', () => {
  it('travels only after the position it was asked from', async () => {
    const result = await sessionMessages(fakeGateway(page), 's1', undefined, undefined, 3)
    expect(seqs(result.records)).toEqual([4, 5])
  })

  it('keeps a record that names no position', async () => {
    // It cannot be proven old, and dropping it would be silent data loss on a
    // host that stopped numbering.
    const withUnnumbered = [...page, prompt(undefined, 'unnumbered')]
    const result = await sessionMessages(fakeGateway(withUnnumbered), 's1', undefined, undefined, 4)
    expect(seqs(result.records)).toEqual([5, null])
  })

  it('does not filter a page being paged backwards', async () => {
    // A window before `beforeSeq` is not a page of new records; filtering it
    // forward would answer a scroll up with nothing.
    const result = await sessionMessages(fakeGateway(page), 's1', undefined, 5, 4)
    expect(seqs(result.records)).toEqual([1, 2, 3, 4, 5])
  })

  it('answers with the whole page when no position is given', async () => {
    const result = await sessionMessages(fakeGateway(page), 's1')
    expect(seqs(result.records)).toEqual([1, 2, 3, 4, 5])
  })
})

describe('the method table’s cursor rules', () => {
  /**
   * Call `session.messages` through the real method table.
   *
   * @param payload - the request payload.
   * @param ledger - the delivery memory, when the case needs one.
   * @returns the page.
   */
  async function ask(
    payload: Record<string, unknown>,
    ledger?: DeliveryLedger,
  ): Promise<SessionMessagesResult> {
    const table = createMethodTable(
      fakeGateway(page),
      facts,
      new InteractionBroker(),
      undefined,
      ledger,
    )
    return (await table['session.messages']?.(payload, context)) as SessionMessagesResult
  }

  it('answers a request with no cursor from what the ledger delivered', async () => {
    const ledger = new DeliveryLedger()
    ledger.record('d1', 's1', 3)
    const result = await ask({ sessionId: 's1' }, ledger)
    expect(seqs(result.records)).toEqual([4, 5])
  })

  it('lets a lower cursor win, so a cleared cache can pull the answer back', async () => {
    const ledger = new DeliveryLedger()
    ledger.record('d1', 's1', 4)
    const result = await ask({ sessionId: 's1', afterSeq: 1 }, ledger)
    expect(seqs(result.records)).toEqual([2, 3, 4, 5])
  })

  it('lets a higher cursor win, because the phone is evidence and the ledger is not', async () => {
    const ledger = new DeliveryLedger()
    ledger.record('d1', 's1', 2)
    const result = await ask({ sessionId: 's1', afterSeq: 4 }, ledger)
    expect(seqs(result.records)).toEqual([5])
  })

  it('reads an explicit null as "I hold nothing" and bypasses the ledger', async () => {
    // A reinstall keeps the device token but loses the cache. Without this, the
    // phone would be shown a conversation whose middle is missing.
    const ledger = new DeliveryLedger()
    ledger.record('d1', 's1', 4)
    const result = await ask({ sessionId: 's1', afterSeq: null }, ledger)
    expect(seqs(result.records)).toEqual([1, 2, 3, 4, 5])
  })

  it('does not answer one device from another device’s ledger', async () => {
    const ledger = new DeliveryLedger()
    ledger.record('d2', 's1', 4)
    const result = await ask({ sessionId: 's1' }, ledger)
    expect(seqs(result.records)).toEqual([1, 2, 3, 4, 5])
  })

  it('leaves the page whole when the host keeps no ledger', async () => {
    const result = await ask({ sessionId: 's1' })
    expect(seqs(result.records)).toEqual([1, 2, 3, 4, 5])
  })
})
