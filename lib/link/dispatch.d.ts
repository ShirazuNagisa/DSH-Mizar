/**
 * The command half of DSH Link v1.
 *
 * Three things arrive from the desktop: an endpoint call, a service call, or an
 * answer to something the agent is waiting on. All three are dispatched here and
 * nothing else is interpreted.
 *
 * ### Why `invoke` carries the endpoint as a string
 *
 * The desktop addresses `session/list`, not "list the sessions". Splitting the
 * string and handing the halves to the gateway is the whole implementation — the
 * plugin never learns what the method means, which is what lets DSH add a
 * hundred endpoints without a plugin release.
 *
 * ### Why failures are not mapped
 *
 * A thrown DSH error crosses as `{code, message, details}`. Mapping it onto a
 * private vocabulary would mean the desktop could not see a code this plugin had
 * not been taught.
 *
 * @module dsh-mizar/link/dispatch
 */
import type { Context } from '../dsh.js';
import type { InteractionBroker } from '../bridge/interactions.js';
import type { FrameToDesktop, FrameToPlugin } from './frames.js';
/** What the dispatcher needs from its host. */
export interface DispatcherOptions {
    readonly ctx: Context;
    /** Write one frame to the desktop. `false` means the link is down. */
    readonly send: (frame: FrameToDesktop) => boolean;
    readonly broker: InteractionBroker;
    /** In-process services the desktop may call. */
    readonly services: readonly string[];
    readonly log: (message: string) => void;
    /** Log every endpoint call and how long it took. */
    readonly logCalls: boolean;
}
export declare class Dispatcher {
    #private;
    constructor(options: DispatcherOptions);
    /**
     * Handle one frame from the desktop.
     *
     * Fire-and-forget: a frame that fails produces a `result` frame with `ok:
     * false`, never an exception out of the socket handler.
     *
     * @param frame - a parsed desktop frame.
     */
    handle(frame: FrameToPlugin): void;
    /** Whether an event name is being filtered out by the desktop. */
    drops(name: string): boolean;
    /** Abort every running stream. */
    dispose(): void;
}
