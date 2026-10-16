/**
 * A stand-in host, for verifying UI that needs state the real host cannot be
 * asked to produce on demand.
 *
 * A pending approval only exists while an agent is blocked on a tool call, so
 * the only ways to see one are to catch it live or to fake it. Catching it live
 * depends on a model deciding to call a tool, which makes it useless as a test.
 * This serves the real protocol -- the same frames, the same shapes, taken from
 * the recorded fixtures -- so the app renders actual decoded responses rather
 * than a special-cased path.
 *
 * It is a test fixture, not a host: it authenticates nothing and stores nothing.
 *
 * Usage: node scripts/mock-host.mjs [port]
 */
import { createServer } from 'node:http'
import ws from '../node_modules/ws/index.js'

const { WebSocketServer } = ws

const port = Number(process.argv[2] ?? 19395)
const CODE = 'MOCK-CODE'
// A real host rarely has pending requests and a conversation at the same time;
// the flag lets each be seen on its own.
/**
 * Whether a pending approval and question are on offer.
 *
 * A launch flag, and switchable at runtime by `/reset`. The two cards take most
 * of a phone screen, which is right -- an agent blocked on a decision is the
 * most urgent thing there is -- but it leaves a test about the conversation
 * measuring a screenful of card. A test says which it wants.
 */
let withPending = process.env['MIZAR_MOCK_PENDING'] !== '0'

/**
 * How long to stall every answer, in milliseconds.
 *
 * For the two screens that exist to say how long something is taking, and which
 * are therefore impossible to observe against a mock that answers instantly: a
 * progress bar that appears and vanishes inside one runloop turn is a progress
 * bar no test can see. Set by `/reset?slow=NNN`, and zero otherwise so the rest
 * of the suite is not slowed down for it.
 */
let answerDelayMs = 0

/**
 * Whether the mock should refuse every connection.
 *
 * A Mac that is asleep, or on a network that has gone away. Switchable at
 * runtime by `/offline?on=1` so a test can take the host away *after* the phone
 * has synced from it -- which is the only way to check that an unreachable Mac
 * does not take away what the phone already stored.
 */
let offline = false

/** A pending approval, shaped like the one the bridge builds. */
const APPROVAL = {
  requestId: 'a1b2c3d4-0000-4000-8000-000000000001',
  sessionId: 'session-mock-0001',
  toolName: 'write_file',
  callId: 'call-1',
  reason: 'Writing to a path outside the workspace',
  displayReason: {
    en: 'Writing to a path outside the workspace',
    zh: '正在写入工作区之外的路径',
  },
  requestedAt: Date.now() / 1000,
}

/** A question batch, including a plan review, which is the interesting shape. */
const QUESTION = {
  callId: 'call-2',
  sessionId: 'session-mock-0001',
  requestedAt: Date.now() / 1000,
  questions: [
    {
      id: 'q1',
      header: 'Approach',
      question: 'How should I handle the schema change?',
      detail: 'The migration is not reversible without a backup.',
      multiSelect: false,
      options: [
        { label: 'Migrate in place', description: 'Fast, and needs a backup first.' },
        { label: 'Add a new column', description: 'Slower, and reversible.' },
      ],
    },
    {
      id: 'q2',
      header: 'Plan',
      question: 'Proceed with this plan?',
      intent: { kind: 'plan-review', approve: 'Approve plan' },
      multiSelect: false,
      options: [{ label: 'Approve plan', description: 'Start implementing.' }],
    },
  ],
}

/** A session whose working directory the host has no workspace for.
 *
 * The shape of the bug: deleting a workspace removes the host's registry entry
 * and leaves the session log on disk, so `session.list` keeps returning it. A
 * phone that grouped sessions by working directory drew a row for a workspace
 * that had been deleted.
 */
const ORPHANED_SESSION = {
  sessionId: 'session-mock-orphan',
  cwd: '/Users/you/projects/deleted-workspace',
  updatedAt: Date.now() - 900_000,
  running: false,
  blank: false,
  agentAvailable: false,
  parentSessionId: null,
  origin: null,
}

const SESSION = {
  sessionId: 'session-mock-0001',
  cwd: '/Users/you/projects/demo',
  // Epoch milliseconds, which is what the host reports.
  updatedAt: Date.now() - 120_000,
  running: true,
  blank: false,
  agentAvailable: true,
  parentSessionId: null,
  origin: null,
}

