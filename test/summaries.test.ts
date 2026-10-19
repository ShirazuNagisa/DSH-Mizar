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
import { sessionActivity, sessionMessages } from '../src/bridge/sessions.js'

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

/** The content parts of a message record the bridge returned. */
function contentOf(value: unknown): unknown[] {
  const data = eventOf(value)['data'] as { content?: unknown } | undefined
  return Array.isArray(data?.content) ? data.content : []
}

/** One durable image content block, as a committed user message carries it. */
function imageBlock(name: string): unknown {
  return {
    type: 'image',
    attachment: { attachmentId: `image-${name}`, name, mediaType: 'image/jpeg', bytes: 1024 },
  }
}

/** One durable file content block, as a committed user message carries it. */
function fileBlock(name: string): unknown {
  return {
    type: 'file',
    attachment: { attachmentId: `file-${name}`, name, mediaType: 'application/pdf', bytes: 2048 },
  }
}

/**
 * One user message with the given content parts.
 * @param seq - the log position.
 * @param content - the content blocks.
 * @param kind - the message source kind; `user` unless a test is proving a filter.
 * @returns the record.
 */
function userContent(seq: number, content: unknown[], kind = 'user'): unknown {
  return record('user/message', seq, { role: 'user', content, source: { kind } })
}

describe('attachment-only prompts in the summary', () => {
  it('appends [Photo] to an image-only prompt', async () => {
    // A prompt that is only a photo has no text part, and the conversation
    // screen draws text -- without a placeholder the turn renders as an empty
    // bubble with nothing to say an image is there.
    const onlyPhoto = userContent(0, [imageBlock('IMG_0001.JPG')])
    const records = [
      onlyPhoto,
      record('turn/start', 1, { turn: 1 }),
      record('turn/end', 2, { turn: 1, reason: { kind: 'complete' } }),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 2, records }] })
    const result = await sessionMessages(ctx, 's1')

    const users = result.records.filter((value) => nameOf(value) === 'user/message')
    expect(users).toHaveLength(1)
    expect(contentOf(users[0])).toEqual([imageBlock('IMG_0001.JPG'), { type: 'text', text: '[Photo]' }])
    // The host's record is not mutated: this object is the durable log record,
    // and another reader may be holding the same one.
    expect(contentOf(onlyPhoto)).toHaveLength(1)
  })

  it('appends [File: name] to a file-only prompt, one line per file', async () => {
    const onlyFiles = userContent(0, [fileBlock('report.pdf'), fileBlock('notes.txt')])
    const records = [
      onlyFiles,
      record('turn/start', 1, { turn: 1 }),
      record('turn/end', 2, { turn: 1, reason: { kind: 'complete' } }),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 2, records }] })
    const result = await sessionMessages(ctx, 's1')

    const user = result.records.find((value) => nameOf(value) === 'user/message')
    expect(contentOf(user)).toEqual([
      fileBlock('report.pdf'),
      fileBlock('notes.txt'),
      { type: 'text', text: '[File: report.pdf]\n[File: notes.txt]' },
    ])
  })

  it('says [File] when the block carries no name', async () => {
    const nameless = userContent(0, [{ type: 'file', attachment: { attachmentId: 'f1', bytes: 10 } }])
    const records = [nameless, record('turn/start', 1, { turn: 1 }), record('turn/end', 2, { turn: 1, reason: { kind: 'complete' } })]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 2, records }] })
    const result = await sessionMessages(ctx, 's1')

    const user = result.records.find((value) => nameOf(value) === 'user/message')
    expect(contentOf(user)).toContainEqual({ type: 'text', text: '[File]' })
  })

  it('leaves a prompt that already has text untouched, byte for byte', async () => {
    // Placeholders are for prompts with nothing to read. A prompt with text must
    // travel as the identical object: the bridge narrows pages, it does not
    // reshape records.
    const withCaption = userContent(0, [
      { type: 'text', text: 'what is this?' },
      imageBlock('IMG_0002.JPG'),
    ])
    const records = [
      withCaption,
      record('turn/start', 1, { turn: 1 }),
      record('turn/end', 2, { turn: 1, reason: { kind: 'complete' } }),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 2, records }] })
    const result = await sessionMessages(ctx, 's1')

    const user = result.records.find((value) => nameOf(value) === 'user/message')
    expect(user).toBe(withCaption)
  })

  it('adds the placeholder to an unwrapped record in the log’s own shape', async () => {
    // The gateway wraps records as `{type: 'event', event: {...}}`; a host that
    // returns the durable log's shape has the event's fields at the top level.
    const unwrapped = {
      type: 'user/message',
      seq: 0,
      time: 1,
      data: { role: 'user', content: [imageBlock('IMG_0003.JPG')], source: { kind: 'user' } },
    }
    const records = [
      unwrapped,
      { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
      { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'complete' } } },
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 2, records }] })
    const result = await sessionMessages(ctx, 's1')

    const user = result.records.find((value) => nameOf(value) === 'user/message')
    expect(nameOf(user)).toBe('user/message')
    expect(contentOf(user)).toEqual([imageBlock('IMG_0003.JPG'), { type: 'text', text: '[Photo]' }])
    // And the original object's content is not touched.
    expect((unwrapped.data.content as unknown[]).length).toBe(1)
  })

  it('still drops injected context that happens to carry an image', async () => {
    // The injected-context rule is about who wrote the message, not what it
    // contains: a runtime-context record with an image is still not a prompt.
    const records = [
      userContent(0, [imageBlock('system.png')], 'runtime-context'),
      userContent(1, [imageBlock('IMG_0004.JPG')]),
      record('turn/start', 2, { turn: 1 }),
      record('turn/end', 3, { turn: 1, reason: { kind: 'complete' } }),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 3, records }] })
    const result = await sessionMessages(ctx, 's1')

    const users = result.records.filter((value) => nameOf(value) === 'user/message')
    expect(users).toHaveLength(1)
    expect(contentOf(users[0])).toEqual([imageBlock('IMG_0004.JPG'), { type: 'text', text: '[Photo]' }])
  })
})

