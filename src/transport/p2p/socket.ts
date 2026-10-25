/**
 * A UDP socket the engine can hold for its whole life.
 *
 * One socket, bound once, never rebound. That is not an implementation
 * preference: a NAT creates its mapping per socket, and the punch depends on
 * the local port staying the same for the lifetime of the connection.
 *
 * Datagrams arrive through {@link DatagramSocket.events}, which is sequential
 * by construction — the engine's dispatch loop and every session's reassembly
 * rely on packet order matching arrival order.
 *
 * @module dsh-mizar/transport/p2p/socket
 */

import { createSocket, type RemoteInfo, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'

/** An address on the wire. */
export interface Address {
  readonly address: string
  readonly port: number
}

/** One received datagram and where it came from. */
export interface Datagram {
  readonly data: Buffer
  readonly from: Address
}

/** A bound UDP socket. */
export class DatagramSocket {
  private readonly socket: Socket
  private readonly queue: Datagram[] = []
  private readonly waiters: Array<(value: Datagram | null) => void> = []
  private closed = false
  private readonly boundPort: number

  private constructor(socket: Socket, port: number) {
    this.socket = socket
    this.boundPort = port
    socket.on('message', (data: Buffer, remote: RemoteInfo) => {
      this.push({ data, from: { address: remote.address, port: remote.port } })
    })
    // A socket-level error (ICMP-induced, address family trouble) must not
    // take the process down: this link is one route among several, and the
    // layer above is responsible for falling back.
    socket.on('error', () => {})
  }

  /**
   * Bind a socket.
   * @param port - the port to bind, or 0 for an ephemeral one.
   * @returns the bound socket.
   */
  static bind(port = 0): Promise<DatagramSocket> {
    const raw = createSocket({ type: 'udp4', reuseAddr: false })
    return new Promise((resolve, reject) => {
      raw.once('error', reject)
      raw.bind(port, () => {
        raw.removeListener('error', reject)
        resolve(new DatagramSocket(raw, raw.address().port))
      })
    })
  }

  /** The port this socket is bound to. */
  get localPort(): number {
    return this.boundPort
  }

  /**
   * Send one datagram.
   * @param data - the bytes.
   * @param to - the destination.
   */
  send(data: Buffer, to: Address): Promise<void> {
    if (this.closed) return Promise.reject(new Error('the socket is closed'))
    return new Promise((resolve, reject) => {
      this.socket.send(data, to.port, to.address, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }

  /**
   * The datagrams, in arrival order.
   *
   * One consumer: the engine's dispatch loop. A second reader would split the
   * stream by timing rather than by connection id, which is exactly the bug
   * the connection id exists to prevent.
   */
  async *events(): AsyncGenerator<Datagram> {
    while (true) {
      const next = this.queue.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.closed) return
      const waited = await new Promise<Datagram | null>((resolve) => this.waiters.push(resolve))
      if (waited === null) return
      yield waited
    }
  }

  /** Close the socket and drain the reader. */
  close(): Promise<void> {
    if (this.closed) return Promise.resolve()
    this.closed = true
    for (const waiter of this.waiters.splice(0)) waiter(null)
    return new Promise((resolve) => this.socket.close(() => resolve()))
  }

  /**
   * The host's own IPv4 addresses.
   *
   * Loopback is included: two endpoints on one machine is the first test, and
   * a LAN address that is not listed is a punch that never leaves the host.
   * Link-local (169.254/16) is skipped — it is what an interface reports when
   * it has no address at all.
   *
   * @returns the addresses, deduplicated.
   */
  static hostAddresses(): string[] {
    const seen = new Set<string>()
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family !== 'IPv4') continue
        if (entry.address.startsWith('169.254.')) continue
        seen.add(entry.address)
      }
    }
    return [...seen]
  }

  private push(datagram: Datagram): void {
    const waiter = this.waiters.shift()
    if (waiter !== undefined) waiter(datagram)
    else this.queue.push(datagram)
  }
}
