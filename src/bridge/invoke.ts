/**
 * The one place a gateway call names the Peer it speaks for.
 *
 * DSH 0.2.1 made `peer` a required field of every `InvokeRemoteRequest`: the
 * Gateway no longer invents a caller identity for an in-process invocation.
 * That is a good change — the Peer is what scopes connection-lifetime
 * registrations and what the Gateway checks before dispatch — but it means the
 * eighteen call sites that used to spread `{namespace, method, args, signal}`
 * would each have to repeat the same identity. This module owns it instead, so
 * the next protocol change to the request shape is one edit rather than
 * eighteen.
 *
 * Two ways to obtain the Peer exist in 0.2.1-rc.1, and both are used here:
 *
 *   - **The sanctioned factory.** `ctx.connection.createPeer()` is documented as
 *     "Create one in-process Peer owned by the Context that read this service",
 *     and it fixes `principal: { kind: 'owner' }` — the identity in-process Host
 *     code must name, which no wire field can claim. This is the route every
 *     desktop composition takes.
 *   - **A structural owner Peer, only when `connection` is not composed.**
 *     Mizar deliberately does not put `connection` in its static `inject`:
 *     headless and SDK compositions have no browser carrier, and requiring one
 *     would stop the listener and every bridge method from loading (see
 *     `panel/api.ts`). Such a composition still has the Typert Gateway and the
 *     phone still needs session, model and permission calls, so a PeerScope is
 *     built from the pieces the interface declares. The one thing it cannot
 *     provide is a connection-owned scope key, because there is no connection
 *     layer to key against; for unary and stream invocations the Gateway only
 *     reads `principal`, `interactions` and `signal`, all of which this peer
 *     carries faithfully.
 *
 * The Peer is created once per plugin context and disposed with it. `WeakMap`
 * rather than a field on the Context keeps a reloaded plugin's old peer from
 * being resurrected by a context that outlives it.
 *
 * @module dsh-mizar/bridge/invoke
 */
import { randomUUID } from 'node:crypto'
import type { PeerScope } from '@deepseek-ai/dsh-client-connection'
import type { InvokeRemoteRequest } from '@deepseek-ai/dsh-api-gateway'
import type { Context } from '../dsh.js'

/** A gateway request before this module stamps it with its Peer. */
export type PeerlessRequest = Omit<InvokeRemoteRequest, 'peer'>

/** The slice of the Host connection service a Peer is created through. */
interface PeerFactory {
  createPeer(options: {
    readonly principal: { readonly kind: 'owner' }
    readonly interactions?: 'answer' | 'none'
  }): PeerScope
}

/** One Peer per context, created on first use and reused for every call. */
const peers = new WeakMap<Context, PeerScope>()

/**
 * The Host connection service, when this composition has one.
 *
 * `get` rather than a property read, for the reason `bridge/workspaces.ts` uses
 * the same shape: `ctx.connection` is only reachable from a plugin that
 * declared `connection` in `inject`, and declaring it would gate the whole
 * plugin on a service the panel already treats as optional.
 *
 * @param ctx - any context observing `ctx.connection`.
 * @returns the service, or `undefined` in a composition without it.
 */
function peerFactoryOf(ctx: Context): PeerFactory | undefined {
  const connection = (ctx as unknown as { get?: (name: string) => unknown }).get?.('connection')
  if (connection === null || typeof connection !== 'object') return undefined
  const candidate = connection as { createPeer?: unknown }
  return typeof candidate.createPeer === 'function' ? (connection as PeerFactory) : undefined
}

/**
 * Build the owner Peer a composition without `connection` cannot get from the
 * Host: the plugin's own context, an owner principal, no event answering, and a
 * signal that ends with the plugin.
 *
 * @param ctx - the plugin context the Peer's lifetime follows.
 * @returns the structural peer scope.
 */
function structuralPeer(ctx: Context): PeerScope {
  const lifetime = new AbortController()
  return {
    // The brand is a compile-time distinction only; the Gateway compares ids by
    // identity and never parses them, so a UUID is exactly what a Peer id is.
    id: randomUUID() as PeerScope['id'],
    ctx,
    principal: { kind: 'owner' },
    signal: lifetime.signal,
    // Mizar never answers forwarded Remote events: it has no browser-side Remote
    // assembly and must not be mistaken for one that does.
    interactions: 'none',
    dispose: async () => {
      lifetime.abort(new Error('the Mizar gateway peer was disposed'))
    },
  }
}

/**
 * The Peer every gateway call from this context speaks for.
 *
 * @param ctx - the plugin context; must still be active on first use.
 * @returns the cached Peer, created through the Host when it is available.
 */
function peerOf(ctx: Context): PeerScope {
  const cached = peers.get(ctx)
  if (cached !== undefined) return cached

  const factory = peerFactoryOf(ctx)
  const peer =
    factory === undefined
      ? structuralPeer(ctx)
      : factory.createPeer({ principal: { kind: 'owner' }, interactions: 'none' })

  peers.set(ctx, peer)
  // Registered only after the peer exists, so a failed creation leaves no
  // disposer holding a half-built object.
  ctx.effect(() => () => {
    void peer.dispose()
  }, 'mizar:gateway-peer')
  return peer
}

/**
 * Invoke one Remote method as Mizar's owner Peer.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param request - the endpoint, wire arguments and cancellation, without a Peer.
 * @returns the business result, undecoded.
 */
export async function invokeRemote(ctx: Context, request: PeerlessRequest): Promise<unknown> {
  return ctx.typertGateway.invoke({ ...request, peer: peerOf(ctx) })
}

/**
 * Open one Remote stream as Mizar's owner Peer.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param request - the endpoint, wire arguments and cancellation, without a Peer.
 * @returns the stream results.
 */
export async function streamRemote(
  ctx: Context,
  request: PeerlessRequest,
): Promise<AsyncIterable<unknown>> {
  return ctx.typertGateway.stream({ ...request, peer: peerOf(ctx) })
}
