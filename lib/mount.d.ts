/**
 * The one registry every copy of this plugin in a process shares.
 *
 * Module-level state is not enough: the plugin can be loaded more than once in
 * one process, and each load gets its own copy of this module -- which is how a
 * single DSH process ended up with eight Mizar listeners (19390 through 19397)
 * after 0.8.6 shipped a module-level registry. Each copy saw an empty slot and
 * bound its own port, so the port a phone had saved was always one generation
 * behind.
 *
 * `globalThis` is shared by every copy in the process, and `Symbol.for` gives
 * the key a stable identity across them. The registry therefore outlives a
 * module copy exactly as long as the process does, which is the lifetime that
 * matters for a listening port.
 *
 * @returns the process-wide registry.
 */
export declare function sharedMountRegistry(): MountRegistry;
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
