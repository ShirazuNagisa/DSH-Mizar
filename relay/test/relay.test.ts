import { afterEach, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { startRelay, type Relay } from '../src/index.js'
import type { RelayConfig } from '../src/config.js'
import { deriveRoom } from '../src/room.js'

const TOKEN = 'test-tunnel-token'
const ROOM = deriveRoom(TOKEN)

/** The relay under test, torn down after each case. */
let relay: Relay | undefined

afterEach(async () => {
  await relay?.close()
  relay = undefined
})

const config = (overrides: Partial<RelayConfig> = {}): RelayConfig => ({
  port: 0,
  host: '127.0.0.1',
  tokens: [TOKEN],
  maxBodyBytes: 1024 * 1024,
  maxMessageBytes: 1024 * 1024,
  maxClientsPerRoom: 8,
  requestTimeoutMs: 2000,
  tunnelIdleMs: 60_000,
  probePort: 0, // disabled: binding a UDP port per test is noise
  ...overrides,
})

/**
 * A stand-in for the Mac: connects its tunnel and answers whatever it is asked
 * with a fixed reply, so the test is about the relay and not about the plugin.
 */
class FakeMac {
  readonly #socket: WebSocket
  readonly room: string
  readonly requests: Array<Record<string, unknown>> = []
  #handler: (frame: Record<string, unknown>) => void = () => undefined

  private constructor(socket: WebSocket, room: string) {
    this.#socket = socket
    this.room = room
    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString('utf8')) as Record<string, unknown>
      if (frame['t'] === 'welcome') return
      if (frame['t'] === 'ping') {
        socket.send(JSON.stringify({ t: 'pong', id: frame['id'] }))
        return
      }
      this.requests.push(frame)
      this.#handler(frame)
    })
  }

  static async connect(url: string, token: string = TOKEN): Promise<FakeMac> {
    const socket = new WebSocket(`${url}/tunnel`, {
      headers: { authorization: `Bearer ${token}` },
    })
    const welcome = await new Promise<Record<string, unknown>>((resolve, reject) => {
      socket.once('message', (data: Buffer) => resolve(JSON.parse(data.toString('utf8'))))
      socket.once('error', reject)
      socket.once('unexpected-response', (_request, response) =>
        reject(new Error(`upgrade refused with ${response.statusCode}`)),
      )
    })
    return new FakeMac(socket, String(welcome['room']))
  }

  /** Answer every request with a fixed status and body. */
  respondWith(status: number, body: string, headers: Record<string, string> = {}): void {
    this.#handler = (frame) => {
      this.#socket.send(
        JSON.stringify({
          t: 'res',
          id: frame['id'],
          status,
          headers: { 'content-type': 'application/json', ...headers },
          body: Buffer.from(body).toString('base64'),
        }),
      )
    }
  }

  /** Accept every stream and echo whatever arrives on it. */
  echoStreams(): void {
    this.#handler = (frame) => {
      if (frame['t'] === 'ws-open') {
        this.#socket.send(JSON.stringify({ t: 'ws-open-ok', id: frame['id'] }))
        return
      }
      if (frame['t'] === 'ws-msg') {
        const text = Buffer.from(String(frame['data']), 'base64').toString('utf8')
        this.#socket.send(
          JSON.stringify({
            t: 'ws-msg',
            id: frame['id'],
            data: Buffer.from(`echo:${text}`).toString('base64'),
            binary: false,
          }),
        )
      }
    }
  }

  /** Refuse every stream. */
  refuseStreams(): void {
    this.#handler = (frame) => {
      if (frame['t'] === 'ws-open') {
        this.#socket.send(JSON.stringify({ t: 'error', id: frame['id'], message: 'no path' }))
      }
    }
  }

  /** Answer nothing at all. */
  goSilent(): void {
    this.#handler = () => undefined
  }

  close(): void {
    this.#socket.close()
  }

  /** Drop the socket without a close handshake, as a dead Mac would. */
  kill(): void {
    this.#socket.terminate()
  }
}

