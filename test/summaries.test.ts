/**
 * Tests for what a history page carries.
 *
 * The host used to ship the whole log window and let the phone throw most of it
 * away, which made every page a read of the durable log on the host and a
 * megabyte-scale transfer through the relay for a screen that draws one bubble
 * per turn. These tests pin the two halves of the replacement: the cut comes
 * from the `session/follow` opening frame, and the page that goes out is a
 * summary rather than a transcript.
 *
 * The filter is asserted by *presence*, not by shape: an expected record is one
 * the host sent, byte for byte, and the tests compare against those objects
 * identity-wise where it matters. A bridge that reshaped records on the way
 * through would pass an equality check written the other way round.
 *
 * @module dsh-mizar/test/summaries
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/dsh.js'
import { sessionMessages } from '../src/bridge/sessions.js'

/** One gateway invocation as the bridge issues it. */
interface Invocation {
  namespace: string
  method: string
  args: Record<string, unknown>
}

/** Everything the gateway was asked to do, in order. */
interface Wire {
  readonly invokes: Invocation[]
  readonly streams: Invocation[]
  readonly signals: (AbortSignal | undefined)[]
}

/** What a scripted gateway should answer with. */
interface Script {
  /** Frames the follow stream yields, or an error to throw instead. */
  readonly frames?: readonly unknown[]
  /** Record count the fake `session/page` answers with; defaults to the frames' records. */
  readonly pageRecords?: readonly unknown[]
  /** `hasMore` on the page reply. */
  readonly hasMore?: boolean
  /** The projections reply, or `null` for an unknown session. */
  readonly projections?: unknown
  /** Throw instead of opening the stream, as a host without the endpoint does. */
  readonly streamThrows?: boolean
  /** Report the iterator as already exhausted, with no frame at all. */
  readonly streamEmpty?: boolean
  /** Leave `return` off the iterator, as a carrier that cannot be closed does. */
  readonly noReturn?: boolean
  /** Throw from `return`, as a stream that dies while being closed does. */
  readonly returnThrows?: boolean
}

/**
 * A gateway that answers from a script and records what it was asked.
 *
 * @param script - what each call should answer with.
 * @returns the context, the scripted frames and the wire log.
 */
function fakeGateway(script: Script = {}): { ctx: Context; wire: Wire; closed: () => number } {
  const invokes: Invocation[] = []
  const streams: Invocation[] = []
  const signals: (AbortSignal | undefined)[] = []
  let closed = 0
  const frames = script.frames ?? []

  const gateway = {
    stream: async (request: Invocation) => {
      streams.push({ namespace: request.namespace, method: request.method, args: request.args })
      signals.push((request as { signal?: AbortSignal }).signal)
      if (script.streamThrows === true) throw new Error('gateway/invocation-unavailable')
      let index = 0
      const iterator: Record<string, unknown> = {
        next: async () => {
          if (script.streamEmpty === true || index >= frames.length) {
            return { value: undefined, done: true }
          }
          return { value: frames[index++], done: false }
        },
      }
      if (script.noReturn !== true) {
        iterator['return'] = async () => {
          closed += 1
          if (script.returnThrows === true) throw new Error('stream already gone')
          return { value: undefined, done: true }
        }
      }
      return { [Symbol.asyncIterator]: () => iterator }
    },
    invoke: async (request: Invocation) => {
      invokes.push({ namespace: request.namespace, method: request.method, args: request.args })
      signals.push((request as { signal?: AbortSignal }).signal)
      if (request.method === 'projections') {
        return script.projections === undefined ? { asOfSeq: 7, values: {} } : script.projections
      }
      if (request.method === 'page') {
        return {
          records: script.pageRecords ?? pageRecordsOf(frames),
          hasMore: script.hasMore === true,
        }
      }
      throw new Error(`unexpected method ${request.method}`)
    },
  }

  return {
    ctx: {
      typertGateway: gateway,
      // The gateway helper registers the Peer's disposal through the context
      // fiber; a double has none.
      effect: () => () => {},
    } as unknown as Context,
    wire: { invokes, streams, signals },
    closed: () => closed,
  }
}

