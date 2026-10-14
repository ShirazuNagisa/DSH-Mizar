/** Characters in a pairing code. 8 base32 characters carry 40 bits. */
export declare const CODE_LENGTH = 8;
/** Default lifetime of an issued code, in seconds. */
export declare const DEFAULT_CODE_TTL_SECONDS = 300;
/** The persisted pairing slot. `expiresAt: 0` means no code is outstanding. */
export interface PairingSlot {
    /** Counter folded into the code derivation; advances on issue and on redeem. */
    readonly epoch: number;
    /**
     * Epoch milliseconds at which the outstanding code stops being accepted, or
     * `0` when none is outstanding.
     *
     * The deadline lives in the slot rather than being passed to
     * {@link redeemCode} as a TTL. Storing it once removes any way for the
     * issuing and redeeming sides to disagree and silently extend a code's life.
     */
    readonly expiresAt: number;
}
/** An outstanding pairing code. */
export interface IssuedCode {
    /** The display form, grouped for reading aloud. */
    readonly display: string;
    /** The canonical form to compare against, uppercase without separators. */
    readonly code: string;
    /** The slot to persist; carries the deadline in `expiresAt`. */
    readonly slot: PairingSlot;
}
/** Outcome of redeeming a code. */
export type RedeemResult = {
    readonly ok: true;
    readonly slot: PairingSlot;
} | {
    readonly ok: false;
    readonly reason: 'no-code' | 'consumed' | 'expired' | 'mismatch';
};
/**
 * Encode bytes as Crockford base32.
 * @param bytes - the bytes to encode.
 * @returns the encoded string.
 */
export declare function base32(bytes: Uint8Array): string;
/**
 * Normalise a user-entered code.
 *
 * Accepts lowercase, spaces, and hyphens; maps the characters Crockford treats
 * as equivalent (`I`/`L` to `1`, `O` to `0`).
 *
 * @param input - the raw text.
 * @returns the canonical uppercase form.
 */
export declare function normalizeCode(input: string): string;
/**
 * Derive the code for one host secret and epoch.
 * @param hostSecret - the per-installation secret.
 * @param epoch - the pairing counter.
 * @returns a {@link CODE_LENGTH}-character code.
 */
export declare function deriveCode(hostSecret: Uint8Array, epoch: number): string;
/**
 * Group a code for display, four characters at a time.
 * @param code - the canonical code.
 * @returns the display form, for example `AB2C-D3EF`.
 */
export declare function displayCode(code: string): string;
/**
 * Issue a fresh pairing code.
 *
 * Issuing invalidates any outstanding code: the epoch advances, so a code handed
 * out a moment ago stops working the instant a new one is generated.
 *
 * @param hostSecret - the per-installation secret.
 * @param previous - the outstanding slot, if any.
 * @param now - current epoch milliseconds.
 * @param ttlSeconds - how long the code stays valid.
 * @returns the issued code and the slot to persist.
 */
export declare function issueCode(hostSecret: Uint8Array, previous: PairingSlot | null, now?: number, ttlSeconds?: number): IssuedCode;
/**
 * Redeem a pairing code.
 *
 * Comparison is constant-time over equal-length buffers, so the response time
 * does not reveal how much of a wrong guess was correct.
 *
 * `consumed` and `expired` are reported separately here because the audit log is
 * the operator's only forensic trail and "someone replayed a code" is a
 * different story from "the code timed out". Callers must still answer both with
 * the same client-facing code — telling a caller which of the two it hit turns
 * the endpoint into an oracle.
 *
 * @param hostSecret - the per-installation secret.
 * @param slot - the outstanding pairing slot, carrying its own deadline.
 * @param input - the code the phone sent.
 * @param now - current epoch milliseconds.
 * @returns whether the code was redeemed, and the cleared slot when it was.
 */
export declare function redeemCode(hostSecret: Uint8Array, slot: PairingSlot | null, input: string, now?: number): RedeemResult;
/**
 * Generate a host secret with full entropy.
 * @returns 32 random bytes.
 */
export declare function generateHostSecret(): Uint8Array;
/**
 * A counted, time-windowed limiter for authentication attempts.
 *
 * Pairing is the only unauthenticated endpoint, so it is the only place an
 * attacker can guess. A fixed window is deliberate: it must be cheap enough to
 * run on every attempt and simple enough to reason about.
 */
export declare class RateLimiter {
    #private;
    private readonly limit;
    private readonly windowMs;
    /**
     * @param limit - attempts allowed per window, per key.
     * @param windowMs - window length in milliseconds.
     */
    constructor(limit: number, windowMs: number);
    /**
     * Record one attempt and report whether it may proceed.
     * @param key - the caller identity, for example a remote address.
     * @param now - current epoch milliseconds.
     * @returns whether the attempt is within the limit, and how long to wait when it is not.
     */
    check(key: string, now?: number): {
        allowed: boolean;
        retryAfterMs: number;
    };
    /**
     * Drop windows that have expired.
     * @param now - current epoch milliseconds.
     */
    prune(now?: number): void;
}
