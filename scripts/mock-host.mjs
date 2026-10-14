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
import ws from '../dsh/node_modules/ws/index.js'

const { WebSocketServer } = ws

const port = Number(process.argv[2] ?? 19395)
const CODE = 'MOCK-CODE'
// A real host rarely has pending requests and a conversation at the same time;
// the flag lets each be seen on its own.
const WITH_PENDING = process.env['MIZAR_MOCK_PENDING'] !== '0'

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
    case 'session.list':
      return { v: 1, type: 'ok', id, result: { items: [SESSION] } }
    case 'interactions.pending':
      return {
        v: 1,
        type: 'ok',
        id,
        result: WITH_PENDING ? { approvals: [APPROVAL], questions: [QUESTION] } : { approvals: [], questions: [] },
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
    case 'session.messages':
      // Record shapes copied from a real session log, including the failure this
      // machine's host produces on every turn.
      return {
        v: 1,
        type: 'ok',
        id,
        result: {
          sessionId: SESSION.sessionId,
          asOfSeq: 17,
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
            ev(5, 'user/message', {
              content: [{ type: 'text', text: 'Now add a case for trailing commas.' }],
              role: 'user',
              id: 'm2',
            }),
            ev(6, 'assistant/attempt', {
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
            ev(7, 'step/end', { turn: 2, step: 1 }),
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
  socket.on('message', (raw) => {
    let frame
    try { frame = JSON.parse(String(raw)) } catch { return }
    socket.send(JSON.stringify(answer(frame)))
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock host on 127.0.0.1:${port}, code ${CODE}`)
  console.log(`mizar://pair?h=127.0.0.1%3A${port}&c=${CODE}&n=Mock%20Mac&v=1`)
})
