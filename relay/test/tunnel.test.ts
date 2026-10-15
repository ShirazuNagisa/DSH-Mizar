import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  RoomRegistry,
  Tunnel,
  TunnelGoneError,
  TunnelTimeoutError,
  type TunnelSocket,
} from '../src/tunnel.js'

/** A socket that records what the relay wrote and lets a test inject replies. */
class FakeSocket extends EventEmitter implements TunnelSocket {
  readonly sent: string[] = []
  bufferedAmount = 0
  closed: { code?: number; reason?: string } | null = null

  send(text: string): void {
    this.sent.push(text)
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason }
  }

  /** The frames written so far, parsed. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>)
  }

  /** The last frame written. */
  last(): Record<string, unknown> {
    const frame = this.frames().at(-1)
    if (frame === undefined) throw new Error('nothing was sent')
    return frame
  }

  /** Answer the most recent request. */
  reply(body: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(body)))
  }
}

const makeTunnel = (socket: FakeSocket, timeout = 1000): Tunnel =>
  new Tunnel(socket, timeout)

describe('Tunnel.request', () => {
  it('sends a request and resolves with the answer', async () => {
    const socket = new FakeSocket()
    const tunnel = makeTunnel(socket)

    const pending = tunnel.request('POST', '/mizar/v1/pair', { 'content-type': 'application/json' }, 'Ym9keQ==')
    const sent = socket.last()
    expect(sent['t']).toBe('req')
    expect(sent['method']).toBe('POST')
    expect(sent['path']).toBe('/mizar/v1/pair')
    expect(sent['body']).toBe('Ym9keQ==')

    socket.reply({
      t: 'res',
      id: sent['id'],
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: 'b2s=',
    })

    await expect(pending).resolves.toEqual({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: 'b2s=',
    })
    expect(tunnel.inFlight).toBe(0)
  })

  it('gives each request its own id', async () => {
    const socket = new FakeSocket()
    const tunnel = makeTunnel(socket)
    void tunnel.request('GET', '/a', {}, null).catch(() => undefined)
    void tunnel.request('GET', '/b', {}, null).catch(() => undefined)
    const ids = socket.frames().map((frame) => frame['id'])
    expect(new Set(ids).size).toBe(2)
  })

  it('resolves only the matching request', async () => {
    const socket = new FakeSocket()
    const tunnel = makeTunnel(socket)
    const first = tunnel.request('GET', '/a', {}, null)
    const second = tunnel.request('GET', '/b', {}, null)
    const [idA, idB] = socket.frames().map((frame) => frame['id'])

    socket.reply({ t: 'res', id: idB, status: 201, headers: {}, body: null })
    await expect(second).resolves.toMatchObject({ status: 201 })

    socket.reply({ t: 'res', id: idA, status: 200, headers: {}, body: null })
    await expect(first).resolves.toMatchObject({ status: 200 })
  })

  it('times out rather than waiting forever', async () => {
    const socket = new FakeSocket()
    const tunnel = makeTunnel(socket, 20)
    await expect(tunnel.request('GET', '/a', {}, null)).rejects.toBeInstanceOf(TunnelTimeoutError)
  })

  it('ignores an answer that arrives after its request timed out', async () => {
    const socket = new FakeSocket()
    const tunnel = makeTunnel(socket, 20)
    const pending = tunnel.request('GET', '/a', {}, null)
    const id = socket.last()['id']
    await expect(pending).rejects.toBeInstanceOf(TunnelTimeoutError)
    // Must not throw on the late frame, and must not resurrect the request.
    expect(() => socket.reply({ t: 'res', id, status: 200, headers: {}, body: null })).not.toThrow()
    expect(tunnel.inFlight).toBe(0)
  })

  it('rejects immediately when the socket is congested instead of queueing', async () => {
    const socket = new FakeSocket()
    socket.bufferedAmount = 100 * 1024 * 1024
    const tunnel = makeTunnel(socket)
    await expect(tunnel.request('GET', '/a', {}, null)).rejects.toBeInstanceOf(TunnelGoneError)
  })
})

describe('Tunnel teardown', () => {
  it('fails in-flight requests the moment the socket closes', async () => {
    const socket = new FakeSocket()
    const tunnel = makeTunnel(socket)
    const pending = tunnel.request('GET', '/a', {}, null)
    // The point of this test: the request must not wait for its own 30s timer.
    // A phone showing a spinner for the full timeout is indistinguishable from a
    // broken app, and the answer is already known.
    socket.emit('close')
    await expect(pending).rejects.toBeInstanceOf(TunnelGoneError)
  })

  it('fails in-flight requests on a socket error', async () => {
    const socket = new FakeSocket()
    const tunnel = makeTunnel(socket)
    const pending = tunnel.request('GET', '/a', {}, null)
    socket.emit('error', new Error('boom'))
    await expect(pending).rejects.toBeInstanceOf(TunnelGoneError)
  })

  it('refuses new requests once closed', async () => {
    const socket = new FakeSocket()
    const tunnel = makeTunnel(socket)
    socket.emit('close')
    await expect(tunnel.request('GET', '/a', {}, null)).rejects.toBeInstanceOf(TunnelGoneError)
    expect(tunnel.alive).toBe(false)
  })

  it('tells an open stream when the tunnel dies', () => {
    const socket = new FakeSocket()
    const tunnel = makeTunnel(socket)
    const onError = vi.fn()
    tunnel.openStream('/mizar/v1/ws', {}, {
      onOpened: vi.fn(),
      onMessage: vi.fn(),
      onClose: vi.fn(),
      onError,
    })
    socket.emit('close')
    expect(onError).toHaveBeenCalledOnce()
  })
})

