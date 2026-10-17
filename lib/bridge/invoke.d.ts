import type { InvokeRemoteRequest } from '@deepseek-ai/dsh-api-gateway';
import type { Context } from '../dsh.js';
/** A gateway request before this module stamps it with its Peer. */
export type PeerlessRequest = Omit<InvokeRemoteRequest, 'peer'>;
/**
 * Invoke one Remote method as Mizar's owner Peer.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param request - the endpoint, wire arguments and cancellation, without a Peer.
 * @returns the business result, undecoded.
 */
export declare function invokeRemote(ctx: Context, request: PeerlessRequest): Promise<unknown>;
/**
 * Open one Remote stream as Mizar's owner Peer.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param request - the endpoint, wire arguments and cancellation, without a Peer.
 * @returns the stream results.
 */
export declare function streamRemote(ctx: Context, request: PeerlessRequest): Promise<AsyncIterable<unknown>>;
