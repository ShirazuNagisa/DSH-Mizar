import type { Context } from '../dsh.js';
import type { DeliveryLedger } from './delivery.js';
import { InteractionBroker } from './interactions.js';
import type { PushBinding } from '../push/binding.js';
import { UploadStore } from './uploads.js';
/** Per-connection facts handed to a method. */
export interface MethodContext {
    /** The authenticated device's id. */
    readonly deviceId: string;
    /** The authenticated device's display name. */
    readonly deviceName: string;
    /** The remote address the request arrived from. */
    readonly remote: string;
}
/** A wire method implementation. */
export type MethodHandler = (payload: unknown, context: MethodContext) => Promise<unknown>;
/** What the bridge needs from its host to answer `host.info`. */
export interface HostFacts {
    readonly hostId: string;
    readonly hostName: string;
    readonly home: string;
    readonly protocolVersion: number;
    /**
     * The `host:port` authorities the listener is bound to.
     *
     * A function, not an array, because it is read when `host.info` is answered
     * rather than when the table is built: a rebind moves the listener to a
     * different set of addresses underneath, and a cached list would keep naming
     * where the host used to listen -- which is worse than saying nothing, because
     * a phone probes these directly.
     *
     * Optional so compositions and tests from before the field keep compiling.
     * Absent means the answer carries no `addresses` key at all: "this host cannot
     * say" and "this host has no usable address" are different answers, and only
     * the second justifies a phone giving up on the direct route.
     */
    readonly authorities?: () => readonly string[];
}
/**
 * Build the method table for one plugin mount.
 *
 * @param ctx - the plugin context, used for every DSH call.
 * @param facts - host identity reported to clients, including the state directory
 *   the upload staging area lives under and, when the host can say, the bound
 *   listener addresses.
 * @param broker - the interaction broker holding pending approvals and questions.
 * @param push - where a device's notification endpoint is recorded, when the host
 *   has push at all. Absent in compositions without a relay.
 * @param delivery - what each device has already been sent, when the host keeps
 *   it. Absent leaves every page full: a composition without it still answers,
 *   it just does not save the phone the bytes it already read.
 * @param uploads - the attachment staging store. Absent builds one under
 *   `facts.home`; a caller that wants to share or test one may pass it.
 * @returns the table, keyed by wire method name.
 */
export declare function createMethodTable(ctx: Context, facts: HostFacts, broker: InteractionBroker, push?: PushBinding, delivery?: DeliveryLedger, uploads?: UploadStore): Record<string, MethodHandler>;