/** One event record as the activity tests need it, with an explicit time. */
function eventAt(type: string, seq: number, data: Record<string, unknown>, time: number): unknown {
  return { type: 'event', event: { type, seq, time, data } }
}

/** A compact `assistant/attempt` event carrying the given stream records. */
function attempt(seq: number, turn: number, stream: unknown[]): unknown {
  return record('assistant/attempt', seq, { turn, step: 1, stream })
}

/** A `tool/call` event. */
function toolCall(seq: number, turn: number, callId: string, name: string, args: unknown): unknown {
  return record('tool/call', seq, { turn, step: 1, callId, name, arguments: args })
}

/** A `tool/result` event whose tool message carries one text block. */
function toolResult(seq: number, turn: number, callId: string, text: string): unknown {
  return record('tool/result', seq, {
    turn,
    step: 1,
    callId,
    message: { role: 'tool', content: [{ type: 'text', text }], source: { kind: 'tool', callId } },
  })
}

/** The event names in an activity answer, as a short list of kinds. */
function kinds(entries: readonly { kind: string }[]): string[] {
  return entries.map((entry) => entry.kind)
}

describe('session.activity — the running turn', () => {
  it('returns only the unfinished turn, mapped to compact one-line rows', async () => {
    const records = [
      prompt(0, 'first task'),
      record('turn/start', 1, { turn: 1 }),
      record('step/start', 2, { turn: 1, step: 1 }),
      attempt(3, 1, [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['finished answer'] }]),
      record('turn/end', 4, { turn: 1, reason: { kind: 'complete' } }),
      prompt(5, 'second task'),
      record('turn/start', 6, { turn: 2 }),
      record('step/start', 7, { turn: 2, step: 1 }),
      attempt(8, 2, [
        { type: 'reasoning-chunks', time0: 1, index: 0, dt: [], texts: ['thinking about '] },
        { type: 'text-chunks', time0: 2, index: 1, dt: [], texts: ['the fix'] },
      ]),
      toolCall(9, 2, 'call-1', 'bash', JSON.stringify({ command: 'npm test' })),
      toolResult(10, 2, 'call-1', 'Tests 550 passed\nsecond line is not shown'),
      record('assistant/message', 11, {
        turn: 2,
        step: 1,
        message: { content: [{ type: 'text', text: 'a committed reply' }] },
      }),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 11, records }] })
    const result = await sessionActivity(ctx, 's1')

    expect(result).toMatchObject({ sessionId: 's1', asOfSeq: 11, turn: 2, hasMore: false })
    // The ended turn's narration and every committed message are absent: the
    // summary page draws those, this feed draws the process.
    expect(kinds(result.entries)).toEqual(['thinking', 'command', 'output'])
    expect(result.entries.map((entry) => entry.id)).toEqual(['seq-8', 'seq-9', 'seq-10'])
    expect(result.entries[0]).toMatchObject({
      seq: 8,
      at: 1_700_000_000_008,
      kind: 'thinking',
      title: '',
      text: 'thinking about the fix',
    })
    expect(result.entries[1]).toMatchObject({
      kind: 'command',
      title: 'bash',
      text: 'npm test',
    })
    // The result is titled by the call it answers and shows only its first line.
    expect(result.entries[2]).toMatchObject({
      kind: 'output',
      title: 'bash',
      text: 'Tests 550 passed',
    })
  })

  it('takes the highest unfinished turn when the page window starts inside it', async () => {
    // A window can begin mid-turn, so there is no `turn/start` for the turn that
    // is running. The markers and attempts still name it, and no `turn/end`
    // does, which is the definition of running.
    const records = [
      record('step/start', 805, { turn: 101, step: 1 }),
      attempt(806, 101, [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['still working'] }]),
      record('step/start', 807, { turn: 101, step: 2 }),
      toolCall(808, 101, 'call-1', 'read_file', JSON.stringify({ path: '/tmp/a', description: 'read /tmp/a' })),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 900, records }] })
    const result = await sessionActivity(ctx, 's1')

    expect(result.turn).toBe(101)
    expect(kinds(result.entries)).toEqual(['thinking', 'tool'])
    expect(result.entries[1]).toMatchObject({ kind: 'tool', title: 'read_file', text: 'read /tmp/a' })
  })

  it('answers an empty feed when every turn in the page has ended', async () => {
    const records = [
      prompt(0, 'one'),
      record('turn/start', 1, { turn: 1 }),
      record('step/start', 2, { turn: 1, step: 1 }),
      attempt(3, 1, [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['done'] }]),
      record('turn/end', 4, { turn: 1, reason: { kind: 'complete' } }),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 4, records }] })
    const result = await sessionActivity(ctx, 's1')

    expect(result).toEqual({
      sessionId: 's1',
      asOfSeq: 4,
      turn: null,
      entries: [],
      hasMore: false,
      // The page's smallest position, so a phone that has nothing to draw yet
      // still has the cursor a later page would need.
      oldestSeq: 0,
    })
  })

  it('answers an empty feed for a session with no log at all', async () => {
    const { ctx } = fakeGateway({ streamThrows: true, projections: null })
    const result = await sessionActivity(ctx, 'missing')

    expect(result).toEqual({
      sessionId: 'missing',
      asOfSeq: null,
      turn: null,
      entries: [],
      hasMore: false,
      oldestSeq: null,
    })
  })

  it('refuses a backwards page that names no turn', async () => {
    // The wire refuses this pair before any read (see the bridge's reader); this
    // is the same rule stated at the function boundary, so an internal caller
    // cannot get a forward answer to a backwards question.
    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 4, records: [] }] })
    await expect(sessionActivity(ctx, 's1', undefined, 42)).rejects.toMatchObject({
      code: 'MALFORMED_FRAME',
    })
  })

  it('still leaves the summary page byte for byte as it was', async () => {
    // The activity read must not change what `session.messages` returns, even
    // for the same page: the summary keeps its step markers and drops process,
    // the activity feed does the opposite.
    const records = [
      prompt(0, 'run the tests'),
      record('turn/start', 1, { turn: 1 }),
      record('step/start', 2, { turn: 1, step: 1 }),
      attempt(3, 1, [{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['running'] }]),
      toolCall(4, 1, 'call-1', 'bash', JSON.stringify({ command: 'npm test' })),
      toolResult(5, 1, 'call-1', 'ok'),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 5, records }] })
    const summary = await sessionMessages(ctx, 's1')
    const activity = await sessionActivity(ctx, 's1')

    expect(names(summary.records)).toEqual(['user/message', 'turn/start', 'step/start'])
    expect(kinds(activity.entries)).toEqual(['thinking', 'command', 'output'])
    // Same current page, same cut, and the activity read asked for the bounded
    // page window rather than an unbounded one.
    expect(activity.asOfSeq).toBe(summary.asOfSeq)
  })
})

