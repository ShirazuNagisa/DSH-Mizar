/**
 * The relay.
 *
 * A Mac opens one outbound WebSocket to `/tunnel` and is thereafter reachable at
 * `/r/<room>/...` by anything that can reach this server. Requests are replayed
 * over that socket; a phone WebSocket is bridged through it. Nothing about the
 * Mizar protocol is interpreted here -- the relay moves bytes and does not know
 * what a session is. That is what keeps the trust boundary where it belongs: the
 * plugin authenticates the phone exactly as it would on a LAN.
 *
 * Two behaviours are worth reading the code for:
 *
 *   - **The upgrade is deferred.** A phone WebSocket is not accepted until the
 *     Mac has accepted it, so an unreachable Mac produces an HTTP error rather
 *     than a socket that opens and immediately dies. The two look identical in a
 *     client's logs and only one of them is diagnosable.
 *   - **A room with no tunnel is a 404, and the same 404 as a room that never
 *     existed.** Telling the difference would let anybody enumerate which Macs
 *     are online.
 *
 * @module dsh-mizar-relay/index
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { createSocket, type Socket as UdpSocket } from 'node:dgram'
import { WebSocketServer, type WebSocket } from 'ws'
import { loadConfig, type RelayConfig } from './config.js'
import { deriveRoom, secretsEqual } from './room.js'
import { RoomRegistry, Tunnel, saneCloseCode, type TunnelStream } from './tunnel.js'
import {
  ROOM_PREFIX,
  TUNNEL_PATH,
  TUNNEL_PROTOCOL_VERSION,
  splitRoomPath,
} from './protocol.js'

/** Headers that describe this hop rather than the request. */
const HOP_BY_HOP = new Set([
  'connection',
  'upgrade',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
])

/** Largest `Authorization: Bearer` prefix, so a huge header cannot be used to stall. */
const BEARER_PREFIX = 'bearer '

/** A running relay. */
export interface Relay {
  /** The port it actually bound, which differs from the config when 0 was asked for. */
  readonly port: number
  /** Stop listening and close every tunnel. */
  close(): Promise<void>
}

/** Read a request body, refusing anything past the cap. */
async function readBody(request: IncomingMessage, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > limit) return null
    chunks.push(buffer)
  }
  return Buffer.concat(chunks)
}

/** The headers worth carrying to the Mac: everything that describes the request. */
function forwardableHeaders(request: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (HOP_BY_HOP.has(name.toLowerCase())) continue
    if (typeof value === 'string') out[name] = value
    else if (Array.isArray(value)) out[name] = value.join(', ')
  }
  return out
}

/** Extract the bearer token from an upgrade request. */
function bearerToken(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  if (typeof header !== 'string') return null
  if (header.toLowerCase().startsWith(BEARER_PREFIX)) {
    return header.slice(BEARER_PREFIX.length).trim()
  }
  return null
}

/**
 * Start the relay.
 *
 * @param config - the resolved configuration.
 * @param log - where to report.
 * @returns the running relay.
 */
