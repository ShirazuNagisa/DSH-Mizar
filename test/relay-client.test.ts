import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { WebSocketServer } from 'ws'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  RelayClient,
  phoneBaseURL,
  saneCloseCode,
  tunnelURL,
  type RelaySocket,
  type RelayClientState,
} from '../src/relay/client.js'
import { parseRelayFrame } from '../src/relay/protocol.js'

/**
 * The golden frames both sides decode.
 *
 * Not under `protocol/fixtures/`: that directory is the set of Mizar protocol
 * frames, discovered by a test that asserts its contents are exactly the frames
 * the app decodes. This is a different protocol with a different shape, and
 * putting it there would mean either failing that assertion or weakening it.
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL('../protocol/relay/fixture.json', import.meta.url), 'utf8'),
) as { relayToHost: unknown[]; hostToRelay: unknown[] }

/** A relay socket a test drives by hand. */
class ScriptedSocket implements RelaySocket {
  readonly sent: string[] = []
  #handlers: Record<string, ((...args: never[]) => void)[]> = {}

  send(text: string): void {
    this.sent.push(text)
  }

  close(): void {
    /* nothing to release */
  }

  on(event: 'message', listener: (data: Buffer, isBinary: boolean) => void): unknown
  on(event: 'close', listener: (code: number, reason: Buffer) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
  on(event: 'open', listener: () => void): unknown
  on(event: string, listener: (...args: never[]) => void): unknown {
    this.#handlers[event] = [...(this.#handlers[event] ?? []), listener]
    return this
  }

  /** Deliver a frame from the relay. */
  deliver(frame: unknown): void {
    for (const handler of this.#handlers['message'] ?? []) {
      ;(handler as unknown as (data: Buffer) => void)(Buffer.from(JSON.stringify(frame)))
    }
  }

  /** Simulate the socket opening. */
  opened(): void {
    for (const handler of this.#handlers['open'] ?? []) handler()
  }

  /** Simulate the socket closing. */
  closed(): void {
    for (const handler of this.#handlers['close'] ?? []) {
      ;(handler as unknown as (code: number, reason: Buffer) => void)(1006, Buffer.from(''))
    }
  }

  /** The frames written, parsed. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>)
  }

  /** The last frame written. */
  last(): Record<string, unknown> {
    const frame = this.frames().at(-1)
    if (frame === undefined) throw new Error('nothing was sent')
    return frame
  }
}

/** A real listener for the client to replay onto. */
interface FakeListener {
  readonly port: number
  readonly requests: Array<{ method: string; url: string; body: string }>
  readonly sockets: WebSocket[];
  close(): Promise<void>
}

/** Start a stand-in for the plugin's own listener, with a WebSocket endpoint. */
async function startListener(): Promise<FakeListener> {
  const requests: FakeListener['requests'] = []
  const sockets: WebSocket[] = []
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      requests.push({
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        body: Buffer.concat(chunks).toString('utf8'),
      })
      const payload = JSON.stringify({ url: request.url, seen: true })
      response.writeHead(200, { 'content-type': 'application/json', 'x-mizar-test': 'yes' })
      response.end(payload)
    })
  })
  const wss = new WebSocketServer({ noServer: true })
  server.on('upgrade', (request, socket, head) => {
    // Only the Mizar path upgrades. The real listener answers anything else by
    // refusing the socket, and a stand-in that accepted every path would hide
    // the client's failure to notice a refusal.
    if (request.url !== '/mizar/v1/ws') {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      sockets.push(ws as unknown as WebSocket)
      ws.on('message', (data: Buffer) => ws.send(`echo:${data.toString('utf8')}`))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    port,
    requests,
    sockets,
    close: async () => {
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

describe('tunnelURL', () => {
  it('converts an https base URL to a wss tunnel URL', () => {
    expect(tunnelURL('https://relay.example.com')).toBe('wss://relay.example.com/tunnel')
  })

  it('accepts an explicit wss URL', () => {
    expect(tunnelURL('wss://relay.example.com')).toBe('wss://relay.example.com/tunnel')
  })

  it('keeps a path prefix', () => {
    expect(tunnelURL('https://relay.example.com/mizar')).toBe(
      'wss://relay.example.com/mizar/tunnel',
    )
  })

  it('drops a trailing slash rather than doubling it', () => {
    expect(tunnelURL('https://relay.example.com/')).toBe('wss://relay.example.com/tunnel')
  })

  it('allows plain ws for a relay on loopback', () => {
    expect(tunnelURL('http://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787/tunnel')
  })

  it('drops any query string', () => {
    expect(tunnelURL('https://relay.example.com/?token=nope')).toBe(
      'wss://relay.example.com/tunnel',
    )
  })

  it('refuses a scheme it cannot speak', () => {
    expect(tunnelURL('ftp://relay.example.com')).toBeNull()
    expect(tunnelURL('not a url')).toBeNull()
    expect(tunnelURL('')).toBeNull()
  })
})

describe('phoneBaseURL', () => {
  it('turns a wss relay URL into an https base a phone can use', () => {
    expect(phoneBaseURL('wss://relay.example.com', '', 'ROOM1')).toBe(
      'https://relay.example.com/r/ROOM1',
    )
  })

  it('prefers the public override', () => {
    expect(phoneBaseURL('http://127.0.0.1:8787', 'https://relay.example.com', 'ROOM1')).toBe(
      'https://relay.example.com/r/ROOM1',
    )
  })

  it('omits the room when it is not known yet', () => {
    expect(phoneBaseURL('https://relay.example.com', '')).toBe('https://relay.example.com')
    expect(phoneBaseURL('https://relay.example.com', '', null)).toBe('https://relay.example.com')
  })

  it('refuses a URL it cannot parse', () => {
    expect(phoneBaseURL('nonsense', '')).toBeNull()
  })
})

describe('the tunnel protocol fixture', () => {
  it('decodes every relay frame', () => {
    for (const frame of FIXTURE.relayToHost) {
      expect(parseRelayFrame(JSON.stringify(frame))).toEqual(frame)
    }
  })

  it('covers every frame type the relay may send', () => {
    const types = new Set(FIXTURE.relayToHost.map((frame) => (frame as { t: string }).t))
    expect([...types].sort()).toEqual(['ping', 'req', 'welcome', 'ws-close', 'ws-msg', 'ws-open'])
  })
})

describe('RelayClient', () => {
  let listener: FakeListener
  let socket: ScriptedSocket
  let states: RelayClientState[]
  let client: RelayClient

  beforeEach(async () => {
    listener = await startListener()
    socket = new ScriptedSocket()
    states = []
    client = new RelayClient({
      url: 'https://relay.example.com',
      token: 'a-token',
      localPort: listener.port,
      log: () => undefined,
      socketFactory: () => socket,
      onState: (state) => states.push(state),
      reconnectBaseMs: 10,
      reconnectMaxMs: 20,
    })
    client.start()
  })

  afterEach(async () => {
    client.stop()
    await listener.close()
  })

  it('records the room from the welcome', () => {
    socket.deliver({ t: 'welcome', room: 'ROOM1', protocolVersion: 1 })
    expect(client.room).toBe('ROOM1')
    expect(client.state.connected).toBe(true)
    expect(client.state.lastError).toBeNull()
  })

  it('answers a ping so the relay knows the computer is alive', () => {
    socket.deliver({ t: 'ping', id: 'p1' })
    expect(socket.last()).toEqual({ t: 'pong', id: 'p1' })
  })

  it('replays a request onto the local listener and returns its answer', async () => {
    socket.deliver({
      t: 'req',
      id: 'r1',
      method: 'GET',
      path: '/mizar/v1/hello',
      headers: { 'x-mizar-probe': 'kept' },
      body: null,
    })
    await vi.waitFor(() => expect(socket.frames().some((f) => f['t'] === 'res')).toBe(true))

    const reply = socket.last()
    expect(reply['id']).toBe('r1')
    expect(reply['status']).toBe(200)
    const body = Buffer.from(String(reply['body']), 'base64').toString('utf8')
    expect(JSON.parse(body)).toMatchObject({ url: '/mizar/v1/hello' })
    expect(listener.requests[0]).toMatchObject({ method: 'GET', url: '/mizar/v1/hello' })
  })

  it('carries a request body to the listener unchanged', async () => {
    socket.deliver({
      t: 'req',
      id: 'r1',
      method: 'POST',
      path: '/mizar/v1/pair',
      headers: { 'content-type': 'application/json' },
      body: Buffer.from('{"code":"AB2C-D3EF"}').toString('base64'),
    })
    await vi.waitFor(() => expect(listener.requests.length).toBe(1))
    expect(listener.requests[0]?.body).toBe('{"code":"AB2C-D3EF"}')
  })

  it('returns the listener headers, minus the hop-by-hop ones', async () => {
    socket.deliver({
      t: 'req',
      id: 'r1',
      method: 'GET',
      path: '/mizar/v1/hello',
      headers: {},
      body: null,
    })
    await vi.waitFor(() => expect(socket.frames().some((f) => f['t'] === 'res')).toBe(true))
    const headers = socket.last()['headers'] as Record<string, string>
    expect(headers['x-mizar-test']).toBe('yes')
    expect(headers['connection']).toBeUndefined()
  })

  it('answers with an error rather than silence when the listener is gone', async () => {
    await listener.close()
    listener = await startListener() // replaced so afterEach still has something to close
    socket.deliver({
      t: 'req',
      id: 'r9',
      method: 'GET',
      path: '/mizar/v1/hello',
      headers: {},
      body: null,
    })
    await vi.waitFor(() => expect(socket.frames().some((f) => f['t'] === 'error')).toBe(true))
    expect(socket.last()['id']).toBe('r9')
  })

  it('bridges a phone WebSocket onto the local listener', async () => {
    socket.deliver({ t: 'ws-open', id: 'r3', path: '/mizar/v1/ws', headers: {} })
    await vi.waitFor(() => expect(socket.frames().some((f) => f['t'] === 'ws-open-ok')).toBe(true))

    socket.deliver({
      t: 'ws-msg',
      id: 'r3',
      data: Buffer.from('hello').toString('base64'),
      binary: false,
    })
    await vi.waitFor(() => expect(socket.frames().some((f) => f['t'] === 'ws-msg')).toBe(true))
    const echoed = Buffer.from(String(socket.last()['data']), 'base64').toString('utf8')
    expect(echoed).toBe('echo:hello')
  })

  it('reports an error for a stream the local listener refused', async () => {
    socket.deliver({ t: 'ws-open', id: 'r4', path: '/nope/nothing', headers: {} })
    await vi.waitFor(() => expect(socket.frames().some((f) => f['t'] === 'error')).toBe(true))
    expect(socket.last()['id']).toBe('r4')
  })

  it('ignores a frame it does not understand instead of throwing', () => {
    expect(() => socket.deliver({ t: 'from-the-future', id: 'x' })).not.toThrow()
    expect(() => socket.deliver({ nonsense: true })).not.toThrow()
  })

  it('marks itself disconnected when the socket closes', () => {
    socket.deliver({ t: 'welcome', room: 'ROOM1', protocolVersion: 1 })
    socket.closed()
    expect(client.state.connected).toBe(false)
    expect(client.state.lastError).not.toBeNull()
    // The room is kept: the app's stored pairing should not change because the
    // computer's network blipped, and the relay gives the same room back.
    expect(client.state.room).toBe('ROOM1')
  })

  it('stops reconnecting once stopped', async () => {
    socket.closed()
    client.stop()
    const before = states.length
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(states.length).toBe(before)
  })

  it('reconnects after a close', async () => {
    const created: ScriptedSocket[] = []
    const factory = (): RelaySocket => {
      const next = new ScriptedSocket()
      created.push(next)
      return next
    }
    const reconnecting = new RelayClient({
      url: 'https://relay.example.com',
      token: 'a-token',
      localPort: listener.port,
      log: () => undefined,
      socketFactory: factory,
      reconnectBaseMs: 5,
      reconnectMaxMs: 10,
    })
    reconnecting.start()
    expect(created).toHaveLength(1)
    created[0]?.closed()
    await vi.waitFor(() => expect(created.length).toBeGreaterThan(1))
    reconnecting.stop()
  })
})

describe('saneCloseCode', () => {
  it('passes through the codes that may be sent', () => {
    for (const code of [1000, 1001, 1002, 1003, 1007, 1008, 1009, 1010, 1011, 3000, 4001, 4999]) {
      expect(saneCloseCode(code)).toBe(code)
    }
  })

  it('replaces the codes that describe the absence of a code', () => {
    // A close handler is given 1005 and 1006; a close frame must never carry
    // them. `ws` throws a TypeError, which crashed the whole plugin rather than
    // one stream -- seen in the first end-to-end run through a real relay.
    expect(saneCloseCode(1005)).toBe(1000)
    expect(saneCloseCode(1006)).toBe(1000)
    expect(saneCloseCode(1015)).toBe(1000)
  })

  it('replaces anything unknown', () => {
    expect(saneCloseCode(undefined)).toBe(1000)
    expect(saneCloseCode(1004)).toBe(1000)
    expect(saneCloseCode(2999)).toBe(1000)
    expect(saneCloseCode(5000)).toBe(1000)
  })
})

describe('a close code arriving from the relay', () => {
  it('does not crash the client when the phone closed abnormally', async () => {
    // The regression: a phone socket that dropped without a code reports 1006
    // to the relay, which forwards it, and replaying it into `close()` threw.
    const listener = await startListener()
    const socket = new ScriptedSocket()
    const client = new RelayClient({
      url: 'https://relay.example.com',
      token: 'a-token',
      localPort: listener.port,
      log: () => undefined,
      socketFactory: () => socket,
    })
    client.start()
    socket.deliver({ t: 'ws-open', id: 'r3', path: '/mizar/v1/ws', headers: {} })
    await vi.waitFor(() => expect(socket.frames().some((f) => f['t'] === 'ws-open-ok')).toBe(true))

    expect(() => socket.deliver({ t: 'ws-close', id: 'r3', code: 1006, reason: 'abnormal' }))
      .not.toThrow()
    client.stop()
    await listener.close()
  })
})

/**
 * The relay is a separate deployment with its own release cadence, so what it
 * sends is input from a peer rather than a value this process produced. A frame
 * whose fields are simply the wrong shape must be dropped, not acted on: these
 * arrive inside the socket's `message` handler, where nothing catches.
 */
describe('frames from the relay are not trusted', () => {
  /** A started client with one stream already open, and its scripted socket. */
  async function openStream(): Promise<{
    socket: ScriptedSocket
    client: RelayClient
    listener: FakeListener
    id: string
  }> {
    const listener = await startListener()
    const socket = new ScriptedSocket()
    const client = new RelayClient({
      url: 'https://relay.example.com',
      token: 'a-token',
      localPort: listener.port,
      log: () => undefined,
      socketFactory: () => socket,
    })
    client.start()
    socket.deliver({ t: 'ws-open', id: 'r1', path: '/mizar/v1/ws', headers: {} })
    await vi.waitFor(() => expect(socket.frames().some((f) => f['t'] === 'ws-open-ok')).toBe(true))
    return { socket, client, listener, id: 'r1' }
  }

  it('drops a stream message whose data is not base64 text', async () => {
    const { socket, client, listener, id } = await openStream()
    try {
      expect(() => socket.deliver({ t: 'ws-msg', id, data: 5, binary: false })).not.toThrow()
      // One unusable frame is not a reason to lose the stream: the phone socket
      // is still the operator's only way to answer an approval.
      socket.deliver({
        t: 'ws-msg',
        id,
        data: Buffer.from('after').toString('base64'),
        binary: false,
      })
      await vi.waitFor(() =>
        expect(
          listener.sockets[0] !== undefined && listener.sockets[0].readyState === 1,
        ).toBe(true),
      )
    } finally {
      client.stop()
      await listener.close()
    }
  })

  it('closes the local socket for a reason it would refuse to send', async () => {
    const { socket, client, listener, id } = await openStream()
    try {
      // 123 bytes is the most `ws` will put in a close frame. Handing it more
      // makes `WebSocket.close()` throw a RangeError out of this handler, and
      // the throw also means the local socket is never closed at all.
      expect(() =>
        socket.deliver({ t: 'ws-close', id, code: 1001, reason: 'x'.repeat(300) }),
      ).not.toThrow()
      await vi.waitFor(() => expect(listener.sockets[0]?.readyState).toBe(3))
    } finally {
      client.stop()
      await listener.close()
    }
  })

  it('answers a request whose body is not base64 text', async () => {
    const listener = await startListener()
    const socket = new ScriptedSocket()
    const client = new RelayClient({
      url: 'https://relay.example.com',
      token: 'a-token',
      localPort: listener.port,
      log: () => undefined,
      socketFactory: () => socket,
    })
    client.start()
    try {
      // `Buffer.from(5, 'base64')` throws before the request reaches the
      // listener, and the promise is discarded by `void` -- so the relay is left
      // holding a phone connection until its own timeout, and the throw becomes
      // an unhandled rejection in the DSH process.
      expect(() =>
        socket.deliver({ t: 'req', id: 'r9', method: 'POST', path: '/x', headers: {}, body: 5 }),
      ).not.toThrow()
      await vi.waitFor(() =>
        expect(socket.frames().some((f) => f['t'] === 'error' && f['id'] === 'r9')).toBe(true),
      )
    } finally {
      client.stop()
      await listener.close()
    }
  })

  it('answers a request whose body field is missing', async () => {
    const listener = await startListener()
    const socket = new ScriptedSocket()
    const client = new RelayClient({
      url: 'https://relay.example.com',
      token: 'a-token',
      localPort: listener.port,
      log: () => undefined,
      socketFactory: () => socket,
    })
    client.start()
    try {
      // The declared frame says `body: string | null`, and `parseRelayFrame`
      // checks the envelope and nothing else -- so `undefined` reaches the
      // decoder, where only `null` was handled.
      expect(() =>
        socket.deliver({ t: 'req', id: 'r7', method: 'GET', path: '/mizar/v1/hello', headers: {} }),
      ).not.toThrow()
      await vi.waitFor(() =>
        expect(socket.frames().some((f) => f['id'] === 'r7')).toBe(true),
      )
      expect(listener.requests.length).toBe(1)
    } finally {
      client.stop()
      await listener.close()
    }
  })

  it('cannot be pointed at a host other than the local listener', async () => {
    // The relay is a separate deployment and the phone chooses the path, so this
    // is the check that "the relay replays onto the computer" cannot become "the computer
    // fetches whatever the phone names": the origin is fixed at construction and
    // the path is only ever appended to it. A path that looks like a
    // protocol-relative URL is the obvious attempt.
    const listener = await startListener()
    const socket = new ScriptedSocket()
    const client = new RelayClient({
      url: 'https://relay.example.com',
      token: 'a-token',
      localPort: listener.port,
      log: () => undefined,
      socketFactory: () => socket,
    })
    client.start()
    try {
      socket.deliver({
        t: 'req',
        id: 'r5',
        method: 'GET',
        path: '//evil.example.com/steal',
        headers: { host: 'evil.example.com' },
        body: null,
      })
      await vi.waitFor(() => expect(listener.requests.length).toBe(1))
      // The listener saw it, on its own port, as a path.
      expect(listener.requests[0]?.url).toBe('//evil.example.com/steal')
    } finally {
      client.stop()
      await listener.close()
    }
  })
})
