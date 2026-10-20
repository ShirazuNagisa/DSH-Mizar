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

/** Something that can be shut down once, asynchronously. */
export interface Mounted {
  /** Release the listener, the tunnel and anything else this mount owns. */
  dispose(): Promise<void>
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
  #tail: Promise<unknown> = Promise.resolve()
  #active: Mounted | null = null

  /** Run one task after everything queued before it. */
  #enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task)
    this.#tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
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
  start<T extends Mounted>(create: () => Promise<T | null>): Promise<T | null> {
    return this.#enqueue(async () => {
      const previous = this.#active
      this.#active = null
      if (previous !== null) await previous.dispose()
      const created = await create()
      this.#active = created
      return created
    })
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
  stop(mounted: Mounted | null): Promise<void> {
    return this.#enqueue(async () => {
      if (mounted === null || this.#active !== mounted) return
      this.#active = null
      await mounted.dispose()
    })
  }

  /** The mount this process is running, when it has one. */
  get active(): Mounted | null {
    return this.#active
  }
}