describe('relay HTTP replay', () => {
  it('carries a request to the Mac and its answer back', async () => {
    relay = await startRelay(config(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.respondWith(200, '{"hostId":"abc"}')

    const response = await fetch(`http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/hello`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('{"hostId":"abc"}')
    expect(mac.requests[0]).toMatchObject({
      t: 'req',
      method: 'GET',
      path: '/mizar/v1/hello',
    })
  })

  it('carries a request body through unchanged', async () => {
    relay = await startRelay(config(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.respondWith(200, '{}')

    await fetch(`http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/pair`, {
      method: 'POST',
      body: '{"code":"ABCD-EFGH"}',
      headers: { 'content-type': 'application/json' },
    })

    const sent = mac.requests[0]
    expect(Buffer.from(String(sent?.['body']), 'base64').toString('utf8')).toBe('{"code":"ABCD-EFGH"}')
  })

  it('does not forward hop-by-hop headers', async () => {
    relay = await startRelay(config(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.respondWith(200, '{}')

    await fetch(`http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/hello`, {
      headers: { 'x-mizar-probe': 'kept' },
    })

    const headers = mac.requests[0]?.['headers'] as Record<string, string>
    expect(headers['x-mizar-probe']).toBe('kept')
    // `connection` and `transfer-encoding` describe this hop and would be wrong
    // to replay onto the plugin's listener.
    expect(headers['connection']).toBeUndefined()
    expect(headers['transfer-encoding']).toBeUndefined()
  })

  it('propagates the Mac response status, not a relay one', async () => {
    relay = await startRelay(config(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.respondWith(429, '{"error":"slow down"}')

    const response = await fetch(`http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/pair`)
    expect(response.status).toBe(429)
  })

  it('answers 404 for a room that does not exist', async () => {
    relay = await startRelay(config(), () => undefined)
    const response = await fetch(`http://127.0.0.1:${relay.port}/r/NOSUCHROOM/mizar/v1/hello`)
    expect(response.status).toBe(404)
  })

  it('answers the same 404 whether the room is unknown or merely offline', async () => {
    // Distinguishing them would let anyone enumerate which Macs are online.
    relay = await startRelay(config(), () => undefined)
    const offline = await fetch(`http://127.0.0.1:${relay.port}/r/${ROOM}/mizar/v1/hello`)
    const unknown = await fetch(`http://127.0.0.1:${relay.port}/r/AAAAAAAAAAAA/mizar/v1/hello`)
    expect(offline.status).toBe(unknown.status)
    expect(await offline.text()).toBe(await unknown.text())
  })

  it('reports 502 when the Mac goes silent past the timeout', async () => {
    relay = await startRelay(config({ requestTimeoutMs: 100 }), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.goSilent()

    const response = await fetch(`http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/hello`)
    expect(response.status).toBe(502)
  })

  it('fails an in-flight request the moment the Mac drops', async () => {
    relay = await startRelay(config({ requestTimeoutMs: 30_000 }), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.goSilent()

    const pending = fetch(`http://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/hello`)
    await new Promise((resolve) => setTimeout(resolve, 30))
    mac.kill()

    // Must not wait out the 30s timeout: the answer is already known.
    const response = await pending
    expect(response.status).toBe(502)
  })

  it('serves health', async () => {
    relay = await startRelay(config(), () => undefined)
    await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    const body = (await (await fetch(`http://127.0.0.1:${relay.port}/healthz`)).json()) as {
      ok: boolean
      rooms: number
    }
    expect(body.ok).toBe(true)
    expect(body.rooms).toBe(1)
  })
})

describe('relay tunnel admission', () => {
  it('refuses a tunnel with a bad token', async () => {
    relay = await startRelay(config(), () => undefined)
    await expect(
      FakeMac.connect(`ws://127.0.0.1:${relay.port}`, 'wrong-token'),
    ).rejects.toThrow(/401/)
  })

  it('refuses a tunnel with no token at all', async () => {
    relay = await startRelay(config(), () => undefined)
    await expect(FakeMac.connect(`ws://127.0.0.1:${relay.port}`, '')).rejects.toThrow(/401/)
  })

  it('tells the Mac which room it serves', async () => {
    relay = await startRelay(config(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    expect(mac.room).toBe(ROOM)
  })

  it('lets a reconnecting Mac take over its own room', async () => {
    relay = await startRelay(config(), () => undefined)
    const first = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    const second = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    second.respondWith(200, '{"from":"second"}')
    first.respondWith(200, '{"from":"first"}')

    const response = await fetch(`http://127.0.0.1:${relay.port}/r/${ROOM}/mizar/v1/hello`)
    expect(await response.text()).toBe('{"from":"second"}')

    // The displaced socket must not take the room down when it closes.
    first.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const again = await fetch(`http://127.0.0.1:${relay.port}/r/${ROOM}/mizar/v1/hello`)
    expect(await again.text()).toBe('{"from":"second"}')
  })
})

describe('relay WebSocket bridging', () => {
  it('bridges a phone socket through to the Mac', async () => {
    relay = await startRelay(config(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.echoStreams()

    const phone = new WebSocket(`ws://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/ws`)
    await new Promise<void>((resolve, reject) => {
      phone.once('open', () => resolve())
      phone.once('error', reject)
    })

    // The listener goes on before the send. Registering it afterwards is a race
    // the loopback round trip wins, and the test hangs rather than failing.
    const reply = new Promise<string>((resolve) => {
      phone.once('message', (data: Buffer) => resolve(data.toString('utf8')))
    })
    phone.send('hello from the phone')
    expect(await reply).toBe('echo:hello from the phone')
    phone.close()
  })

  it('refuses the upgrade with 502 when the Mac will not accept the stream', async () => {
    relay = await startRelay(config(), () => undefined)
    const mac = await FakeMac.connect(`ws://127.0.0.1:${relay.port}`)
    mac.refuseStreams()

    const phone = new WebSocket(`ws://127.0.0.1:${relay.port}/r/${mac.room}/mizar/v1/ws`)
    const status = await new Promise<number>((resolve, reject) => {
      phone.once('open', () => reject(new Error('the upgrade should not have succeeded')))
      phone.once('unexpected-response', (_request, response) => resolve(response.statusCode))
      phone.once('error', () => undefined)
    })
    // The Mac's refusal is visible as an HTTP status, not as a socket that opened
    // and immediately died -- the two are indistinguishable in a client's logs.
    expect(status).toBe(502)
  })

  it('refuses a phone socket for a room with no Mac', async () => {
    relay = await startRelay(config(), () => undefined)
    const phone = new WebSocket(`ws://127.0.0.1:${relay.port}/r/NOSUCHROOM/mizar/v1/ws`)
    const status = await new Promise<number>((resolve, reject) => {
      phone.once('open', () => reject(new Error('the upgrade should not have succeeded')))
      phone.once('unexpected-response', (_request, response) => resolve(response.statusCode))
      phone.once('error', () => undefined)
    })
    expect(status).toBe(404)
  })
})