/**
 * Prompts the client has sent, in order.
 *
 * The mock used to answer every prompt with `accepted` and then return a fixed
 * log, so a sent message never appeared in the conversation -- which made the
 * send path untestable and, worse, would have let a real defect through: the app
 * did not refresh the conversation after sending, so a message did not show up
 * until the operator pulled to refresh.
 */
const sentPrompts = []

/** Build one history record, shaped like the host's. */
function ev(seq, type, data) {
  return { type: 'event', event: { type, seq, time: Date.now() - (20 - seq) * 1000, data } }
}

/** Answer one client frame. */
function answer(frame) {
  const { id, type } = frame
  switch (type) {
    case 'hello':
      return {
        v: 1,
        type: 'welcome',
        id,
        hostId: 'mock-host-0000-4000-8000-000000000000',
        hostName: 'Mock Mac (fixture)',
        protocolVersion: 1,
        home: '/Users/you',
        deviceId: 'mock-device-0000-4000-8000-000000000000',
      }
    case 'workspace.list':
      // The host's own workspace registry, which is not the session list: a
      // session outlives the workspace it was created in, so a phone that
      // grouped on the working directory drew rows for workspaces that had been
      // deleted. One of these deliberately does not match any session's cwd, so
      // a test can tell "filtered by the host's list" from "grouped by cwd".
      return {
        v: 1,
        type: 'ok',
        id,
        result: {
          items: [
            { workspaceId: 'ws-demo', path: SESSION.cwd, title: 'demo' },
          ],
        },
      }
    case 'session.list':
      // Two sessions, one of them in a directory `workspace.list` does not
      // mention, so a test can tell "filtered by the host's workspace list"
      // apart from "grouped by working directory".
      return { v: 1, type: 'ok', id, result: { items: [SESSION, ORPHANED_SESSION] } }
    case 'interactions.pending':
      return {
        v: 1,
        type: 'ok',
        id,
        result: withPending ? { approvals: [APPROVAL], questions: [QUESTION] } : { approvals: [], questions: [] },
      }
    case 'session.stats':
      // Field names and nesting copied from the fixture recorded off a live
      // host. The first version of this used plausible-looking names that the
      // client could not decode, so the usage screen silently rendered "no
      // usage yet" and the UI test for it failed -- which is how the mistake
      // was found rather than shipped.
      return {
        v: 1,
        type: 'ok',
        id,
        result: {
          sessionId: SESSION.sessionId,
          asOfSeq: 17,
          stats: {
            title: 'Mock session',
            tokenUsage: {
              uncachedInputTokens: 12_480,
              outputTokens: 3_712,
              cacheReadTokens: 180_320,
              cacheWriteTokens: 4_096,
              billedInputTokens: 196_896,
            },
            // A bare number, no percent sign: the host formats it that way and the
            // app appends the symbol. Returning '92%' here made the app render
            // '92%%', which the test caught.
            cacheHit: { ratio: 0.92, displayPercent: '92' },
            context: {
              window: 128_000,
              pressureTokens: 41_000,
              projectedTokens: 44_500,
              percent: 35,
              breakdown: { systemTokens: 1_455, toolsTokens: 5_157, messageTokens: 34_388 },
            },
            stats: {
              turns: 6,
              steps: 14,
              llmMs: 48_200,
              toolMs: 6_100,
              ttftMs: 640,
              decodeTokensPerSecond: 58,
            },
            model: {
              lastUsed: {
                provider: 'deepseek-official',
                model: 'deepseek-flash',
                reasoningEffort: 'high',
              },
              next: null,
            },
            permissionPreset: 'workspace-write',
          },
        },
      }
    case 'model.catalog':
      // Copied from the real catalog. The first version invented `low/medium/high`
      // efforts; the host offers `off/low/high/max`, so the picker was being
      // tested against options that do not exist.
      return {
        v: 1,
        type: 'ok',
        id,
        result: {
          default: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' },
          providers: [
            {
              id: 'deepseek-official',
              name: 'DeepSeek',
              models: [
                {
                  id: 'deepseek-flash',
                  name: 'DeepSeek-V41-Flash',
                  defaultEffort: 'high',
                  efforts: [
                    { id: 'off', name: 'Off', description: 'Use for simple tasks that do not need reasoning.' },
                    { id: 'low', name: 'Low', description: 'Prefer for routine or latency-sensitive tasks.' },
                    { id: 'high', name: 'High', description: 'The default balance for most tasks.' },
                    { id: 'max', name: 'Max', description: 'Reserve for the hardest quality-first tasks.' },
                  ],
                },
                {
                  id: 'deepseek-v4-pro',
                  name: 'DeepSeek-V4-Pro',
                  description: 'Stronger agentic coding at higher cost.',
                  defaultEffort: 'high',
                  efforts: [
                    { id: 'off', name: 'Off', description: 'Use for simple tasks.' },
                    { id: 'high', name: 'High', description: 'The default balance.' },
                  ],
                },
              ],
            },
          ],
          failures: [{ id: 'openrouter', name: 'OpenRouter', message: 'not signed in' }],
        },
      }
    case 'permissions.catalog':
      return {
        v: 1,
        type: 'ok',
        id,
        result: {
          defaultPreset: 'workspace-write',
          defaults: [],
          options: [
            { value: 'read-only', name: 'Read only', description: 'Can look, cannot touch.' },
            { value: 'workspace-write', name: 'Workspace write', description: 'Writes inside the workspace.' },
            { value: 'danger-full-access', name: 'Full access', description: 'Unrestricted access to this machine.' },
          ],
        },
      }
    case 'session.prompt': {
      const text = typeof frame.payload?.text === 'string' ? frame.payload.text : ''
      if (text !== '') sentPrompts.push(text)
      console.log('mock: prompt received ->', JSON.stringify(text), '| log now', sentPrompts.length)
      return {
        v: 1,
        type: 'ok',
        id,
        result: { accepted: true, requestId: frame.payload?.requestId ?? 'mock-request' },
      }
    }
    case 'session.messages':
      // Record shapes copied from a real session log, including the failure this
      // machine's host produces on every turn -- and, at the end, a turn that is
      // still running.
      //
      // The running turn is the shape that was reported broken: a `turn/start`
      // with steps after it and **no `turn/end`**. The reader used to invent an
      // end time from the last record it held, so a live turn was drawn as
      // "已完成，用时 10 秒" with the seconds measuring the age of the newest
      // message. It carries two steps so the fold is exercised: neither message
      // may be shown as the turn's summary, and both must appear when the turn
      // is opened.
      return {
        v: 1,
        type: 'ok',
        id,
        result: {
          sessionId: SESSION.sessionId,
          asOfSeq: 27 + sentPrompts.length,
          hasMore: false,
          records: [
            ev(0, 'permission/preset', { preset: 'workspace-write' }),
            ev(1, 'turn/start', { turn: 1 }),
            ev(2, 'user/message', {
              content: [{ type: 'text', text: 'Refactor the parser and run the tests.' }],
              source: { kind: 'user', rpcId: 'r1' },
              role: 'user',
              id: 'm1',
            }),
            ev(3, 'step/start', { turn: 1, step: 1 }),
            ev(4, 'assistant/attempt', {
              turn: 1,
              step: 1,
              stream: [
                { type: 'chunk', time: 1, chunk: { type: 'delta', text: 'I split the tokenizer out of ' } },
                { type: 'chunk', time: 1, chunk: { type: 'delta', text: 'the parser so it can be tested alone.' } },
              ],
            }),
            ev(5, 'assistant/message', {
              turn: 1,
              step: 1,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'The parser is now two files.' }],
              },
            }),
            ev(6, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
            ev(7, 'user/message', {
              content: [{ type: 'text', text: 'Now add a case for trailing commas.' }],
              // `source.kind` is not decoration: the reader shows a
              // `user/message` only when it says a person wrote it, because DSH
              // sends its own injected context through the same event. A fixture
              // without it is a prompt that never appears -- and, worse, a turn
              // with no prompt, which is what the reader folds into the turn above
              // it. Omitting it here made one turn out of three.
              source: { kind: 'user' },
              role: 'user',
              id: 'm2',
            }),
            ev(8, 'assistant/attempt', {
              turn: 2,
              step: 1,
              stream: [
                {
                  type: 'chunk',
                  time: 1,
                  chunk: {
                    type: 'finish',
                    reason: {
                      kind: 'error',
                      failure: {
                        message:
                          'llm-deepseek: no API key for provider route "deepseek-official"',
                        code: 'MISSING_CREDENTIAL',
                      },
                    },
                  },
                },
              ],
            }),
            ev(9, 'step/end', { turn: 2, step: 1 }),
            ev(10, 'turn/end', { turn: 2, reason: { kind: 'error' } }),
            ev(11, 'turn/start', { turn: 3 }),
            ev(12, 'user/message', {
              content: [{ type: 'text', text: 'And run the whole suite.' }],
              source: { kind: 'user' },
              role: 'user',
              id: 'm3',
            }),
            ev(13, 'step/start', { turn: 3, step: 1 }),
            ev(14, 'assistant/message', {
              turn: 3,
              step: 1,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Running the tests now.' }],
              },
            }),
            ev(15, 'step/start', { turn: 3, step: 2 }),
            ev(16, 'assistant/message', {
              turn: 3,
              step: 2,
              message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'Two failures, fixing them.' }],
              },
            }),
            // No `turn/end` for turn 3: it is still working.
            // Anything the client has sent since, appended the way a host would.
            ...sentPrompts.map((text, index) =>
              ev(17 + index, 'user/message', {
                content: [{ type: 'text', text }],
                source: { kind: 'user' },
                role: 'user',
                id: `sent-${index}`,
              }),
            ),
          ],
        },
      }
    case 'ping':
      return { v: 1, type: 'ok', id }
    case 'approval.answer':
    case 'question.answer':
      return { v: 1, type: 'ok', id, result: { accepted: true } }
    default:
      return { v: 1, type: 'ok', id, result: {} }
  }
}

