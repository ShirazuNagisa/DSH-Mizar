import { type FrameToDesktop, type FrameToPlugin, type HostIdentity, type PluginIdentity, type WelcomeFrame } from './frames.js';
/** Everything the client needs from its host. */
export interface LinkClientOptions {
    /** Path to the desktop's endpoint file, possibly with `~`. */
    readonly endpointFile: string;
    /** Built fresh on every handshake, so the endpoint list is never stale. */
    readonly identity: () => {
        readonly plugin: PluginIdentity;
        readonly dsh: HostIdentity;
        readonly endpoints: readonly string[];
        readonly services: readonly string[];
    };
    /** One frame from the desktop, after the handshake. */
    readonly onFrame: (frame: FrameToPlugin) => void;
    /** The handshake completed; the desktop can be spoken to. */
    readonly onUp: (welcome: WelcomeFrame) => void;
    /** The connection ended, for any reason. */
    readonly onDown: (reason: string) => void;
    /** Operator-facing diagnostics. */
    readonly log: (message: string) => void;
    readonly reconnect: {
        readonly baseMs: number;
        readonly maxMs: number;
        readonly heartbeatMs: number;
    };
}
export declare class LinkClient {
    #private;
    constructor(options: LinkClientOptions);
    /** Whether the handshake has completed on a live socket. */
    get connected(): boolean;
    /** Begin dialling. Idempotent: a second call while running is a no-op. */
    start(): void;
    /**
     * Stop dialling and drop the socket.
     *
     * Synchronous on purpose: it is called from an effect cleanup, and the caller
     * must not be left with a socket that outlives the plugin.
     */
    stop(): void;
    /**
     * Send one frame, if the link is up.
     *
     * @param frame - what to send.
     * @returns whether it was written. `false` is not an error: a notification
     *   that cannot be delivered is dropped, and the state it described is still
     *   readable through `invoke`.
     */
    send(frame: FrameToDesktop): boolean;
}
