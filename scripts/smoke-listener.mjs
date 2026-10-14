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

  session.send({ v: 1, type: 'session.list', id: 's1' })
  const notImplemented = await session.next()
  check(
    'an unimplemented method answers NOT_IMPLEMENTED with its id',
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

  session.close()
  await settle(100)

  console.log(`\nmizar smoke: ${passed} passed, ${failed} failed`)
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('mizar smoke: crashed —', error)
  process.exit(2)
})
