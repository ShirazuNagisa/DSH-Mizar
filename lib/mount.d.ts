/** Something that can be shut down once, asynchronously. */
export interface Mounted {
    /** Release the listener, the tunnel and anything else this mount owns. */
    dispose(): Promise<void>;
}
/**
 * The serialized, single-instance mount slot.
 *
 * `start` disposes the running mount before creating the next; `stop` disposes
 * one mount without disturbing a newer one. Both run on one chain, so the order
 * calls were made in is the order they act in -- which is what keeps a
 * replacement from binding while the old listener still owns the port.
 */
export declare class MountRegistry {
    #private;
    /**
     * Start a mount after stopping the one already running.
     *
     * A creation that fails (or that decides it is unwanted and returns `null`)
     * leaves the slot empty rather than with a half-mounted object.
     *
     * @param create - makes the mount; may return `null` to mount nothing.
     * @returns the created mount, or `null`.
     */
    start<T extends Mounted>(create: () => Promise<T | null>): Promise<T | null>;
    /**
     * Stop the running mount.
     *
     * `null` is a no-op, and so is a mount a newer `start` has already replaced:
     * that replacement disposed it before creating its own, and disposing it a
     * second time would only run a shutdown that is already complete.
     *
     * @param mounted - the mount to dispose, when it is the one still running.
     */
    stop(mounted: Mounted | null): Promise<void>;
    /** The mount this process is running, when it has one. */
    get active(): Mounted | null;
}
