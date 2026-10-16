#!/usr/bin/env node
/**
 * End-to-end smoke test for the Mizar listener.
 *
 * Drives a running dev instance over the real wire — no mocks — and asserts the
 * behaviour that actually protects the operator: a wrong pairing code is
 * refused, a redeemed code cannot be replayed, an unknown token is rejected
 * before any method runs, and a malformed or wrong-version frame is answered
 * with a specific code instead of being half-read.
 *
 * Run it against a booted dev profile (`scripts/dev.sh boot`), passing the
 * pairing code the plugin logged at startup:
 *
 *   MIZAR_CODE=AB2C-D3EF node scripts/smoke-listener.mjs
 *
 * Node 24 ships a global `WebSocket`, so this client needs no dependencies.
 *
 * @module dsh-mizar/smoke-listener
 */

const BASE = process.env['MIZAR_BASE'] ?? 'http://127.0.0.1:19390'
const CODE = process.env['MIZAR_CODE'] ?? ''
const WS_URL = BASE.replace(/^http/, 'ws') + '/mizar/v1/ws'

let passed = 0
let failed = 0

/**
 * Golden frames captured from the live host, shared with the Swift side.
 *
 * Set MIZAR_WRITE_FIXTURES=1 to refresh them (via scripts/dev.sh smoke). Both
 * test suites decode these files, so a change to what the host actually sends
 * fails on the side that did not change — which is the only way a two-language
 * contract stays honest.
 */
const FIXTURE_DIR = new URL('../protocol/fixtures/', import.meta.url)
const recordFixtures = process.env['MIZAR_WRITE_FIXTURES'] === '1'
const fixtures = {}

/**
 * Record one frame for the fixture set.
 * @param {string} name - fixture file name, without extension.
 * @param {any} frame - the frame exactly as it arrived.
 */
function record(name, frame) {
  if (!recordFixtures || frame === undefined || frame === null) return
  fixtures[name] = frame
}

/** Write the recorded frames, or report why nothing was written. */
async function flushFixtures() {
  if (!recordFixtures) return
  const { mkdir, writeFile } = await import('node:fs/promises')
  await mkdir(FIXTURE_DIR, { recursive: true })
  for (const [name, frame] of Object.entries(fixtures)) {
    await writeFile(new URL(`${name}.json`, FIXTURE_DIR), `${JSON.stringify(frame, null, 2)}\n`, 'utf8')
  }
  console.log(`\nfixtures: wrote ${Object.keys(fixtures).length} frame(s) to protocol/fixtures/`)
}

/** Small pause helper. */
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Record one assertion.
 * @param {string} name - what was checked.
 * @param {boolean} ok - whether it held.
 * @param {string} detail - extra context shown on failure.
 */
function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  }
}

/**
 * Perform one HTTP request and decode the JSON body.
 * @param {string} path - path relative to the base.
 * @param {object} [init] - fetch options.
 * @returns {Promise<{status: number, body: any}>} status and parsed body.
 */
async function http(path, init) {
  const response = await fetch(`${BASE}${path}`, init)
  let body
  try {
    body = await response.json()
  } catch {
    body = undefined
  }
  return { status: response.status, body }
}

/**
 * Open a socket and return a small driver for it.
 * @returns {Promise<{send: (o: object) => void, next: (ms?: number) => Promise<any>, close: () => void, closed: Promise<{code: number}>}>} the driver.
 */
function connect() {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(WS_URL)
    const queue = []
    const waiters = []
    let closeInfo

    socket.addEventListener('message', (event) => {
      const value = JSON.parse(String(event.data))
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter(value)
      else queue.push(value)
    })
    socket.addEventListener('error', () => reject(new Error('socket error')))
    socket.addEventListener('close', (event) => {
      closeInfo = { code: event.code, reason: event.reason }
      for (const waiter of waiters.splice(0)) waiter({ __closed: true, code: event.code })
    })
    socket.addEventListener('open', () => {
      resolve({
        send: (value) => socket.send(JSON.stringify(value)),
        next: (ms = 5000) =>
          new Promise((resolveNext) => {
            const queued = queue.shift()
            if (queued !== undefined) return resolveNext(queued)
            if (closeInfo !== undefined) return resolveNext({ __closed: true, code: closeInfo.code })
            const timer = setTimeout(() => resolveNext({ __timeout: true }), ms)
            waiters.push((value) => {
              clearTimeout(timer)
              resolveNext(value)
            })
          }),
        close: () => socket.close(),
        closed: new Promise((resolveClosed) => {
          if (closeInfo !== undefined) return resolveClosed(closeInfo)
          socket.addEventListener('close', (event) =>
            resolveClosed({ code: event.code, reason: event.reason }),
          )
        }),
      })
    })
  })
}

