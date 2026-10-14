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

/** Small pause helper. */
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

  // ── authenticated socket ──────────────────────────────────────────────────
  console.log('\nwebsocket: authenticated session')
  const session = await connect()
  session.send({ v: 1, type: 'hello', id: 'h1', token, appVersion: '0.0.1', protocolVersion: 1 })
  const welcome = await session.next()
  check('a valid token is accepted', welcome?.type === 'welcome', JSON.stringify(welcome))
  check('welcome carries the host name', typeof welcome?.hostName === 'string' && welcome.hostName !== '')
  check('welcome carries the device id', typeof welcome?.deviceId === 'string' && welcome.deviceId !== '')

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

  session.send({ v: 1, type: 'session.list', id: 'm2' })
  const listed = await session.next()
  check('session.list answers ok', listed?.type === 'ok' && listed.id === 'm2', JSON.stringify(listed).slice(0, 300))
  const rows = listed?.result?.items
  check('session.list returns an array', Array.isArray(rows), typeof rows)
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

  session.close()
  await settle(100)

  console.log(`\nmizar smoke: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('mizar smoke: crashed —', error)
  process.exit(2)
})