/**
 * The records a follow snapshot frame carried, for a host that answers both
 * calls with the same window.
 *
 * @param frames - the scripted frames.
 * @returns the records, or an empty page.
 */
function pageRecordsOf(frames: readonly unknown[]): readonly unknown[] {
  const first = frames[0] as { type?: unknown; records?: unknown } | undefined
  return first?.type === 'snapshot' && Array.isArray(first.records) ? first.records : []
}

/**
 * One log record, in the shape the gateway returns.
 *
 * @param type - the event name.
 * @param seq - the log position.
 * @param data - the event payload.
 * @returns the record.
 */
function record(type: string, seq: number, data: Record<string, unknown>): unknown {
  return { type: 'event', event: { type, seq, time: 1_700_000_000_000 + seq, data } }
}

/** A prompt a person typed. */
function prompt(seq: number, text: string, kind = 'user'): unknown {
  return record('user/message', seq, {
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind },
  })
}

/** A model reply with one text part. */
function reply(seq: number, turn: number, text: string): unknown {
  return record('assistant/message', seq, {
    turn,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'reasoning', text: '' }, { type: 'text', text }] },
  })
}

/**
 * A model reply with no readable text: the shape a step that only called tools
 * has, and what a toolless turn's narration looks like when it is trimmed away.
 *
 * @param seq - the log position.
 * @param turn - the turn it belongs to.
 * @returns the record.
 */
function toolOnlyReply(seq: number, turn: number): unknown {
  return record('assistant/message', seq, {
    turn,
    step: 1,
    message: {
      role: 'assistant',
      content: [
        { type: 'reasoning', text: 'thinking about it, at length' },
        { type: 'tool-call', id: 'call_1', name: 'bash', arguments: '{}' },
      ],
    },
  })
}

/** The event inside a record the bridge returned, wrapped or not. */
function eventOf(value: unknown): Record<string, unknown> {
  const record = value as { type?: unknown; event?: unknown }
  const inner = typeof record.event === 'object' && record.event !== null ? record.event : record
  return inner as Record<string, unknown>
}

/** The event name of a record the bridge returned. */
function nameOf(value: unknown): string {
  return String(eventOf(value)['type'])
}

/** The event names of the records the bridge returned. */
function names(records: readonly unknown[]): string[] {
  return records.map(nameOf)
}

/** The text of an assistant record. */
function textOf(value: unknown): string {
  const data = eventOf(value)['data'] as { message?: { content?: unknown } } | undefined
  const parts = data?.message?.content
  if (!Array.isArray(parts)) return ''
  return parts
    .filter((part): part is { type: string; text: string } => (part as { type?: string }).type === 'text')
    .map((part) => part.text)
    .join('\n')
}