async function main() {
  console.log(`mizar smoke: ${BASE}`)
  if (CODE === '') {
    console.error('mizar smoke: set MIZAR_CODE (the code the plugin logged at startup)')
    process.exit(2)
  }

  // ── unauthenticated surface ────────────────────────────────────────────────
  console.log('\nhello endpoint')
  const hello = await http('/mizar/v1/hello')
  check('GET /hello answers 200', hello.status === 200, `got ${hello.status}`)
  check('reports protocol version 1', hello.body?.protocolVersion === 1, JSON.stringify(hello.body))
  check('reports a pairing code is open', hello.body?.pairingOpen === true, JSON.stringify(hello.body))
  // Deliberately not "no device paired yet": the state file outlives the host,
  // so the test has to be re-runnable against an instance that already has
  // devices. What matters is that the flag is a real boolean and that pairing
  // moves it to true.
  check('reports the paired flag', typeof hello.body?.paired === 'boolean', JSON.stringify(hello.body))
  check('never leaks the pairing code', !JSON.stringify(hello.body ?? {}).includes(CODE.replace('-', '')))

  const missing = await http('/mizar/v1/nope')
  check('unknown path answers 404', missing.status === 404, `got ${missing.status}`)

  const wrongMethod = await http('/mizar/v1/pair')
  check('GET /pair answers 405', wrongMethod.status === 405, `got ${wrongMethod.status}`)

  // ── pairing ───────────────────────────────────────────────────────────────
  console.log('\npairing')
  const wrong = await http('/mizar/v1/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: CODE === '0000-0000' ? '1111-1111' : '0000-0000' }),
  })
  check('a wrong code is refused', wrong.status === 401, `got ${wrong.status}`)
  check('a wrong code reports PAIRING_CODE_INVALID', wrong.body?.error === 'PAIRING_CODE_INVALID', JSON.stringify(wrong.body))

  const garbage = await http('/mizar/v1/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{ not json',
  })
  check('a malformed body is refused', garbage.status === 400, `got ${garbage.status}`)

  const paired = await http('/mizar/v1/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: CODE,
      deviceName: 'Smoke Test iPhone',
      deviceModel: 'iPhone Simulator',
      appVersion: '0.0.1',
      protocolVersion: 1,
    }),
  })
  check('a valid code pairs', paired.status === 200, `got ${paired.status} ${JSON.stringify(paired.body)}`)

  if (paired.status !== 200) {
    // Everything below needs a token, so a pairing failure would otherwise
    // cascade into two dozen misleading failures. Pairing codes are single-use,
    // so the usual cause is re-running against an instance whose code was
    // already redeemed — use `scripts/dev.sh smoke`, which reboots first.
    console.error(
      `\nmizar smoke: pairing failed (${paired.status} ${JSON.stringify(paired.body)}).\n` +
        'Pairing codes are single use; use `scripts/dev.sh smoke` to reboot and re-issue one.',
    )
    process.exit(1)
  }

  const token = paired.body?.deviceToken
  check('pairing returns a device token', typeof token === 'string' && token.startsWith('mz_'), String(token))
  check('pairing returns the host identity', typeof paired.body?.hostId === 'string' && paired.body.hostId !== '')
  check('pairing echoes the protocol version', paired.body?.protocolVersion === 1)
  // The device this run paired, by id. A dev home accumulates one per run, and
  // every one of them is called "Smoke Test iPhone" -- so looking the device up
  // by name later finds somebody else's, and a revocation test that revokes the
  // wrong device passes while proving nothing.
  const deviceId = paired.body?.deviceId
  check('pairing returns the device id', typeof deviceId === 'string' && deviceId !== '', String(deviceId))

  const replay = await http('/mizar/v1/pair', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code: CODE }),
  })
  check('a redeemed code cannot be replayed', replay.status === 401 || replay.status === 410, `got ${replay.status}`)

  const afterPair = await http('/mizar/v1/hello')
  check('hello now reports a paired device', afterPair.body?.paired === true, JSON.stringify(afterPair.body))
  check('hello no longer reports an open code', afterPair.body?.pairingOpen === false, JSON.stringify(afterPair.body))

  // ── rejected socket ───────────────────────────────────────────────────────
  console.log('\nwebsocket: authentication')
  const unauth = await connect()
  unauth.send({ v: 1, type: 'hello', id: 'h0', token: 'mz_not-a-real-token' })
  const unauthReply = await unauth.next()
  check('an unknown token is refused', unauthReply?.code === 'UNAUTHENTICATED', JSON.stringify(unauthReply))
  const unauthClose = await unauth.closed
  check('the socket is closed after refusal', unauthClose.code === 4401, JSON.stringify(unauthClose))

  const preAuth = await connect()
  preAuth.send({ v: 1, type: 'ping', id: 'p0' })
  const preAuthReply = await preAuth.next()
  check('a method before hello is refused', preAuthReply?.code === 'UNAUTHENTICATED', JSON.stringify(preAuthReply))
  preAuth.close()

  // A device that has nothing stored: the app's own "not paired yet" state, and
  // the answer that sends it to the pairing screen rather than to an error.
  const unpaired = await connect()
  unpaired.send({ v: 1, type: 'hello', id: 'h0', token: '' })
  const unpairedReply = await unpaired.next()
  check(
    'a hello with no token answers PAIRING_REQUIRED',
    unpairedReply?.code === 'PAIRING_REQUIRED',
    JSON.stringify(unpairedReply),
  )

  // ── authenticated socket ──────────────────────────────────────────────────
  console.log('\nwebsocket: authenticated session')
  const session = await connect()
  session.send({ v: 1, type: 'hello', id: 'h1', token, appVersion: '0.0.1', protocolVersion: 1 })
  const welcome = await session.next()
  check('a valid token is accepted', welcome?.type === 'welcome', JSON.stringify(welcome))
  check('welcome carries the host name', typeof welcome?.hostName === 'string' && welcome.hostName !== '')
  check('welcome carries the device id', typeof welcome?.deviceId === 'string' && welcome.deviceId !== '')
  record('welcome', welcome)

  session.send({ v: 1, type: 'ping', id: 'p1' })
  const pong = await session.next()
  check('ping is answered', pong?.type === 'ok' && pong.id === 'p1', JSON.stringify(pong))

  // Phase 2 adds methods, so this probes a name that no phase will implement
  // rather than one that is merely unimplemented today.
  session.send({ v: 1, type: 'no.such.method', id: 's1' })
  const notImplemented = await session.next()
  check(
    'an unknown method answers NOT_IMPLEMENTED with its id',
    notImplemented?.code === 'NOT_IMPLEMENTED' && notImplemented.id === 's1',
    JSON.stringify(notImplemented),
  )

  session.send({ v: 2, type: 'ping', id: 'p2' })
  const versionMismatch = await session.next()
  check('a wrong protocol version is refused', versionMismatch?.code === 'PROTOCOL_VERSION_MISMATCH', JSON.stringify(versionMismatch))

  session.send({ v: 1, type: 'ping' })
  const noId = await session.next()
  check('a request without an id is refused', noId?.code === 'MALFORMED_FRAME', JSON.stringify(noId))

  session.send({ v: 1, type: 'hello', id: 'h2', token })
  const reHello = await session.next()
  check('a second hello is refused', reHello?.code === 'MALFORMED_FRAME', JSON.stringify(reHello))

  // The socket must still be usable: a protocol error is not a fatal error.
  session.send({ v: 1, type: 'ping', id: 'p3' })
  const stillAlive = await session.next()
  check('the socket survives a protocol error', stillAlive?.type === 'ok' && stillAlive.id === 'p3', JSON.stringify(stillAlive))

  // ── bridge methods against the live DSH instance ──────────────────────────
  console.log('\nbridge: host and sessions')
  session.send({ v: 1, type: 'host.info', id: 'm1' })
  const hostInfo = await session.next()
  check('host.info answers ok', hostInfo?.type === 'ok' && hostInfo.id === 'm1', JSON.stringify(hostInfo))
  check('host.info carries the host id', typeof hostInfo?.result?.hostId === 'string' && hostInfo.result.hostId !== '')
  check('host.info carries the protocol version', hostInfo?.result?.protocolVersion === 1)
  record('host-info', hostInfo)

  session.send({ v: 1, type: 'session.list', id: 'm2' })
  const listed = await session.next()
  check('session.list answers ok', listed?.type === 'ok' && listed.id === 'm2', JSON.stringify(listed).slice(0, 300))
  const rows = listed?.result?.items
  check('session.list returns an array', Array.isArray(rows), typeof rows)
  record('session-list', listed)
  check('session.list finds the sessions in this home', Array.isArray(rows) && rows.length > 0, `got ${rows?.length}`)
  if (Array.isArray(rows) && rows.length > 0) {
    const row = rows[0]
    check('a row carries a sessionId', typeof row.sessionId === 'string' && row.sessionId !== '')
    check('a row carries an updatedAt number', typeof row.updatedAt === 'number')
    check('a row carries boolean flags', typeof row.running === 'boolean' && typeof row.blank === 'boolean')
    check(
      'rows are ordered by activity, newest first',
      rows.every((r, i) => i === 0 || rows[i - 1].updatedAt >= r.updatedAt),
    )

    // The whole Phase 2a chain in one call: gateway -> session projections ->
    // usage bridge -> wire.
    session.send({ v: 1, type: 'session.stats', id: 'm3', payload: { sessionId: row.sessionId } })
    const stats = await session.next()
    check('session.stats answers ok', stats?.type === 'ok' && stats.id === 'm3', JSON.stringify(stats).slice(0, 300))
    check('session.stats echoes the session id', stats?.result?.sessionId === row.sessionId)
    check('session.stats reports an asOfSeq', typeof stats?.result?.asOfSeq === 'number')
    record('session-stats', stats)
    const frame = stats?.result?.stats
    check('the stats frame is present', frame !== null && typeof frame === 'object')
    check('tokenUsage came through', frame?.tokenUsage !== null && typeof frame?.tokenUsage === 'object', JSON.stringify(frame?.tokenUsage))
    check(
      'tokenUsage carries all four counters',
      typeof frame?.tokenUsage?.uncachedInputTokens === 'number' &&
        typeof frame?.tokenUsage?.outputTokens === 'number' &&
        typeof frame?.tokenUsage?.cacheReadTokens === 'number' &&
        typeof frame?.tokenUsage?.cacheWriteTokens === 'number',
      JSON.stringify(frame?.tokenUsage),
    )
    check(
      'billedInputTokens is the sum of the three input counters',
      frame?.tokenUsage?.billedInputTokens ===
        frame.tokenUsage.uncachedInputTokens + frame.tokenUsage.cacheReadTokens + frame.tokenUsage.cacheWriteTokens,
    )
    check(
      'an absent projection reports null rather than zero',
      frame?.context === null || typeof frame?.context === 'object',
      JSON.stringify(frame?.context),
    )
    // A blank, never-prompted session has no context sample yet, so `context`
    // is legitimately null here. What must hold either way is that a present
    // context carries a breakdown that is an object or explicitly null.
    check(
      'a present context carries an object-or-null breakdown',
      frame?.context === null || frame?.context?.breakdown === null || typeof frame?.context?.breakdown === 'object',
      JSON.stringify(frame?.context),
    )
    // sessionStats is likewise null for a session with no closed steps.
    check(
      'sessionStats is an object or null, never a zeroed stand-in',
      frame?.stats === null || typeof frame?.stats === 'object',
      JSON.stringify(frame?.stats),
    )
    check('cacheHit is derived host-side', frame?.cacheHit !== null && 'ratio' in (frame?.cacheHit ?? {}))
  }

  session.send({ v: 1, type: 'session.stats', id: 'm4', payload: {} })
  const missingArg = await session.next()
  check(
    'session.stats without a sessionId is a malformed frame',
    missingArg?.code === 'MALFORMED_FRAME' && missingArg.id === 'm4',
    JSON.stringify(missingArg),
  )

  session.send({ v: 1, type: 'session.stats', id: 'm5', payload: { sessionId: 'no-such-session' } })
  const unknown = await session.next()
  check(
    'session.stats on an unknown session answers ok with null stats',
    unknown?.type === 'ok' && unknown.id === 'm5' && unknown.result?.stats === null,
    JSON.stringify(unknown).slice(0, 200),
  )

  session.send({ v: 1, type: 'ping', id: 'p9' })
  const aliveAfterBridge = await session.next()
  check('the socket survives the bridge calls', aliveAfterBridge?.type === 'ok' && aliveAfterBridge.id === 'p9')

  // ── catalogs ──────────────────────────────────────────────────────────────
  console.log('\nbridge: catalogs')
  session.send({ v: 1, type: 'model.catalog', id: 'c1' })
  const models = await session.next()
  check('model.catalog answers ok', models?.type === 'ok' && models.id === 'c1', JSON.stringify(models).slice(0, 200))
  check('the catalog lists providers', Array.isArray(models?.result?.providers), typeof models?.result?.providers)
  record('model-catalog', models)
  const firstModel = models?.result?.providers?.[0]?.models?.[0]
  check('a provider group carries models', firstModel !== undefined, JSON.stringify(models?.result?.providers?.[0]))
  check('a model carries a reasoning effort list', Array.isArray(firstModel?.efforts), JSON.stringify(firstModel))

  session.send({ v: 1, type: 'permissions.catalog', id: 'c2' })
  const permissions = await session.next()
  check('permissions.catalog answers ok', permissions?.type === 'ok' && permissions.id === 'c2', JSON.stringify(permissions).slice(0, 200))
  const presetValues = (permissions?.result?.options ?? []).map((option) => option.value)
  check('the permission catalog lists presets', presetValues.length > 0, JSON.stringify(presetValues))
  record('permissions-catalog', permissions)
  check('every preset option carries a name', (permissions?.result?.options ?? []).every((o) => typeof o.name === 'string' && o.name !== ''))
  // `custom` is derived-only and must never be offered as a target; `auto` is
  // live-only, so it may legitimately be present or absent.
  check('custom is never offered as a selectable preset', !presetValues.includes('custom'), JSON.stringify(presetValues))

  // ── session write path ────────────────────────────────────────────────────
  console.log('\nbridge: session write path')
  session.send({ v: 1, type: 'session.create', id: 'w1', payload: { cwd: process.env.MIZAR_WORKSPACE ?? process.cwd() } })
  const created = await session.next()
  check('session.create answers ok', created?.type === 'ok' && created.id === 'w1', JSON.stringify(created).slice(0, 200))
  const newSessionId = created?.result?.sessionId
  check('session.create returns a session id', typeof newSessionId === 'string' && newSessionId !== '', String(newSessionId))

  if (typeof newSessionId === 'string') {
    session.send({ v: 1, type: 'session.rename', id: 'w2', payload: { sessionId: newSessionId, title: 'Mizar smoke session' } })
    const renamed = await session.next()
    check('session.rename answers ok', renamed?.type === 'ok' && renamed.id === 'w2', JSON.stringify(renamed).slice(0, 200))

    session.send({ v: 1, type: 'session.permission.set', id: 'w3', payload: { sessionId: newSessionId, preset: presetValues[0] } })
    const switched = await session.next()
    check(
      'session.permission.set answers ok for a catalogued preset',
      switched?.type === 'ok' && switched.id === 'w3' && switched.result?.commandResult?.kind === 'success',
      JSON.stringify(switched).slice(0, 200),
    )

    session.send({ v: 1, type: 'session.permission.set', id: 'w4', payload: { sessionId: newSessionId, preset: 'not-a-preset' } })
    const refused = await session.next()
    check(
      'a preset the command refuses surfaces as an error, not a silent success',
      refused?.type === 'error' && refused.id === 'w4',
      JSON.stringify(refused).slice(0, 200),
    )
    record('error-frame', refused)

    if (firstModel !== undefined) {
      session.send({
        v: 1,
        type: 'session.model.set',
        id: 'w5',
        payload: {
          sessionId: newSessionId,
          provider: models.result.providers[0].id,
          model: firstModel.id,
          ...(firstModel.efforts?.length > 0 ? { reasoningEffort: firstModel.efforts[0].id } : {}),
        },
      })
      const selected = await session.next()
      check('session.model.set answers ok', selected?.type === 'ok' && selected.id === 'w5', JSON.stringify(selected).slice(0, 250))
      check(
        'the confirmed selection echoes the requested route',
        selected?.result?.selected?.model === firstModel.id,
        JSON.stringify(selected?.result),
      )
    }

    // Prompt admission is deliberately not gated on credential availability, so
    // this succeeds on a host with no API key; the agent run fails afterwards.
    const requestId = 'smoke-prompt-1'
    session.send({ v: 1, type: 'session.prompt', id: 'w6', payload: { sessionId: newSessionId, text: 'smoke test', requestId } })
    const prompted = await session.next()
    check('session.prompt answers ok', prompted?.type === 'ok' && prompted.id === 'w6', JSON.stringify(prompted).slice(0, 250))
    check('the host echoes the idempotency key', prompted?.result?.requestId === requestId, JSON.stringify(prompted?.result))

    // The same key again must be accepted without inserting a second message.
    session.send({ v: 1, type: 'session.prompt', id: 'w7', payload: { sessionId: newSessionId, text: 'smoke test', requestId } })
    const retried = await session.next()
    check(
      'a retried prompt with the same requestId is accepted, not duplicated',
      retried?.type === 'ok' && retried.result?.requestId === requestId,
      JSON.stringify(retried).slice(0, 250),
    )

    // The idempotency key being echoed is not the same claim as the message
    // existing once. Read the session's own log back and count: a retry that is
    // "accepted" but inserted twice would pass every check above.
    //
    // Read with a bounded retry, because the projection the page is cut at is
    // not updated synchronously with the prompt being accepted. That lag is real
    // and the app has to cope with it: a message the operator just sent is not
    // in the log the instant the host says it took it.
    let log
    let recorded = []
    for (let attempt = 0; attempt < 12; attempt += 1) {
      session.send({ v: 1, type: 'session.messages', id: 'w9', payload: { sessionId: newSessionId, maxMessages: 20 } })
      log = await session.next()
      recorded = (log?.result?.records ?? [])
        .filter((record) => record.type === 'event' && record.event?.type === 'user/message')
        .flatMap((record) => (record.event.data?.content ?? []).filter((part) => part.type === 'text'))
        .map((part) => part.text)
      if (recorded.includes('smoke test')) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    check('session.messages answers ok', log?.type === 'ok' && log.id === 'w9', JSON.stringify(log).slice(0, 250))
    check('session.messages reports the log cut', typeof log?.result?.asOfSeq === 'number', JSON.stringify(log?.result?.asOfSeq))
    // The one frame the app decodes whose shape was never captured: the order of
    // `records`, the meaning of `hasMore`, and which records survive the summary
    // were agreed between the two languages by reading each other's source.
    record('session-messages', log)
    check(
      'the prompt is recorded exactly once despite the retry',
      recorded.filter((text) => text === 'smoke test').length === 1,
      `found ${recorded.filter((text) => text === 'smoke test').length} of ${recorded.length} user messages`,
    )

    session.send({ v: 1, type: 'session.cancel', id: 'w8', payload: { sessionId: newSessionId } })
    const cancelled = await session.next()
    check('session.cancel answers ok', cancelled?.type === 'ok' && cancelled.id === 'w8', JSON.stringify(cancelled).slice(0, 200))

    session.send({ v: 1, type: 'session.stats', id: 'w9', payload: { sessionId: newSessionId } })
    const afterWrite = await session.next()
    check('the new session reads back', afterWrite?.type === 'ok' && afterWrite.result?.sessionId === newSessionId)
  }

  // ── argument validation ───────────────────────────────────────────────────
  console.log('\nbridge: validation')
  session.send({ v: 1, type: 'session.prompt', id: 'v1', payload: { sessionId: 's1' } })
  const noText = await session.next()
  check('session.prompt without text is a malformed frame', noText?.code === 'MALFORMED_FRAME' && noText.id === 'v1', JSON.stringify(noText))

  session.send({ v: 1, type: 'session.prompt', id: 'v2', payload: { sessionId: 's1', text: 'hi', mode: 'sideways' } })
  const badMode = await session.next()
  check('an unknown delivery mode is refused', badMode?.code === 'MALFORMED_FRAME' && badMode.id === 'v2', JSON.stringify(badMode))

  session.send({ v: 1, type: 'session.permission.set', id: 'v3', payload: { sessionId: 's1' } })
  const noPreset = await session.next()
  check('session.permission.set without a preset is a malformed frame', noPreset?.code === 'MALFORMED_FRAME')

  session.send({ v: 1, type: 'session.create', id: 'v4', payload: 'not an object' })
  const badCreate = await session.next()
  check('a non-object payload is refused', badCreate?.code === 'MALFORMED_FRAME', JSON.stringify(badCreate))

  session.send({ v: 1, type: 'ping', id: 'p10' })
  const finalAlive = await session.next()
  check('the socket still works after all of that', finalAlive?.type === 'ok' && finalAlive.id === 'p10')

  // ── interactions ──────────────────────────────────────────────────────────
  //
  // A real approval needs a model turn to reach a tool that asks for one, which
  // needs provider credentials this dev home does not have. What is verifiable
  // here is the surface: the pending view, and that every rejection path refuses
  // rather than silently accepting. The waterfall semantics themselves are unit
  // tested in test/interactions.test.ts.
  console.log('\nbridge: interactions')
  session.send({ v: 1, type: 'interactions.pending', id: 'i1' })
  const pendingNow = await session.next()
  check('interactions.pending answers ok', pendingNow?.type === 'ok' && pendingNow.id === 'i1', JSON.stringify(pendingNow).slice(0, 200))
  check('the pending view carries both lists', Array.isArray(pendingNow?.result?.approvals) && Array.isArray(pendingNow?.result?.questions), JSON.stringify(pendingNow?.result))
  record('interactions-pending', pendingNow)

  session.send({ v: 1, type: 'approval.answer', id: 'i2', payload: { requestId: 'no-such-request', outcome: 'allowed-once' } })
  const staleApproval = await session.next()
  check(
    'answering an unknown approval reports accepted:false rather than an error',
    staleApproval?.type === 'ok' && staleApproval.result?.accepted === false,
    JSON.stringify(staleApproval).slice(0, 200),
  )

  session.send({ v: 1, type: 'approval.answer', id: 'i3', payload: { requestId: 'x', outcome: 'always-allow' } })
  const badOutcome = await session.next()
  check(
    'an outcome outside the vocabulary is refused',
    badOutcome?.code === 'MALFORMED_FRAME' && badOutcome.id === 'i3',
    JSON.stringify(badOutcome).slice(0, 200),
  )

  session.send({ v: 1, type: 'approval.answer', id: 'i4', payload: { outcome: 'rejected' } })
  const noRequestId = await session.next()
  check('approval.answer without a requestId is a malformed frame', noRequestId?.code === 'MALFORMED_FRAME')

  session.send({ v: 1, type: 'question.answer', id: 'i5', payload: { callId: 'c1', answers: [] } })
  const emptyBatch = await session.next()
  check('an empty answer batch is refused', emptyBatch?.code === 'MALFORMED_FRAME', JSON.stringify(emptyBatch))

  session.send({ v: 1, type: 'question.answer', id: 'i6', payload: { callId: 'c1', answers: [{ id: 'q1' }] } })
  const noSelected = await session.next()
  check('an answer without "selected" is refused', noSelected?.code === 'MALFORMED_FRAME', JSON.stringify(noSelected))

  session.send({
    v: 1,
    type: 'question.answer',
    id: 'i7',
    payload: { callId: 'no-such-call', answers: [{ id: 'q1', selected: ['a'] }] },
  })
  const staleQuestion = await session.next()
  check(
    'answering an unknown question reports accepted:false',
    staleQuestion?.type === 'ok' && staleQuestion.result?.accepted === false,
    JSON.stringify(staleQuestion).slice(0, 200),
  )

  session.send({ v: 1, type: 'ping', id: 'p11' })
  const afterInteractions = await session.next()
  check('the socket survives the interaction surface', afterInteractions?.type === 'ok' && afterInteractions.id === 'p11')

  session.close()
  await settle(100)

  // ── web panel data path ───────────────────────────────────────────────────
  //
  // The panel lives on DSH's own webserver, behind its browser cookie, not on
  // the Mizar listener. Exercising it also exercises the whole `/api` auth
  // handshake: launch token -> root exchange -> signed cookie -> authenticated
  // request. Runs last because issuing a code here invalidates the one the
  // device-pairing section consumed.
  await panelSection({ deviceId, deviceToken: token })

  await flushFixtures()

  console.log(`\nmizar smoke: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

/** Drive the Web panel's routes through the real browser authentication flow.
 *
 * @param context - the device this run paired (id and token), so the revocation
 *   checks are about that device rather than about whichever one shares its
 *   name. Note that the launch `token` this function reads from the environment
 *   is the browser's, not the device's.
 */
async function panelSection(context) {
  const webBase = process.env['MIZAR_WEB_BASE'] ?? ''
  const token = process.env['MIZAR_WEB_TOKEN'] ?? ''
  if (webBase === '' || token === '') {
    console.log('\nweb panel: SKIPPED (set MIZAR_WEB_BASE and MIZAR_WEB_TOKEN)')
    return
  }

  console.log('\nweb panel: browser authentication')
  const root = await fetch(`${webBase}/`, { redirect: 'manual' })
  check('an unauthenticated API request is refused', (await fetch(`${webBase}/api/mizar.status`)).status === 401, 'expected 401')

  // The token is only accepted on the root path, and it answers with a
  // redirect plus the signed cookie.
  const exchange = await fetch(`${webBase}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' })
  check('the launch token is redeemed at the root', exchange.status === 303, `got ${exchange.status}`)
  const cookie = exchange.headers.get('set-cookie')
  check('the exchange sets a session cookie', typeof cookie === 'string' && cookie.includes('dsh-auth-'), String(cookie))
  check('the cookie is HttpOnly and SameSite=Strict', /HttpOnly/i.test(cookie ?? '') && /SameSite=Strict/i.test(cookie ?? ''), String(cookie))

  const auth = { headers: { cookie: (cookie ?? '').split(';')[0], accept: 'application/json' } }

  const status = await fetch(`${webBase}/api/mizar.status`, auth)
  check('the panel status answers 200 with the cookie', status.status === 200, `got ${status.status}`)
  const view = await status.json().catch(() => null)
  check('the status carries the host identity', typeof view?.hostId === 'string' && view.hostId !== '')
  check('the status carries the bound authorities', Array.isArray(view?.authorities) && view.authorities.length > 0, JSON.stringify(view?.authorities))
  check('the status carries the bind decision', typeof view?.bind?.mode === 'string' && typeof view?.bind?.reason === 'string')
  check(
    'the status lists the device this run paired, and calls it live',
    (view?.devices ?? []).some((d) => d.deviceId === context.deviceId && d.revoked === false),
    JSON.stringify(view?.devices?.filter((d) => d.deviceId === context.deviceId)),
  )
  check('the status never leaks a token hash', !JSON.stringify(view ?? {}).includes('tokenHash'))

  console.log('\nweb panel: pairing from the panel')
  const issued = await fetch(`${webBase}/api/mizar.pairing`, { ...auth, method: 'POST' })
  check('the panel can issue a code', issued.status === 200, `got ${issued.status}`)
  const withCode = await issued.json().catch(() => null)
  check('the panel now shows a pairing code', typeof withCode?.pairing?.display === 'string' && withCode.pairing.display.length > 0, JSON.stringify(withCode?.pairing))
  check('the panel shows how long the code lives', typeof withCode?.pairing?.expiresAt === 'number')

  const uri = withCode?.pairing?.uri ?? ''
  const parsed = new URLSearchParams(uri.slice(uri.indexOf('?') + 1))
  check('the QR payload uses the mizar scheme', uri.startsWith('mizar://pair?'), uri)
  // A QR must carry *an* address, but not necessarily a direct one. With a relay
  // the listener binds loopback, and a loopback authority is deliberately left
  // out -- a phone cannot reach 127.0.0.1 on the Mac, and offering it would make
  // every scan spend its direct-connection timeout before trying the relay.
  const authority = parsed.get('h')
  const relayBase = parsed.get('u')
  const direct = withCode?.authorities?.[0]
  const expectedDirect = direct !== undefined && !direct.startsWith('127.0.0.1') ? direct : null
  check(
    'the QR payload carries an address a phone can use',
    (authority !== null && authority === expectedDirect) || relayBase !== null,
    `h=${authority} u=${relayBase} authorities=${JSON.stringify(withCode?.authorities)}`,
  )
  check(
    'the QR payload does not offer a loopback authority',
    authority === null || !authority.startsWith('127.0.0.1'),
    `h=${authority}`,
  )
  check('the QR payload carries the same code the panel shows', parsed.get('c') === withCode?.pairing?.display, `${parsed.get('c')} vs ${withCode?.pairing?.display}`)

  const rejectedType = await fetch(`${webBase}/api/mizar.revoke`, {
    ...auth,
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 42 }),
  })
  check('a malformed revoke body is refused', rejectedType.status === 400, `got ${rejectedType.status}`)

  const unknownDevice = await fetch(`${webBase}/api/mizar.revoke`, {
    ...auth,
    method: 'POST',
    headers: { ...auth.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'no-such-device' }),
  })
  check('revoking an unknown device reports 404', unknownDevice.status === 404, `got ${unknownDevice.status}`)

  // Revoke the device this run paired -- by id, because the dev home has one
  // "Smoke Test iPhone" per run -- then confirm the roster reflects it.
  const target = (withCode?.devices ?? []).find((d) => d.deviceId === context.deviceId)
  check('the panel lists the device this run paired', target !== undefined, String(context.deviceId))
  if (target !== undefined) {
    const revoked = await fetch(`${webBase}/api/mizar.revoke`, {
      ...auth,
      method: 'POST',
      headers: { ...auth.headers, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: target.deviceId }),
    })
    check('the panel can revoke a device', revoked.status === 200, `got ${revoked.status}`)
    const after = await revoked.json().catch(() => null)
    const row = (after?.devices ?? []).find((d) => d.deviceId === target.deviceId)
    check('the revoked device is marked revoked', row?.revoked === true, JSON.stringify(row))

    // The token still exists on the phone, so the answer it gets on its next
    // connect is the one that tells it to forget that token and pair again.
    // This is the last check in the run: it is the smoke's own device.
    const dead = await connect()
    dead.send({ v: 1, type: 'hello', id: 'h9', token: context.deviceToken })
    const deadReply = await dead.next()
    check(
      'a revoked device is told DEVICE_REVOKED, not "unknown token"',
      deadReply?.code === 'DEVICE_REVOKED',
      JSON.stringify(deadReply),
    )
    check('the revoked socket is closed', (await dead.closed).code === 4401)
  }
}

/** Small pause helper. */

main().catch((error) => {
  console.error('mizar smoke: crashed —', error)
  process.exit(2)
})