describe('session.activity — mapping', () => {
  it('maps JSON arguments, non-JSON arguments and plain objects to one line', async () => {
    const records = [
      record('turn/start', 1, { turn: 1 }),
      toolCall(2, 1, 'c1', 'bash', JSON.stringify({ command: 'ls -la\npwd' })),
      toolCall(3, 1, 'c2', 'grep', 'plain "not" json'),
      toolCall(4, 1, 'c3', 'custom', { path: '/tmp/x', description: 'a described tool' }),
      toolCall(5, 1, 'c4', 'shell', JSON.stringify({ description: 'only a description' })),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 5, records }] })
    const result = await sessionActivity(ctx, 's1')

    expect(result.entries.map((entry) => [entry.kind, entry.title, entry.text])).toEqual([
      ['command', 'bash', 'ls -la pwd'],
      // A tool whose name is not a shell runner keeps the tool kind, even when
      // its argument string is not JSON.
      ['tool', 'grep', 'plain "not" json'],
      // A non-command tool keeps the tool kind, and an object argument is JSON.
      ['tool', 'custom', '{"path":"/tmp/x","description":"a described tool"}'],
      // `shell` is command-like even when the argument shape is unusual.
      ['command', 'shell', 'only a description'],
    ])
  })

  it('recovers the detail from an error result and leaves unknown output titleless', async () => {
    const records = [
      record('turn/start', 1, { turn: 1 }),
      record('tool/result', 2, {
        turn: 1,
        step: 1,
        callId: 'call-from-previous-page',
        message: { role: 'tool', content: [{ type: 'text', text: '' }] },
        error: { name: 'CommandError', code: 'E2', reason: 'command failed' },
      }),
      record('tool/result', 3, {
        turn: 1,
        step: 1,
        callId: 'call-2',
        output: 'file one\nfile two',
      }),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 3, records }] })
    const result = await sessionActivity(ctx, 's1')

    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]).toMatchObject({ kind: 'output', title: '', text: 'command failed' })
    // The call is not in this page, so the title is not invented.
    expect(result.entries[1]).toMatchObject({ kind: 'output', title: '', text: 'file one' })
  })

  it('flattens and truncates narration to one 240-character line', async () => {
    const long = `${'reasoning '.repeat(40)}\nsecond line`
    const records = [
      record('turn/start', 1, { turn: 1 }),
      attempt(2, 1, [
        {
          type: 'chunk',
          time: 1,
          chunk: { type: 'text-delta', index: 0, text: 'first   ' },
        },
        {
          type: 'chunk',
          time: 2,
          chunk: { type: 'reasoning-delta', index: 1, text: '\n second' },
        },
        // A live attempt streams `TimedStreamChunk` records, which have no
        // wrapper `type` at all; the nested chunk is what carries the text.
        { time: 4, chunk: { type: 'text-delta', index: 0, text: ' live' } },
        {
          type: 'chunk',
          time: 3,
          chunk: {
            type: 'block-end',
            index: 0,
            block: { type: 'text', text: 'settled block is not joined twice' },
          },
        },
      ]),
      attempt(3, 1, [{ type: 'reasoning-chunks', time0: 1, index: 0, dt: [], texts: [long] }]),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 3, records }] })
    const result = await sessionActivity(ctx, 's1')

    expect(result.entries).toHaveLength(2)
    expect(result.entries[0]?.text).toBe('first second live')
    expect(result.entries[1]?.text).toHaveLength(240)
    expect(result.entries[1]?.text).not.toContain('\n')
    expect(result.entries[1]?.text.startsWith('reasoning reasoning')).toBe(true)
  })

  it('skips events that are not process detail instead of dumping payloads', async () => {
    const records = [
      prompt(0, 'hello'),
      record('turn/start', 1, { turn: 1 }),
      record('step/start', 2, { turn: 1, step: 1 }),
      record('system/message', 3, { turn: 1, step: 1, message: { content: [] } }),
      record('request/header', 4, { header: { huge: true } }),
      record('assistant/message', 5, { turn: 1, step: 1, message: { content: [] } }),
      record('tool/call', 6, { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }),
      record('session/title', 7, { title: 'a title' }),
    ]

    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 7, records }] })
    const result = await sessionActivity(ctx, 's1')

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({ id: 'seq-6', kind: 'command', title: 'bash' })
  })
})

