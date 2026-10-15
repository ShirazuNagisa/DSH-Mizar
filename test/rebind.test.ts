/**
 * Tests for moving a running listener to different addresses.
 *
 * This is the piece the bind watcher drives, and it is the only part of the
 * rebind path a unit test can reach without an operating system's help: the
 * watcher's own decision logic is covered in `watch.test.ts`, and the live
 * end-to-end (a network appearing after DSH started) cannot be produced on
 * demand. What is left, and what matters, is that `rebind` actually moves the
 * socket, closes the old one, and drops the clients that belonged to it.
 *
 * The two addresses are the two loopbacks rather than 127.0.0.1 and ::1:
 * macOS binds only 127.0.0.1 on `lo0`, where Linux binds all of 127.0.0.0/8, so
 * the Linux-style pair fails here with EADDRNOTAVAIL.
 *
 * @module dsh-mizar/test/rebind
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MizarStore } from '../src/auth/store.js'
import type { BindPlan } from '../src/net/interfaces.js'
import { MizarListener } from '../src/server/listener.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mizar-rebind-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Build a plan for one address. */
function planFor(address: string): BindPlan {
  return { addresses: [address], mode: 'addresses', fellBack: false, reason: 'test' }
}

/** Start a listener on a loopback address with an OS-assigned port. */
async function startOn(address: string): Promise<MizarListener> {
  const store = await MizarStore.open(dir)
  return MizarListener.start({
    plan: planFor(address),
    port: 0,
    // Off, so the port is exactly the OS-assigned one rather than the start of
    // a probe range that would walk into privileged ports.
    portFallback: false,
    store,
    pairingTtlSeconds: 300,
    maxAttemptsPerMinute: 5,
    heartbeatMs: 15_000,
    pongTimeoutMs: 20_000,
    log: () => {},
  })
}

/** Whether anything is listening on an address and port. */
async function isListening(address: string, port: number): Promise<boolean> {
  const { connect } = await import('node:net')
  return new Promise((resolve) => {
    const socket = connect({ host: address, port, timeout: 1000 })
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('error', () => resolve(false))
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
  })
}

describe('MizarListener.rebind', () => {
  it('moves the socket to the new address and closes the old one', async () => {
    const listener = await startOn('127.0.0.1')
    const firstPort = listener.port
    expect(listener.authorities).toEqual([`127.0.0.1:${firstPort}`])
    expect(await isListening('127.0.0.1', firstPort)).toBe(true)

    await listener.rebind(planFor('::1'))
    const secondPort = listener.port

    // IPv6 literals are bracketed in an authority; that is what a phone dials.
    expect(listener.authorities).toEqual([`[::1]:${secondPort}`])
    expect(await isListening('::1', secondPort)).toBe(true)
    // The old address must actually be released, or the host would keep
    // accepting connections on a network it has left.
    expect(await isListening('127.0.0.1', firstPort)).toBe(false)

    await listener.stop()
  })

  it('reports the new authorities to the panel', async () => {
    const listener = await startOn('127.0.0.1')
    await listener.rebind(planFor('::1'))
    expect(listener.authorities[0]).toContain('::1')
    await listener.stop()
  })

  it('tells the broker the client count dropped to zero', async () => {
    // Connected sockets belonged to the old address and are dropped rather than
    // migrated, so the interaction broker has to fail closed on them.
    const counts: number[] = []
    const store = await MizarStore.open(dir)
    const listener = await MizarListener.start({
      plan: planFor('127.0.0.1'),
      port: 0,
      portFallback: false,
      store,
      pairingTtlSeconds: 300,
      maxAttemptsPerMinute: 5,
      heartbeatMs: 15_000,
      pongTimeoutMs: 20_000,
      log: () => {},
      onClientCount: (count) => counts.push(count),
    })

    await listener.rebind(planFor('::1'))
    expect(counts).toContain(0)
    await listener.stop()
  })

  it('survives a rebind to the same address', async () => {
    // The watcher only rebinds on a key change, but a rebind that happens
    // anyway must not leave the listener dead.
    const listener = await startOn('127.0.0.1')
    await listener.rebind(planFor('127.0.0.1'))
    expect(await isListening('127.0.0.1', listener.port)).toBe(true)
    await listener.stop()
  })

  it('still serves requests after a rebind', async () => {
    const store = await MizarStore.open(dir)
    const listener = await MizarListener.start({
      plan: planFor('127.0.0.1'),
      port: 0,
      portFallback: false,
      store,
      pairingTtlSeconds: 300,
      maxAttemptsPerMinute: 5,
      heartbeatMs: 15_000,
      pongTimeoutMs: 20_000,
      log: () => {},
    })
    await listener.rebind(planFor('::1'))

    const response = await fetch(`http://[::1]:${listener.port}/mizar/v1/hello`)
    expect(response.status).toBe(200)
    const body = (await response.json()) as { protocolVersion: number; hostId: string }
    expect(body.protocolVersion).toBe(1)
    expect(body.hostId).toBe(store.state.hostId)

    await listener.stop()
  })
})
