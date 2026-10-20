//
//  mount.ts
//  MizarKit
//
//  One set of Mizar resources per process, mounted in order.
//
//  The reported failure: a phone could not reach its computer at all, and the
//  machine had three live Mizar listeners in one DSH process — ports 19390,
//  19391 and 19392, each belonging to a different plugin mount. The first one
//  held the pairing's address, the current one held the relay replay target, and
//  the port a phone had saved in its pairing was from neither of the two that
//  still answered. A port that moves is a pairing that rots.
//
//  DSH may compose, reload or re-apply a bundle more than once, and each mount
//  used to bind its own listener without the previous one necessarily being
//  released first. The plugin cannot order DSH's lifecycle, so it enforces the
//  invariant it owns instead: **at most one mount runs at a time, and a new one
//  starts only after the previous one has finished shutting down.** Every start
//  and stop goes through one promise chain, so concurrent applies queue rather
//  than race.
//
//  Pure, so the ordering is tested without a plugin host or an open port.
//
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
export function sharedMountRegistry() {
    const key = Symbol.for('dsh-mizar.mount-registry');
    const bag = globalThis;
    let registry = bag[key];
    if (registry === undefined) {
        registry = new MountRegistry();
        bag[key] = registry;
    }
    return registry;
}
/**
 * The serialized, single-instance mount slot.
 *
 * `start` disposes the running mount before creating the next; `stop` disposes
 * one mount without disturbing a newer one. Both run on one chain, so the order
 * calls were made in is the order they act in -- which is what keeps a
 * replacement from binding while the old listener still owns the port.
 */
export class MountRegistry {
    /** Serializes every start and stop. Never rejects; failures are per task. */
    #tail = Promise.resolve();
    #active = null;
    /** Run one task after everything queued before it. */
    #enqueue(task) {
        const run = this.#tail.then(task, task);
        this.#tail = run.then(() => undefined, () => undefined);
        return run;
    }
    /**
     * Start a mount after stopping the one already running.
     *
     * A creation that fails (or that decides it is unwanted and returns `null`)
     * leaves the slot empty rather than with a half-mounted object.
     *
     * @param create - makes the mount; may return `null` to mount nothing.
     * @returns the created mount, or `null`.
     */
    start(create) {
        return this.#enqueue(async () => {
            const previous = this.#active;
            this.#active = null;
            if (previous !== null)
                await previous.dispose();
            const created = await create();
            this.#active = created;
            return created;
        });
    }
    /**
     * Stop the running mount.
     *
     * `null` is a no-op, and so is a mount a newer `start` has already replaced:
     * that replacement disposed it before creating its own, and disposing it a
     * second time would only run a shutdown that is already complete.
     *
     * @param mounted - the mount to dispose, when it is the one still running.
     */
    stop(mounted) {
        return this.#enqueue(async () => {
            if (mounted === null || this.#active !== mounted)
                return;
            this.#active = null;
            await mounted.dispose();
        });
    }
    /** The mount this process is running, when it has one. */
    get active() {
        return this.#active;
    }
}
