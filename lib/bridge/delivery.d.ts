/**
 * What each phone has already been sent.
 *
 * A refresh used to re-read the tail of a session and put all of it back on the
 * wire: the phone already held every record in the page, and paid for them again
 * on every pull, every reconnect and every poll. The phone's own cursor answers
 * that whenever it sends one -- `session.messages` takes an `afterSeq` and the
 * answer starts after it -- but a request that carries no cursor has always been
 * answered with the whole page.
 *
 * This is the other half: the positions this plugin has actually put on the wire
 * to a given device, so a later request without a cursor can still be answered
 * with only what is new. It is per device because two phones read at their own
 * pace, and per session because a phone may hold one conversation further back
 * than another.
 *
 * Three rules keep it honest:
 *
 *   - A position is recorded only after the frame carrying it was written to an
 *     open socket. A response refused for size, or written to a socket that had
 *     already closed, is not something the phone has.
 *   - The phone's own cursor always wins when it sends one. It is evidence of
 *     what the phone holds; this ledger is only an inference. A claim that is
 *     lower than the ledger (a cleared cache, a reinstall) must be able to pull
 *     the answer back, or the app would show a conversation with its middle
 *     missing.
 *   - An explicit `null` cursor means "I hold nothing" and must bypass the
 *     ledger entirely, which is how a phone that lost its cache asks for a full
 *     page without lying about what it has.
 *
 * The ledger lives for as long as the plugin mount. It is not persisted: after a
 * restart the phones send their own cursors, and a ledger reconstructed from
 * disk would be a claim about devices that may have moved on -- the kind of
 * stale inference that silently drops history.
 *
 * @module dsh-mizar/bridge/delivery
 */
/**
 * The log position a record sits at, when it names one.
 *
 * Records arrive two ways: wrapped by the gateway as `{type: 'event', event:
 * {seq, …}}`, and unwrapped as the log writes them, with `seq` at the top level.
 * Both are read, for the same reason the rest of the bridge reads both -- a
 * position missed here is a record re-sent forever.
 *
 * @param record - one log record.
 * @returns the position, or `null` when the record carries none.
 */
export declare function recordSeq(record: unknown): number | null;
/**
 * Positions already delivered, by device and session.
 *
 * Not a cache of pages: the only thing kept is the highest log position that has
 * been written to the device. Everything up to it is assumed present, which is
 * the same assumption the phone's own `afterSeq` makes.
 */
export declare class DeliveryLedger {
    #private;
    /**
     * The highest position delivered to one device for one session.
     *
     * @param deviceId - the authenticated device.
     * @param sessionId - the session.
     * @returns the position, or `undefined` when nothing is remembered.
     */
    deliveredThrough(deviceId: string, sessionId: string): number | undefined;
    /**
     * Remember that a device has been sent everything through `seq`.
     *
     * Only ever moves forward: a late, older page (a scroll back through history)
     * must not pull the watermark down and make the next refresh re-send what the
     * phone already read.
     *
     * @param deviceId - the authenticated device.
     * @param sessionId - the session.
     * @param seq - the highest position in what was delivered.
     */
    record(deviceId: string, sessionId: string, seq: number): void;
    /**
     * Remember a `session.messages` result that was actually delivered.
     *
     * The page's `asOfSeq` is deliberately not used: it is the log cut the page was
     * taken at, and the byte budget may have trimmed older records out of that
     * window. Recording the cut would then claim the phone holds records that were
     * never sent. The highest position among the records that did travel is the
     * only claim this can honestly make.
     *
     * @param deviceId - the authenticated device.
     * @param result - the value returned to the wire.
     */
    recordResult(deviceId: string, result: unknown): void;
    /**
     * Forget everything one device was sent.
     *
     * Called when the device is revoked. A re-paired phone gets a fresh device id,
     * so its old positions would be unreachable anyway; dropping them keeps the
     * map from holding entries nothing can ask for.
     *
     * @param deviceId - the device that was removed.
     */
    forgetDevice(deviceId: string): void;
}