export async function startRelay(
  config: RelayConfig,
  log: (message: string) => void = console.log,
): Promise<Relay> {
  const rooms = new RoomRegistry()
  /** Live tunnels per source address. Not a security boundary, a resource one. */
  const tunnelsPerIp = new Map<string, number>()
  const wss = new WebSocketServer({ noServer: true })
  /** Phone sockets waiting for the Mac to accept their upgrade. */
  // The upgrade socket is a Duplex, not a net.Socket: `ws` accepts whatever the
  // HTTP server hands over, and typing it as a Socket made every use of it an error.
  const waiting = new Set<{ socket: Duplex; timer: NodeJS.Timeout }>()

  const server: Server = createServer((request, response) => {
    void handleHttp(request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500)
      response.end()
    })
  })

  /** Answer one phone HTTP request by replaying it over its room's tunnel. */
  async function handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = request.url ?? '/'
    if (url === '/healthz') {
      writeJson(response, 200, {
        ok: true,
        rooms: rooms.size,
        inFlight: rooms.inFlight,
        version: TUNNEL_PROTOCOL_VERSION,
      })
      return
    }

    const split = splitRoomPath(url)
    if (split === null) {
      writeJson(response, 404, { error: 'not found' })
      return
    }

    // The same answer whether the room is empty or was never issued. Distinguishing
    // them would let anyone enumerate which Macs are currently online.
    const tunnel = rooms.get(split.room)
    if (tunnel === undefined || !tunnel.alive) {
      writeJson(response, 404, { error: 'not found' })
      return
    }

    const body = await readBody(request, config.maxBodyBytes)
    if (body === null) {
      writeJson(response, 413, { error: 'request body too large' })
      return
    }

    try {
      const result = await tunnel.request(
        request.method ?? 'GET',
        split.path,
        forwardableHeaders(request),
        body.length === 0 ? null : body.toString('base64'),
      )
      const payload = result.body === null ? Buffer.alloc(0) : Buffer.from(result.body, 'base64')
      response.writeHead(result.status, {
        ...result.headers,
        'content-length': String(payload.length),
      })
      response.end(payload)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      writeJson(response, 502, { error: 'the Mac did not answer', detail: message })
    }
  }

  server.on('upgrade', (request, socket, head) => {
    const url = request.url ?? '/'

    if (url === TUNNEL_PATH || url.startsWith(`${TUNNEL_PATH}?`)) {
      handleTunnelUpgrade(request, socket, head)
      return
    }

    const split = splitRoomPath(url)
    if (split === null) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    const tunnel = rooms.get(split.room)
    if (tunnel === undefined || !tunnel.alive) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
      socket.destroy()
      return
    }

    // The raw socket is left unanswered until the Mac says yes. Answering first
    // and closing afterwards would show the phone a socket that opened and died,
    // which reads as a bug in the app rather than as an unreachable Mac.
    const entry = {
      socket,
      timer: setTimeout(() => {
        waiting.delete(entry)
        socket.write('HTTP/1.1 504 Gateway Timeout\r\n\r\n')
        socket.destroy()
      }, config.requestTimeoutMs),
    }
    entry.timer.unref?.()
    waiting.add(entry)

    /** The phone went away before the Mac answered. */
    const onSocketGone = (): void => {
      clearTimeout(entry.timer)
      waiting.delete(entry)
    }
    socket.on('close', onSocketGone)
    socket.on('error', onSocketGone)

    // Held in an object rather than a `let` so the callbacks below can read them
    // without TypeScript narrowing each to the `null` it had at closure-creation
    // time -- neither can exist before the call that creates it returns.
    //
    // The phone socket arrives asynchronously, which is what makes this necessary:
    // the stream's handlers are fixed when it opens and the socket they must talk
    // to does not exist yet -- and, for data coming back, will not exist for
    // another round trip. A first version of this left `onMessage` empty with a
    // comment explaining that the Mac "does not send before the upgrade
    // completes", which was true and beside the point: the handler is permanent,
    // and so the Mac's answers had nowhere to go for the life of the stream.
    const opened: { stream: TunnelStream | null; phone: WebSocket | null } = {
      stream: null,
      phone: null,
    }
    opened.stream = tunnel.openStream(split.path, forwardableHeaders(request), {
      onOpened: () => {
        const stream = opened.stream
        if (stream === null) return
        clearTimeout(entry.timer)
        waiting.delete(entry)
        socket.removeListener('close', onSocketGone)
        socket.removeListener('error', onSocketGone)
        wss.handleUpgrade(request, socket, head, (phone: WebSocket) => {
          opened.phone = phone
          bridgePhone(phone, stream)
        })
      },
      onError: (message) => {
        clearTimeout(entry.timer)
        waiting.delete(entry)
        log(`relay: stream refused for room ${split.room}: ${message}`)
        // Before the upgrade there is still an HTTP request to answer, and saying
        // 502 is far more useful than a socket that opens and immediately dies.
        // After it, the phone socket is the only thing left to close.
        if (opened.phone !== null) {
          opened.phone.close(1011, 'the Mac dropped the stream')
        } else if (!socket.destroyed) {
          socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
          socket.destroy()
        }
      },
      onMessage: (data, binary) => {
        opened.phone?.send(data, { binary })
      },
      onClose: (code, reason) => {
        clearTimeout(entry.timer)
        waiting.delete(entry)
        opened.phone?.close(saneCloseCode(code), reason)
      },
    })

    if (opened.stream === null) {
      clearTimeout(entry.timer)
      waiting.delete(entry)
      if (!socket.destroyed) {
        socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
        socket.destroy()
      }
    }
  })

  /** Move bytes between a phone WebSocket and its tunnel stream. */
  function bridgePhone(phone: WebSocket, stream: TunnelStream): void {
    phone.on('message', (data: Buffer, isBinary: boolean) => {
      if (data.length > config.maxMessageBytes) {
        phone.close(1009, 'message too large')
        stream.close(1009, 'message too large')
        return
      }
      stream.send(Buffer.isBuffer(data) ? data : Buffer.from(String(data)), isBinary)
    })
    phone.on('close', (code: number, reason: Buffer) => {
      // The phone's code is forwarded, and a `close` handler is given reserved
      // codes like 1006 that must not be sent on. Replaying one unexamined took
      // the plugin down with a TypeError.
      stream.close(saneCloseCode(code), reason.toString('utf8'))
    })
    phone.on('error', () => {
      stream.close(1011, 'phone socket error')
    })
  }

  /** Authenticate and attach a Mac's tunnel. */
  function handleTunnelUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    // Self-registration. A relay that issued credentials would need an operator
    // to hand them out and a user to type them, which is the configuration this
    // design exists to remove -- so any well-formed credential is accepted and
    // the room is derived from it.
    //
    // That is safe for the reason the room is derived rather than chosen: the
    // room is 60 bits of a hash of a secret this Mac generated locally, so
    // knowing one tells you nothing about any other. What the relay must guard
    // is not who may connect but how many may, which is what the limits below
    // are for.
    const presented = bearerToken(request)
    if (presented === null || presented.length < 16) {
      log('relay: tunnel refused — a credential of at least 16 characters is required')
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    if (config.tokens.length > 0 && !config.tokens.some((token) => secretsEqual(token, presented))) {
      log('relay: tunnel refused — this relay only accepts its configured credentials')
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }

    const peer = request.socket.remoteAddress ?? 'unknown'
    if (tunnelsPerIp.get(peer) !== undefined && (tunnelsPerIp.get(peer) ?? 0) >= config.maxTunnelsPerIp) {
      log(`relay: tunnel refused — ${peer} already has ${config.maxTunnelsPerIp} tunnels`)
      socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n')
      socket.destroy()
      return
    }

    const room = deriveRoom(presented)
    if (rooms.get(room) === undefined && rooms.size >= config.maxRooms) {
      log(`relay: tunnel refused — already serving ${config.maxRooms} rooms`)
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(request, socket, head, (host: WebSocket) => {
      tunnelsPerIp.set(peer, (tunnelsPerIp.get(peer) ?? 0) + 1)
      const tunnel = new Tunnel(
        {
          send: (text) => host.send(text),
          close: (code, reason) => host.close(code, reason),
          on: (event, listener) => host.on(event, listener as never),
          get bufferedAmount() {
            return host.bufferedAmount
          },
        },
        config.requestTimeoutMs,
      )

      const displaced = rooms.register(room, tunnel)
      displaced?.close(4000, 'replaced by a newer tunnel')
      log(`relay: tunnel for room ${room} connected${displaced ? ' (replaced a stale one)' : ''}`)

      let released = false
      host.on('close', () => {
        if (!released) {
          released = true
          const remaining = (tunnelsPerIp.get(peer) ?? 1) - 1
          if (remaining <= 0) tunnelsPerIp.delete(peer)
          else tunnelsPerIp.set(peer, remaining)
        }
        const wasCurrent = rooms.remove(room, tunnel)
        if (wasCurrent) log(`relay: tunnel for room ${room} disconnected`)
      })

      host.send(
        JSON.stringify({
          t: 'welcome',
          room,
          protocolVersion: TUNNEL_PROTOCOL_VERSION,
        }),
      )
    })
  }

  /**
   * Keep every Mac awake, and drop the ones that stop answering.
   *
   * The ping is what turns a half-open tunnel into a disconnect the relay can
   * act on. Without it a Mac whose process died keeps a socket that accepts
   * writes, and every phone request pays a full timeout to discover it.
   */
  let pingCounter = 0
  const interval = Math.max(5_000, Math.floor(config.tunnelIdleMs / 3))
  const sweeper = setInterval(() => {
    for (const room of rooms.rooms) {
      const tunnel = rooms.get(room)
      if (tunnel === undefined || !tunnel.alive) continue
      if (!tunnel.responsiveWithin(config.tunnelIdleMs)) {
        log(`relay: tunnel for room ${room} stopped answering; dropping it`)
        tunnel.close(4001, 'no pong within the idle window')
        rooms.remove(room, tunnel)
        continue
      }
      pingCounter += 1
      tunnel.ping(`p${pingCounter}`)
    }
  }, interval)
  sweeper.unref?.()

  // Awaited so the returned port is the real one. Binding port 0 is how the
  // tests avoid colliding with a relay someone is actually running, and a
  // synchronous read of `server.address()` happens before the bind completes --
  // it would report the requested 0 rather than the assigned port.
  const boundPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : config.port)
    })
  })
  log(`relay: listening on ${config.host}:${boundPort}`)
  log(
    config.tokens.length === 0
      ? 'relay: open registration — any plugin may register a room'
      : `relay: ${config.tokens.length} configured credential(s)`,
  )

  const probe = startProbe(config, log)

  return {
    port: boundPort,
    close: async () => {
      clearInterval(sweeper)
      for (const entry of waiting) clearTimeout(entry.timer)
      waiting.clear()
      rooms.closeAll()
      probe?.close()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/**
 * The UDP endpoint probe.
 *
 * This is the relay being useful with the one thing a Mac behind a campus
 * firewall cannot do for itself: it has a public address, so it can tell each
 * peer where that peer appears from the outside. That is the whole of STUN for
 * this purpose, in about twenty lines, and it means no third-party service is
 * needed for hole punching.
 *
 * The reply is JSON rather than RFC 5389, because the only consumer is this
 * project's own code and a readable answer is worth more here than
 * interoperability with a browser.
 *
 * @param config - the relay configuration.
 * @param log - where to report.
 * @returns the socket, or `null` when the probe is disabled.
 */
function startProbe(config: RelayConfig, log: (message: string) => void): UdpSocket | null {
  if (config.probePort <= 0) return null
  const socket = createSocket('udp4')
  socket.on('message', (data: Buffer, from) => {
    // Any payload earns an answer; the peer wants its own address back, not a
    // handshake.
    const reply = JSON.stringify({
      address: from.address,
      port: from.port,
      // Echoed so a peer can match an answer to its own probe.
      token: data.length > 0 && data.length <= 64 ? data.toString('utf8') : null,
    })
    socket.send(Buffer.from(reply, 'utf8'), from.port, from.address)
  })
  socket.on('error', (error) => log(`relay: probe socket error: ${error.message}`))
  socket.bind(config.probePort, '0.0.0.0', () => {
    log(`relay: endpoint probe on udp/${config.probePort}`)
  })
  return socket
}

/** Write a JSON response. */
function writeJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  response.end(payload)
}

export { loadConfig, deriveRoom, splitRoomPath, ROOM_PREFIX }

/**
 * Start from configuration, or exit with the reason.
 *
 * A config error is a start-up failure, not a runtime one: a relay with no
 * tokens accepts nothing, and one with a typo'd port is not running where anyone
 * expects. Failing loudly beats being up and useless.
 */
export function main(): void {
  let config: RelayConfig
  try {
    config = loadConfig()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
    return
  }

  void startRelay(config).then((relay) => {
    const shutdown = (signal: string): void => {
      console.log(`relay: ${signal}, shutting down`)
      void relay.close().then(() => process.exit(0))
    }
    process.on('SIGTERM', () => shutdown('SIGTERM'))
    process.on('SIGINT', () => shutdown('SIGINT'))
  })
}

// Run when invoked directly, stay importable when a test wants a relay.
if (process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop() ?? '')) {
  main()
}
