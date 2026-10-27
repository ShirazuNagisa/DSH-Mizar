/**
 * The link client against a real socket.
 *
 * `LinkClient` is the only part of 0.9.0 that touches the network, and its
 * failure modes are all timing: a desktop that is not up yet, a token this launch
 * no longer accepts, a socket that goes quiet. A fake `WebSocket` would test the
 * mock, so these tests run a real `ws` server on an ephemeral port and a real
 * endpoint file.
 *
 * @module dsh-mizar/test/link-client
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { LinkClient } from '../src/link/client.js'
import { LINK_PATH, type FrameToDesktop, type FrameToPlugin } from '../src/link/frames.js'

/** Everything one test opened, torn down afterwards. */
interface Harness {
  readonly client: LinkClient
  readonly server: WebSocketServer
  readonly received: FrameToDesktop[]
  readonly up: ReturnType<typeof vi.fn>
  readonly down: ReturnType<typeof vi.fn>
  readonly frames: FrameToPlugin[]
  readonly dir: string
}

const open: Harness[] = []

/** Poll until `check` is true, or fail after a generous deadline. */
async function until(check: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error('condition never became true')
}

/**
 * Start a desktop stand-in and a client pointed at it.
 *
 * @param options.acceptToken - the token the server accepts; defaults to the one
 *   written to the endpoint file.
 * @param options.sendWelcome - whether the server answers the handshake.
 */
async function harness(options: { acceptToken?: string; sendWelcome?: boolean } = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'agi-mizar-link-'))
  const token = 'test-token'
  const received: FrameToDesktop[] = []
  const frames: FrameToPlugin[] = []
  const up = vi.fn()
  const down = vi.fn()

  const server = new WebSocketServer({ port: 0, path: LINK_PATH })
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0

  server.on('connection', (socket: WebSocket) => {
    socket.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as FrameToDesktop
      received.push(frame)
      if (frame.type !== 'hello') return
      if (frame.token !== (options.acceptToken ?? token)) {
        socket.close(4401, 'bad token')
        return
      }
      if (options.sendWelcome === false) return
      socket.send(JSON.stringify({ v: 1, type: 'welcome', linkVersion: 1, desktop: 'test' }))
    })
  })

  const endpointFile = join(dir, 'endpoint.json')
  await writeFile(endpointFile, JSON.stringify({ port, token }), 'utf8')

  const client = new LinkClient({
    endpointFile,
    identity: () => ({
      plugin: { name: 'dsh-mizar', version: '0.9.0', linkVersion: 1 },
      dsh: { platform: 'test', home: dir, node: 'v22' },
      endpoints: ['session/list'],
      services: ['workspaceRegistry'],
    }),
    onFrame: (frame) => frames.push(frame),
    onUp: up,
    onDown: down,
    log: () => {},
    reconnect: { baseMs: 50, maxMs: 200, heartbeatMs: 1_000 },
  })

  const harnessed: Harness = { client, server, received, up, down, frames, dir }
  open.push(harnessed)
  client.start()
  return harnessed
}

afterEach(async () => {
  for (const item of open.splice(0)) {
    item.client.stop()
    await new Promise<void>((resolve) => item.server.close(() => resolve()))
    await rm(item.dir, { recursive: true, force: true })
  }
})

describe('LinkClient', () => {
  it('completes the handshake and reports the desktop identity', async () => {
    const { client, received, up } = await harness()
    await until(() => client.connected)

    expect(up).toHaveBeenCalledOnce()
    expect(up.mock.calls[0]?.[0]).toMatchObject({ linkVersion: 1, desktop: 'test' })
    expect(received[0]).toMatchObject({
      type: 'hello',
      token: 'test-token',
      endpoints: ['session/list'],
      services: ['workspaceRegistry'],
    })
  })

  it('refuses to send before the handshake', async () => {
    const { client } = await harness({ sendWelcome: false })
    expect(client.send({ v: 1, type: 'notice', level: 'info', message: 'too early' })).toBe(false)
  })

  it('sends frames after the handshake', async () => {
    const { client, received } = await harness()
    await until(() => client.connected)
    expect(client.send({ v: 1, type: 'notice', level: 'info', message: 'hello' })).toBe(true)
    await until(() => received.some((frame) => frame.type === 'notice'))
  })

  it('does not report a link that was never established', async () => {
    const { client, down } = await harness({ acceptToken: 'a-different-token' })
    // The server closes the socket; the client keeps retrying and must not
    // pretend it was ever up.
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(client.connected).toBe(false)
    expect(down).not.toHaveBeenCalled()
  })

  it('reports a link that drops, so pending approvals can fail closed', async () => {
    const { client, server, down } = await harness()
    await until(() => client.connected)

    for (const socket of server.clients) socket.close(1001, 'going away')
    await until(() => down.mock.calls.length > 0)
    expect(client.connected).toBe(false)
    expect(String(down.mock.calls[0]?.[0])).toMatch(/socket closed/)
  })

  it('reconnects on its own after the desktop restarts', async () => {
    const { client, up, server } = await harness()
    await until(() => client.connected)
    for (const socket of server.clients) socket.close(1001, 'restart')
    await until(() => !client.connected)

    // A new connection reaches the same server; the client dials again.
    await until(() => up.mock.calls.length >= 2)
  })
})