describe('Tunnel streams', () => {
  it('opens, bridges both directions, and closes', () => {
    const socket = new FakeSocket()
    const tunnel = makeTunnel(socket)
    const onOpened = vi.fn()
    const onMessage = vi.fn()
    const onClose = vi.fn()

    const stream = tunnel.openStream('/mizar/v1/ws', { 'user-agent': 'test' }, {
      onOpened,
      onMessage,
      onClose,
      onError: vi.fn(),
    })
    const openFrame = socket.last()
    expect(openFrame['t']).toBe('ws-open')
    expect(openFrame['path']).toBe('/mizar/v1/ws')

    socket.reply({ t: 'ws-open-ok', id: openFrame['id'] })
    expect(onOpened).toHaveBeenCalledOnce()

    socket.reply({ t: 'ws-msg', id: openFrame['id'], data: Buffer.from('hello').toString('base64'), binary: false })
    expect(onMessage).toHaveBeenCalledWith(Buffer.from('hello'), false)

    stream?.send(Buffer.from('back'), false)
    expect(socket.last()).toMatchObject({ t: 'ws-msg', data: Buffer.from('back').toString('base64') })

    socket.reply({ t: 'ws-close', id: openFrame['id'], code: 1001, reason: 'going away' })
    expect(onClose).toHaveBeenCalledWith(1001, 'going away')
    expect(tunnel.inFlight).toBe(0)
  })

  it('reports a stream the Mac never accepted', async () => {
    const socket = new FakeSocket()
    const tunnel = makeTunnel(socket, 20)
    const onError = vi.fn()
    tunnel.openStream('/mizar/v1/ws', {}, {
      onOpened: vi.fn(),
      onMessage: vi.fn(),
      onClose: vi.fn(),
      onError,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(onError).toHaveBeenCalledWith(expect.stringContaining('did not accept'))
  })

  it('drops a stream when the Mac reports an error for it', () => {
    const socket = new FakeSocket()
    const tunnel = makeTunnel(socket)
    const onError = vi.fn()
    tunnel.openStream('/mizar/v1/ws', {}, {
      onOpened: vi.fn(),
      onMessage: vi.fn(),
      onClose: vi.fn(),
      onError,
    })
    const id = socket.last()['id']
    socket.reply({ t: 'error', id, message: 'no such path' })
    expect(onError).toHaveBeenCalledWith('no such path')
    expect(tunnel.inFlight).toBe(0)
  })
})

describe('Tunnel liveness', () => {
  it('starts responsive but goes quiet without a pong', async () => {
    vi.useFakeTimers()
    try {
      const socket = new FakeSocket()
      const tunnel = makeTunnel(socket)
      expect(tunnel.responsiveWithin(1000)).toBe(true)
      vi.advanceTimersByTime(2000)
      expect(tunnel.responsiveWithin(1000)).toBe(false)
      socket.reply({ t: 'pong', id: 'p1' })
      expect(tunnel.responsiveWithin(1000)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('RoomRegistry', () => {
  it('serves a room and returns it', () => {
    const registry = new RoomRegistry()
    const tunnel = makeTunnel(new FakeSocket())
    registry.register('ROOM', tunnel)
    expect(registry.get('ROOM')).toBe(tunnel)
    expect(registry.size).toBe(1)
  })

  it('replaces a previous tunnel and reports the displaced one', () => {
    const registry = new RoomRegistry()
    const first = makeTunnel(new FakeSocket())
    const second = makeTunnel(new FakeSocket())
    registry.register('ROOM', first)
    expect(registry.register('ROOM', second)).toBe(first)
    expect(registry.get('ROOM')).toBe(second)
    expect(registry.size).toBe(1)
  })

  it('does not let a stale socket evict its replacement', () => {
    // The reconnect race: the old socket's close arrives after the new one
    // registered, and must not take the room down with it.
    const registry = new RoomRegistry()
    const first = makeTunnel(new FakeSocket())
    const second = makeTunnel(new FakeSocket())
    registry.register('ROOM', first)
    registry.register('ROOM', second)
    expect(registry.remove('ROOM', first)).toBe(false)
    expect(registry.get('ROOM')).toBe(second)
  })

  it('removes the current tunnel', () => {
    const registry = new RoomRegistry()
    const tunnel = makeTunnel(new FakeSocket())
    registry.register('ROOM', tunnel)
    expect(registry.remove('ROOM', tunnel)).toBe(true)
    expect(registry.get('ROOM')).toBeUndefined()
  })

  it('sums in-flight work across rooms', () => {
    const registry = new RoomRegistry()
    const a = makeTunnel(new FakeSocket())
    const b = makeTunnel(new FakeSocket())
    registry.register('A', a)
    registry.register('B', b)
    void a.request('GET', '/x', {}, null).catch(() => undefined)
    void b.request('GET', '/y', {}, null).catch(() => undefined)
    expect(registry.inFlight).toBe(2)
  })

  it('closes every tunnel', () => {
    const registry = new RoomRegistry()
    const socket = new FakeSocket()
    registry.register('A', makeTunnel(socket))
    registry.closeAll()
    expect(socket.closed).not.toBeNull()
    expect(registry.size).toBe(0)
  })
})