const server = createServer((request, response) => {
  if (request.url?.startsWith('/offline')) {
    offline = (request.url ?? '').includes('on=1')
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, offline }))
    return
  }
  if (request.url?.startsWith('/slow')) {
    // Set the stall *after* the app is up, so a test can make one screen slow
    // without also making the launch that leads to it slow.
    const match = /ms=(\d+)/.exec(request.url ?? '')
    answerDelayMs = match === null ? 0 : Math.min(5000, Number(match[1]))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, delayMs: answerDelayMs }))
    return
  }
  if (request.url?.startsWith('/reset')) {
    // Between UI tests, so each one starts from the same fixture.
    //
    // `sentPrompts` is deliberate -- the conversation has to grow when something
    // is sent, or the send path is untestable -- but it grew for the life of the
    // process, which is the whole suite. Every test after the first send
    // therefore ran against a longer conversation than the one before it, and a
    // test that scrolled to find a message found a different amount of content
    // depending on which tests had run first. That is a suite whose failures
    // depend on test order, which is a suite nobody can trust.
    sentPrompts.length = 0
    // `?pending=0` takes the two interaction cards off the screen, for a test
    // that is about what is underneath them. The default is to offer them.
    withPending = !(request.url ?? '').includes('pending=0')
    const slow = /slow=(\d+)/.exec(request.url ?? '')
    answerDelayMs = slow === null ? 0 : Math.min(5000, Number(slow[1]))
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true }))
    return
  }
  if (request.url?.startsWith('/mizar/v1/hello')) {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({
      protocolVersion: 1,
      hostId: 'mock-host-0000-4000-8000-000000000000',
      hostName: 'Mock Mac (fixture)',
      paired: false,
      pairingOpen: true,
    }))
    return
  }
  if (request.url?.startsWith('/mizar/v1/pair')) {
    let body = ''
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      let parsed = {}
      try { parsed = JSON.parse(body) } catch { /* refuse below */ }
      if (parsed.code !== CODE) {
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ code: 'BAD_CODE', message: 'wrong code' }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        deviceToken: 'mz_mock_token',
        deviceId: 'mock-device-0000-4000-8000-000000000000',
        hostId: 'mock-host-0000-4000-8000-000000000000',
        hostName: 'Mock Mac (fixture)',
        authority: `127.0.0.1:${port}`,
        protocolVersion: 1,
      }))
    })
    return
  }
  response.writeHead(404).end()
})

const wss = new WebSocketServer({ server, path: '/mizar/v1/ws' })
wss.on('connection', (socket) => {
  if (offline) {
    // Closed immediately rather than left hanging: a socket that opens and then
    // says nothing is what a network failure looks like from the app's side, and
    // that is the case being reproduced.
    socket.close(1011, 'mock offline')
    return
  }
  socket.on('message', (raw) => {
    let frame
    try { frame = JSON.parse(String(raw)) } catch { return }
    const reply = () => socket.send(JSON.stringify(answer(frame)))
    if (answerDelayMs === 0) reply()
    else setTimeout(reply, answerDelayMs)
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock host on 127.0.0.1:${port}, code ${CODE}`)
  console.log(`mizar://pair?h=127.0.0.1%3A${port}&c=${CODE}&n=Mock%20Mac&v=1`)
})