describe('session.activity — bounds', () => {
  /** A running turn with `count` tool calls numbered from `firstSeq`. */
  function callsRecords(count: number, firstSeq = 1000): unknown[] {
    const records: unknown[] = [record('turn/start', firstSeq - 1, { turn: 1 })]
    for (let index = 0; index < count; index += 1) {
      records.push(toolCall(firstSeq + index, 1, `call-${index}`, 'bash', JSON.stringify({ command: `step ${index}` })))
    }
    return records
  }

  it('defaults to 200 entries and reports that older rows were trimmed', async () => {
    const records = callsRecords(205)
    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 3000, records }] })
    const result = await sessionActivity(ctx, 's1')

    expect(result.entries).toHaveLength(200)
    expect(result.hasMore).toBe(true)
    // The newest rows are kept; the five oldest are the ones dropped.
    expect(result.entries[0]?.seq).toBe(1005)
    expect(result.entries[199]?.seq).toBe(1204)
  })

  it('honours a smaller maxEntries and clamps a larger one to 300', async () => {
    const records = callsRecords(305)
    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 4000, records }] })

    const small = await sessionActivity(ctx, 's1', 10)
    expect(small.entries).toHaveLength(10)
    expect(small.hasMore).toBe(true)
    expect(small.entries[9]?.seq).toBe(1304)

    const large = await sessionActivity(ctx, 's1', 10_000)
    expect(large.entries).toHaveLength(300)
    expect(large.entries[299]?.seq).toBe(1304)

    // An unusable request is the default, not an empty feed or an error.
    const fallback = await sessionActivity(ctx, 's1', -5)
    expect(fallback.entries).toHaveLength(200)
  })

  it('trims by the 256 KiB byte budget, keeping the newest rows', async () => {
    // 300 rows of three-byte characters: ~1.1 KB of JSON each, well past the
    // budget. The feed must still leave the host as one small frame.
    const records: unknown[] = [record('turn/start', 1, { turn: 1 })]
    for (let index = 0; index < 300; index += 1) {
      records.push(
        toolCall(
          2 + index,
          1,
          `call-${index}`,
          '命'.repeat(120),
          JSON.stringify({ command: '中'.repeat(240) }),
        ),
      )
    }
    const { ctx } = fakeGateway({ frames: [{ type: 'snapshot', cursor: 10_000, records }] })
    const result = await sessionActivity(ctx, 's1', 300)

    expect(result.hasMore).toBe(true)
    expect(result.entries.length).toBeLessThan(300)
    expect(result.entries.length).toBeGreaterThan(0)
    const bytes = Buffer.byteLength(JSON.stringify(result.entries), 'utf8')
    expect(bytes).toBeLessThanOrEqual(256 * 1024)
    // The newest row survived; the trimmed ones are the oldest. The calls were
    // numbered 2..301, so 301 is the last one.
    expect(result.entries[result.entries.length - 1]?.seq).toBe(301)
  })
})
