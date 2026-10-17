/**
 * Tests for the gateway helper.
 *
 * Since DSH 0.2.1 every `InvokeRemoteRequest` must name the Peer it speaks for.
 * These tests pin the two properties the twenty call sites depend on: exactly
 * one owner Peer is created per context and every request carries it, and the
 * Peer still exists — structurally, with the same principal — in a composition
 * that has no Host connection service to ask.
 *
 * @module dsh-mizar/test/invoke
 */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/dsh.js'
import { invokeRemote, streamRemote } from '../src/bridge/invoke.js'

/** The fields of a PeerScope the helper's callers can observe. */
interface PeerLike {
  readonly id: string
  readonly ctx: unknown
  readonly principal: { readonly kind: string }
  readonly interactions: string
  readonly signal: AbortSignal
  dispose(): Promise<void>
}

/** A gateway request the fake recorded. */
interface RecordedRequest {
  namespace: string
  method: string
  args: Record<string, unknown>
  signal?: AbortSignal
  peer: PeerLike
}

/**
 * A context with a recording gateway.
 *
 * `effect` runs the body eagerly and keeps its disposer, which is the part of
 * Cordis the helper actually uses; `get('connection')` answers the optional
 * Host factory.
 *
 * @param connection - the connection service double, or `undefined` for none.
 * @returns the context, every recorded request, and the registered disposers.
 */
function fakeContext(connection?: unknown): {
  ctx: Context
  requests: RecordedRequest[]
  disposers: (() => void)[]
} {
  const requests: RecordedRequest[] = []
  const disposers: (() => void)[] = []
  const ctx = {
    typertGateway: {
      invoke: async (request: RecordedRequest) => {
        requests.push(request)
        return 'unary-result'
      },
      stream: async (request: RecordedRequest) => {
        requests.push(request)
        return (async function* empty(): AsyncGenerator<unknown> {})()
      },
    },
    get: (name: string) => (name === 'connection' ? connection : undefined),
    effect: (body: () => () => void) => {
      disposers.push(body())
      return () => {}
    },
  } as unknown as Context
  return { ctx, requests, disposers }
}

/** A disposable Peer double, as the Host factory would return it. */
function fakePeer(): PeerLike & { dispose: ReturnType<typeof vi.fn> } {
  return {
    id: 'peer-1',
    ctx: {},
    principal: { kind: 'owner' },
    interactions: 'none',
    signal: new AbortController().signal,
    dispose: vi.fn(async () => {}),
  }
}

/** The request a call is expected to send, without its Peer. */
const REQUEST = {
  namespace: 'session',
  method: 'list',
  args: { _request: {} },
  signal: AbortSignal.timeout(1_000),
}

describe('the gateway peer', () => {
  it('asks the Host connection service for one owner Peer and reuses it', async () => {
    const peer = fakePeer()
    const createPeer = vi.fn(() => peer)
    const { ctx, requests, disposers } = fakeContext({ createPeer })

    await expect(invokeRemote(ctx, REQUEST)).resolves.toBe('unary-result')
    await streamRemote(ctx, REQUEST)
    await invokeRemote(ctx, REQUEST)

    // One Peer for the context, not one per call: it is the caller identity.
    expect(createPeer).toHaveBeenCalledTimes(1)
    expect(createPeer).toHaveBeenCalledWith({ principal: { kind: 'owner' }, interactions: 'none' })
    expect(requests).toHaveLength(3)
    for (const request of requests) expect(request.peer).toBe(peer)

    // And it is disposed with the plugin, not left registered for the process.
    expect(disposers).toHaveLength(1)
    disposers[0]?.()
    expect(peer.dispose).toHaveBeenCalledTimes(1)
  })

  it('builds a structural owner Peer when no connection service is composed', async () => {
    const { ctx, requests, disposers } = fakeContext(undefined)

    await invokeRemote(ctx, REQUEST)
    await streamRemote(ctx, REQUEST)

    const peer = requests[0]?.peer
    expect(peer).toBeDefined()
    // The identity is what the Gateway checks: trusted host code, unable to
    // answer forwarded events, alive until the plugin unloads.
    expect(peer?.principal).toEqual({ kind: 'owner' })
    expect(peer?.interactions).toBe('none')
    expect(peer?.ctx).toBe(ctx)
    expect(peer?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(peer?.signal.aborted).toBe(false)
    // The stream speaks for the same Peer as the unary call.
    expect(requests[1]?.peer).toBe(peer)

    for (const dispose of disposers) dispose()
    expect(peer?.signal.aborted).toBe(true)
  })

  it('adds the Peer without mutating or dropping the request fields', async () => {
    const { ctx, requests } = fakeContext(undefined)

    await invokeRemote(ctx, REQUEST)

    expect(requests[0]).not.toBe(REQUEST)
    expect(requests[0]).toMatchObject({
      namespace: 'session',
      method: 'list',
      args: { _request: {} },
      signal: REQUEST.signal,
    })
    expect(requests[0]?.peer).toBeDefined()
    // The caller's object is untouched, so sharing one constant across calls
    // cannot leak a stale Peer into the next context.
    expect('peer' in REQUEST).toBe(false)
  })
})