describe('the page cut', () => {
  it('comes from the follow snapshot cursor, not from projections', async () => {
    // The type says `throughSeq` is an "inclusive log cut obtained from the
    // corresponding follow opening frame". A projections read happens to report
    // the same number on today's host -- measured across five sessions, cold and
    // warm -- but it is a different read of a different thing, and reading it
    // costs every projection value on every page.
    const { ctx, wire } = fakeGateway({
      frames: [{ type: 'snapshot', cursor: 41, records: [] }],
      projections: { asOfSeq: 99, values: {} },
    })

    const result = await sessionMessages(ctx, 's1')

    expect(result.asOfSeq).toBe(41)
    const page = wire.invokes.find((call) => call.method === 'page')
    expect((page?.args['request'] as { throughSeq?: unknown }).throughSeq).toBe(41)
    // The expensive read is not made at all when the stream answers.
    expect(wire.invokes.map((call) => call.method)).toEqual(['page'])
    // And the stream is asked for the cut, which is the read the type names.
    expect(wire.streams.map((call) => `${call.namespace}/${call.method}`)).toEqual(['session/follow'])
  })

  it('opens session/follow for the session address, and closes the iterator', async () => {
    const { ctx, wire, closed } = fakeGateway({
      frames: [{ type: 'snapshot', cursor: 3, records: [] }],
    })

    await sessionMessages(ctx, 'session-abc')

    expect(wire.streams).toHaveLength(1)
    expect(wire.streams[0]).toEqual({
      namespace: 'session',
      method: 'follow',
      args: { request: { address: { kind: 'session', sessionId: 'session-abc' } } },
    })
    // One open subscription per refresh is a leak that only shows up after an
    // hour of use.
    expect(closed()).toBe(1)
  })

  it('reads exactly one frame, because a second one activates the agent', async () => {
    // Measured on a live host: a cold session's list row is
    // `running: false, agentAvailable: false` before the stream opens, after its
    // snapshot frame is read, and after it is closed. Pulling a second frame is
    // what flips `agentAvailable` to true -- `follow` promotes the session to an
    // Agent immediately after the snapshot is handed over. So this must never
    // ask twice.
    let pulls = 0
    const frames = [
      { type: 'snapshot', cursor: 3, records: [] },
      { type: 'event', event: { type: 'turn/start', seq: 4, time: 4, data: { turn: 1 } } },
    ]
    const ctx = {
      typertGateway: {
        stream: async () => {
          let index = 0
          return {
            [Symbol.asyncIterator]: () => ({
              next: async () => {
                pulls += 1
                return index < frames.length
                  ? { value: frames[index++], done: false }
                  : { value: undefined, done: true }
              },
              return: async () => ({ value: undefined, done: true }),
            }),
          }
        },
        invoke: async () => ({ records: [], hasMore: false }),
      },
      effect: () => () => {},
    } as unknown as Context

    await sessionMessages(ctx, 's1')

    expect(pulls).toBe(1)
  })

  it('falls back to the projections watermark when the stream will not open', async () => {
    const { ctx, wire } = fakeGateway({
      streamThrows: true,
      projections: { asOfSeq: 12, values: {} },
    })

    const result = await sessionMessages(ctx, 's1')

    expect(result.asOfSeq).toBe(12)
    expect(wire.invokes.map((call) => call.method)).toEqual(['projections', 'page'])
    const page = wire.invokes.find((call) => call.method === 'page')
    expect((page?.args['request'] as { throughSeq?: unknown }).throughSeq).toBe(12)
  })

  it('falls back when the first frame is not a snapshot', async () => {
    // An `event` frame first means the stream opened mid-log. Paging at a cut
    // taken from the middle of a turn is how half a turn reaches the screen.
    const { ctx } = fakeGateway({
      frames: [{ type: 'event', event: { type: 'turn/start', seq: 4, time: 4, data: { turn: 1 } } }],
      projections: { asOfSeq: 4, values: {} },
    })

    await expect(sessionMessages(ctx, 's1')).resolves.toMatchObject({ asOfSeq: 4 })
  })

  it('falls back when the first frame is unreadable, rather than throwing', async () => {
    // A host a version ahead, mid-upgrade, or answering with something that is
    // not a frame at all. None of those is a reason for the phone to show no
    // history: the projections read answers the same question.
    const { ctx, closed } = fakeGateway({
      frames: ['not a frame', 42, null],
      projections: { asOfSeq: 8, values: {} },
    })

    const result = await sessionMessages(ctx, 's1')

    expect(result.asOfSeq).toBe(8)
    expect(names(result.records)).toEqual([])
    expect(closed()).toBe(1)
  })

  it('falls back when the snapshot carries no usable cursor', async () => {
    const { ctx } = fakeGateway({
      frames: [{ type: 'snapshot', cursor: 'forty-one', records: [] }],
      projections: { asOfSeq: 5, values: {} },
    })

    await expect(sessionMessages(ctx, 's1')).resolves.toMatchObject({ asOfSeq: 5 })
  })

  it('falls back when the stream ends without a frame', async () => {
    const { ctx } = fakeGateway({ streamEmpty: true, projections: { asOfSeq: 6, values: {} } })

    await expect(sessionMessages(ctx, 's1')).resolves.toMatchObject({ asOfSeq: 6 })
  })

  it('falls back when the opening frame never arrives', async () => {
    // `workspace/follow` already carries a timeout for exactly this: a stream
    // carrier that accepts the request and then says nothing. Without one the
    // page request hangs until the socket does, and the conversation renders
    // empty rather than old.
    vi.useFakeTimers()
    try {
      const signalOf = (): AbortSignal | undefined => signals[0]
      const signals: (AbortSignal | undefined)[] = []
      const ctx = {
        typertGateway: {
          stream: async (request: { signal?: AbortSignal }) => {
            signals.push(request.signal)
            return {
              [Symbol.asyncIterator]: () => ({
                next: () =>
                  new Promise((_resolve, reject) => {
                    request.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
                      once: true,
                    })
                  }),
                return: async () => ({ value: undefined, done: true }),
              }),
            }
          },
          invoke: async () => ({ asOfSeq: 9, values: {} }),
        },
        effect: () => () => {},
      } as unknown as Context

      const pending = sessionMessages(ctx, 's1')
      await vi.advanceTimersByTimeAsync(30_000)

      await expect(pending).resolves.toMatchObject({ asOfSeq: 9 })
      expect(signalOf()?.aborted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('still closes the stream when the frame is unusable', async () => {
    const { ctx, closed } = fakeGateway({ frames: [{ type: 'upsert' }] })

    await sessionMessages(ctx, 's1')

    expect(closed()).toBe(1)
  })

  it('survives a carrier that cannot be closed, and one that fails while closing', async () => {
    // Closing is best effort: the frame has already been read, and a page that
    // was answered must not be turned into an error by the cleanup.
    const unclosable = fakeGateway({ frames: [{ type: 'snapshot', cursor: 2, records: [] }], noReturn: true })
    await expect(sessionMessages(unclosable.ctx, 's1')).resolves.toMatchObject({ asOfSeq: 2 })

    const failing = fakeGateway({
      frames: [{ type: 'snapshot', cursor: 2, records: [] }],
      returnThrows: true,
    })
    await expect(sessionMessages(failing.ctx, 's1')).resolves.toMatchObject({ asOfSeq: 2 })
  })

  it('answers no page at all when neither read has a cut', async () => {
    // No cut, no page: the session has no log to read. Not an error -- a session
    // created a moment ago is in exactly this state.
    const { ctx, wire } = fakeGateway({ streamThrows: true, projections: null })

    await expect(sessionMessages(ctx, 'missing')).resolves.toEqual({
      sessionId: 'missing',
      asOfSeq: null,
      records: [],
      hasMore: false,
    })
    expect(wire.invokes.map((call) => call.method)).toEqual(['projections'])
  })

  it('carries the page bounds and hasMore through unchanged', async () => {
    const { ctx, wire } = fakeGateway({
      frames: [{ type: 'snapshot', cursor: 50, records: [] }],
      pageRecords: [],
      hasMore: true,
    })

    const result = await sessionMessages(ctx, 's1', 25, 10)

    const page = wire.invokes.find((call) => call.method === 'page')
    expect(page?.args['request']).toEqual({
      address: { kind: 'session', sessionId: 's1' },
      throughSeq: 50,
      beforeSeq: 10,
      maxMessages: 25,
    })
    expect(result.hasMore).toBe(true)
  })
})

describe('the summary page', () => {
  it('keeps the prompt, the turn boundaries and one marker per step', async () => {
    const asked = prompt(0, 'what is 2+2')
    const records = [
      asked,
      record('turn/start', 1, { turn: 1 }),
      record('step/start', 2, { turn: 1, step: 1 }),
      record('system/message', 3, {
        turn: 1,
        step: 1,
        message: { role: 'system', content: [{ type: 'text', text: 'You are a coding agent.' }] },
      }),
      reply(4, 1, '4'),
      record('step/end', 5, { turn: 1, step: 1 }),
      record('turn/end', 6, { turn: 1, reason: { kind: 'complete' } }),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 6, records }] })
    const result = await sessionMessages(ctx, 's1')

    expect(names(result.records)).toEqual([
      'user/message',
      'turn/start',
      'step/start',
      'assistant/message',
      'turn/end',
    ])
    // Byte for byte what the host sent: the bridge narrows, it does not reshape.
    expect(result.records[0]).toBe(asked)
    expect(names(result.records)).not.toContain('step/end')
    expect(names(result.records)).not.toContain('system/message')
  })

  it('drops the per-step narration and keeps the turn’s last message', async () => {
    // The largest thing on the wire, and the app draws one bubble per turn.
    const first = reply(2, 1, 'Let me look at the workspace first.')
    const last = reply(6, 1, 'Done — the four issues are fixed.')
    const records = [
      prompt(0, 'fix the four issues'),
      record('turn/start', 1, { turn: 1 }),
      record('step/start', 1, { turn: 1, step: 1 }),
      first,
      record('assistant/attempt', 3, { turn: 1, step: 1, stream: [{ type: 'chunk' }] }),
      record('tool/call', 4, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }),
      record('tool/result', 5, { turn: 1, step: 1, callId: 'c1', ok: true }),
      record('step/start', 5, { turn: 1, step: 2 }),
      last,
      record('turn/end', 7, { turn: 1, reason: { kind: 'complete' } }),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 7, records }] })
    const result = await sessionMessages(ctx, 's1')

    expect(names(result.records)).toEqual([
      'user/message',
      'turn/start',
      'step/start',
      'step/start',
      'assistant/message',
      'turn/end',
    ])
    const kept = result.records.filter((value) => nameOf(value) === 'assistant/message')
    expect(kept).toHaveLength(1)
    expect(kept[0]).toBe(last)
    expect(textOf(kept[0])).toBe('Done — the four issues are fixed.')
  })

  it('keeps nothing from a turn that has not ended in the page', async () => {
    // A running turn's partial answer is not a summary of anything, the app
    // hides it anyway, and it is the largest thing on the wire.
    const partial = reply(4, 2, 'I have started by reading the bridge, and the first thing I notice')
    const records = [
      prompt(0, 'start something long'),
      record('turn/start', 1, { turn: 1 }),
      record('step/start', 2, { turn: 1, step: 1 }),
      reply(3, 1, 'First turn, finished.'),
      record('turn/end', 4, { turn: 1, reason: { kind: 'complete' } }),
      prompt(5, 'and now something longer'),
      record('turn/start', 6, { turn: 2 }),
      record('step/start', 7, { turn: 2, step: 1 }),
      partial,
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 8, records }] })
    const result = await sessionMessages(ctx, 's1')

    // The running turn keeps its boundaries and its step count, and nothing the
    // model has said so far.
    expect(names(result.records)).toEqual([
      'user/message',
      'turn/start',
      'step/start',
      'assistant/message',
      'turn/end',
      'user/message',
      'turn/start',
      'step/start',
    ])
    expect(result.records).not.toContain(partial)
  })

  it('carries a running turn whose envelope the window cut away', async () => {
    // A page is a *window*, and a window can start inside a turn: the
    // `turn/start` for the turn that is executing, and the prompt that began it,
    // are in the page before this one, and all that is left here is markers.
    //
    // The markers must travel. `turn/end` is the only record that ends a turn,
    // so a `step/start` with no end is the whole of the evidence that something
    // is running -- and it is where the phone's step count comes from. Measured
    // against a live host, the running turn's `turn/start` was at seq 803, its
    // first marker at 805, the prompt at 806 and its `turn/end` at 809; a page
    // cut at 805 carries the two markers and the prompt and nothing that names
    // the turn except the markers themselves.
    //
    // Note the order, because it is the host's and not the obvious one: the
    // operator's `user/message` is written *after* the `turn/start` it caused --
    // measured on the live wire as well as in the durable log -- and it carries
    // no `data.turn` of its own. A reader that only looks for a `turn/start`
    // *after* a prompt finds none here and leaves the running turn without it.
    const records = [
      record('step/start', 805, { turn: 101, step: 1 }),
      prompt(806, 'the prompt that started it'),
      record('step/start', 807, { turn: 101, step: 2 }),
      record('tool/call', 808, { turn: 101, step: 2, callId: 'c1', name: 'bash', arguments: '{}' }),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 900, records }] })
    const result = await sessionMessages(ctx, 's1')

    expect(names(result.records)).toEqual(['step/start', 'user/message', 'step/start'])
  })

  it('keeps a turn’s last message that has text, not merely its last message', async () => {
    // A turn that narrated, then ran tools, then ended on a step whose message
    // is tool calls: the model's answer is the earlier message. Taking the last
    // record and *then* requiring text of it drops the answer entirely, so the
    // turn renders with a prompt and no reply -- which is what the protocol
    // calls "the last assistant/message **that has a body**".
    const records = [
      prompt(0, 'check the build'),
      record('turn/start', 1, { turn: 1 }),
      record('step/start', 2, { turn: 1, step: 1 }),
      reply(3, 1, 'Let me check.'),
      record('step/end', 4, { turn: 1, step: 1 }),
      record('step/start', 5, { turn: 1, step: 2 }),
      toolOnlyReply(6, 1),
      record('turn/end', 7, { turn: 1, reason: { kind: 'complete' } }),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 7, records }] })
    const result = await sessionMessages(ctx, 's1')

    const kept = result.records.filter((value) => nameOf(value) === 'assistant/message')
    expect(kept).toHaveLength(1)
    expect(textOf(kept[0] as unknown)).toBe('Let me check.')
    expect(names(result.records)).toEqual([
      'user/message',
      'turn/start',
      'step/start',
      'assistant/message',
      'step/start',
      'turn/end',
    ])
  })

  it('keeps no assistant message for a turn whose last word had no text', async () => {
    // A step that only called tools: nothing to draw, so nothing to send.
    const records = [
      prompt(0, 'check the build'),
      record('turn/start', 1, { turn: 1 }),
      record('step/start', 2, { turn: 1, step: 1 }),
      toolOnlyReply(3, 1),
      record('turn/end', 4, { turn: 1, reason: { kind: 'complete' } }),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 4, records }] })
    const result = await sessionMessages(ctx, 's1')

    expect(names(result.records)).toEqual(['user/message', 'turn/start', 'step/start', 'turn/end'])
  })

  it('drops injected context that arrives unwrapped as well', async () => {
    // `eventOf` reads both shapes because the gateway has returned both. The
    // injected-context filter read only the wrapper, so on a host that returns
    // records unwrapped -- the shape the session log itself is written in --
    // every page carried the runtime context and the skill catalogue again.
    const wrapped = prompt(0, 'Current DSH file policy: workspace-write.', 'runtime-context')
    const unwrapped = {
      type: 'user/message',
      seq: 1,
      time: 1_700_000_000_001,
      data: {
        role: 'user',
        content: [{ type: 'text', text: '<available_skills>…' }],
        source: { kind: 'skill-catalog' },
      },
    }
    const typed = prompt(2, 'hello from the phone')
    const records = [wrapped, unwrapped, typed]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 2, records }] })
    const result = await sessionMessages(ctx, 's1')

    const users = result.records.filter((value) => nameOf(value) === 'user/message')
    expect(users).toContain(typed)
    expect(users).toHaveLength(1)
  })

  it('drops injected context but keeps a prompt written on the computer', async () => {
    // `runtime-context` and `skill-catalog` are DSH talking to itself -- 13 KB
    // of it per turn in the sessions measured here. An unrecognised source kind
    // is kept: an unrecognised injection is noise, a hidden message is data
    // loss.
    const typed = prompt(0, 'hello from the phone')
    const fromMac = prompt(1, 'hello from the computer window', 'user')
    const records = [
      typed,
      prompt(2, 'Current DSH file policy: workspace-write.', 'runtime-context'),
      prompt(3, '<available_skills>…', 'skill-catalog'),
      prompt(4, 'a background job finished', 'tool-jobs'),
      fromMac,
      record('turn/start', 5, { turn: 1 }),
      record('turn/end', 6, { turn: 1, reason: { kind: 'complete' } }),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 6, records }] })
    const result = await sessionMessages(ctx, 's1')

    const users = result.records.filter((value) => nameOf(value) === 'user/message')
    expect(users).toContain(typed)
    expect(users).toContain(fromMac)
    expect(users).toHaveLength(3)
  })

  it('leaves a record that names no turn out of the page', async () => {
    // Session setup, permission changes, the title. The phone has never drawn
    // them and the screenshot that shows a turn is built from the turn's own
    // records.
    const records = [
      record('permission/preset', 0, { preset: 'workspace-write' }),
      record('sandbox/mode', 1, { mode: 'workspace-write' }),
      record('approval/policy', 2, { policy: 'ask' }),
      record('session/title', 3, { title: 'A conversation' }),
      prompt(4, 'hello'),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 4, records }] })
    const result = await sessionMessages(ctx, 's1')

    expect(names(result.records)).toEqual(['user/message'])
  })

  it('spends the byte budget on the summary, so narration cannot evict conversation', async () => {
    // The trim is applied to what the phone is sent, not to what the host
    // returned. The other way round, 300 KB of per-step narration fills the
    // budget and the prompt it was narrating is dropped off the old end -- the
    // exact page this change exists to stop producing.
    const filler = Array.from({ length: 120 }, (_unused, index) =>
      reply(index * 3 + 1, 1, 'x'.repeat(4096)),
    )
    const asked = prompt(1000, 'the prompt that must survive')
    const last = reply(1001, 1, 'the answer that must survive')
    const records = [
      ...filler,
      record('turn/start', 999, { turn: 1 }),
      asked,
      last,
      record('turn/end', 1002, { turn: 1, reason: { kind: 'complete' } }),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 1002, records }] })
    const result = await sessionMessages(ctx, 's1')

    expect(result.records).toContain(asked)
    expect(result.records).toContain(last)
    expect(names(result.records)).toEqual([
      'turn/start',
      'user/message',
      'assistant/message',
      'turn/end',
    ])
  })

  it('keeps the order the log had', async () => {
    const records = [
      prompt(0, 'one'),
      record('turn/start', 1, { turn: 1 }),
      reply(2, 1, 'two'),
      record('turn/end', 3, { turn: 1, reason: { kind: 'complete' } }),
      prompt(4, 'three'),
      record('turn/start', 5, { turn: 2 }),
      record('step/start', 6, { turn: 2, step: 1 }),
      reply(7, 2, 'four'),
      record('turn/end', 8, { turn: 2, reason: { kind: 'complete' } }),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 8, records }] })
    const result = await sessionMessages(ctx, 's1')

    const positions = result.records.map((value) => (value as { event: { seq: number } }).event.seq)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
    expect(names(result.records)).toEqual([
      'user/message',
      'turn/start',
      'assistant/message',
      'turn/end',
      'user/message',
      'turn/start',
      'step/start',
      'assistant/message',
      'turn/end',
    ])
  })

  it('reads a record that arrived unwrapped as itself', async () => {
    // The gateway wraps a record as `{type: 'event', event: {...}}`; the same
    // record written to a session log has the event's fields at the top level.
    // Reading only the wrapper makes the unwrapped one look like an event type
    // named "turn/start" with no payload, which contributes nothing.
    const records = [
      { type: 'user/message', seq: 0, time: 1, data: { content: [{ type: 'text', text: 'plain' }] } },
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
      { type: 'assistant/message', seq: 2, time: 3, data: { turn: 1, message: { content: [{ type: 'text', text: 'wrapped or not' }] } } },
      { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'complete' } } },
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 3, records }] })
    const result = await sessionMessages(ctx, 's1')

    expect(names(result.records)).toEqual([
      'user/message',
      'turn/start',
      'assistant/message',
      'turn/end',
    ])
  })

  it('survives a page of records that are not records at all', async () => {
    const { ctx } = fakeGateway({
      frames: [{ type: 'snapshot', cursor: 3, records: [null, 7, 'x', {}, { type: 'event' }] }],
    })

    await expect(sessionMessages(ctx, 's1')).resolves.toMatchObject({ records: [] })
  })
})
