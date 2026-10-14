/**
 * Pairing codes.
 *
 * A pairing code is the one short secret a human moves from the Mac to the
 * phone, so it has to be short enough to scan and type, and still be useless to
 * anyone who did not see it. Two properties get that:
 *
 *   - **Derived, not random.** The code is an HMAC of a single-use counter under
 *     the host secret, so it cannot be guessed without the secret and never has
 *     to be stored — the persisted state keeps only a counter and a timestamp.
 *   - **Single use, with a deadline.** Redeeming a code advances the counter and
 *     clears the deadline, so a replayed code fails. Rate limiting is a separate
 *     layer; see {@link RateLimiter}.
 *
 * The alphabet is Crockford base32: no `I`, `L`, `O` or `U`, so a code survives
 * being read aloud or mistyped by hand.
 *
 * @module dsh-mizar/auth/pairing
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Crockford base32 alphabet: digits plus letters excluding I, L, O and U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Characters in a pairing code. 8 base32 characters carry 40 bits. */
export const CODE_LENGTH = 8

/** Default lifetime of an issued code, in seconds. */
export const DEFAULT_CODE_TTL_SECONDS = 300

/** The persisted pairing slot. `expiresAt: 0` means no code is outstanding. */
export interface PairingSlot {
  /** Counter folded into the code derivation; advances on issue and on redeem. */
  readonly epoch: number
  /**
   * Epoch milliseconds at which the outstanding code stops being accepted, or
   * `0` when none is outstanding.
   *
   * The deadline lives in the slot rather than being passed to
   * {@link redeemCode} as a TTL. Storing it once removes any way for the
   * issuing and redeeming sides to disagree and silently extend a code's life.
   */
  readonly expiresAt: number
}

/** An outstanding pairing code. */
export interface IssuedCode {
  /** The display form, grouped for reading aloud. */
  readonly display: string
  /** The canonical form to compare against, uppercase without separators. */
  readonly code: string
  /** The slot to persist; carries the deadline in `expiresAt`. */
  readonly slot: PairingSlot
}

/** Outcome of redeeming a code. */
export type RedeemResult =
  | { readonly ok: true; readonly slot: PairingSlot }
  | { readonly ok: false; readonly reason: 'no-code' | 'consumed' | 'expired' | 'mismatch' }

/**
 * Encode bytes as Crockford base32.
 * @param bytes - the bytes to encode.
 * @returns the encoded string.
 */
export function base32(bytes: Uint8Array): string {
  let out = ''
  let buffer = 0
  let bits = 0
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += ALPHABET[(buffer >>> bits) & 31] ?? ''
    }
  }
  if (bits > 0) out += ALPHABET[(buffer << (5 - bits)) & 31] ?? ''
  return out
}

/**
 * Normalise a user-entered code.
 *
 * Accepts lowercase, spaces, and hyphens; maps the characters Crockford treats
 * as equivalent (`I`/`L` to `1`, `O` to `0`).
 *
 * @param input - the raw text.
 * @returns the canonical uppercase form.
 */
export function normalizeCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0')
}

/**
 * Derive the code for one host secret and epoch.
 * @param hostSecret - the per-installation secret.
 * @param epoch - the pairing counter.
 * @returns a {@link CODE_LENGTH}-character code.
 */
export function deriveCode(hostSecret: Uint8Array, epoch: number): string {
  const mac = createHmac('sha256', hostSecret).update(`mizar/pair/${epoch}`).digest()
  return base32(mac).slice(0, CODE_LENGTH)
}

/**
 * Group a code for display, four characters at a time.
 * @param code - the canonical code.
 * @returns the display form, for example `AB2C-D3EF`.
 */
export function displayCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-')
}

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
export function issueCode(
  hostSecret: Uint8Array,
  previous: PairingSlot | null,
  now: number = Date.now(),
  ttlSeconds: number = DEFAULT_CODE_TTL_SECONDS,
): IssuedCode {
  const epoch = (previous?.epoch ?? 0) + 1
  const code = deriveCode(hostSecret, epoch)
  return {
    code,
    display: displayCode(code),
    slot: { epoch, expiresAt: now + ttlSeconds * 1000 },
  }
}

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
export function redeemCode(
  hostSecret: Uint8Array,
  slot: PairingSlot | null,
  input: string,
  now: number = Date.now(),
): RedeemResult {
  if (slot === null) return { ok: false, reason: 'no-code' }
  // A cleared deadline means the code was already redeemed and the epoch has
  // moved on, so this is a replay rather than a timeout.
  if (slot.expiresAt === 0) return { ok: false, reason: 'consumed' }
  if (now > slot.expiresAt) return { ok: false, reason: 'expired' }

  const expected = deriveCode(hostSecret, slot.epoch)
  const provided = normalizeCode(input)
  if (provided.length !== expected.length) return { ok: false, reason: 'mismatch' }

  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(provided, 'utf8')
  if (!timingSafeEqual(a, b)) return { ok: false, reason: 'mismatch' }

  // Single use: advance the epoch so the redeemed code cannot be replayed, and
  // clear the deadline so no code is outstanding.
  return { ok: true, slot: { epoch: slot.epoch + 1, expiresAt: 0 } }
}

/**
 * Generate a host secret with full entropy.
 * @returns 32 random bytes.
 */
export function generateHostSecret(): Uint8Array {
  return new Uint8Array(randomBytes(32))
}

/**
 * A counted, time-windowed limiter for authentication attempts.
 *
 * Pairing is the only unauthenticated endpoint, so it is the only place an
 * attacker can guess. A fixed window is deliberate: it must be cheap enough to
 * run on every attempt and simple enough to reason about.
 */
export class RateLimiter {
  readonly #attempts = new Map<string, { count: number; windowStart: number }>()

  /**
   * @param limit - attempts allowed per window, per key.
   * @param windowMs - window length in milliseconds.
   */
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /**
   * Record one attempt and report whether it may proceed.
   * @param key - the caller identity, for example a remote address.
   * @param now - current epoch milliseconds.
   * @returns whether the attempt is within the limit, and how long to wait when it is not.
   */
  check(key: string, now: number = Date.now()): { allowed: boolean; retryAfterMs: number } {
    const entry = this.#attempts.get(key)
    if (entry === undefined || now - entry.windowStart >= this.windowMs) {
      this.#attempts.set(key, { count: 1, windowStart: now })
      return { allowed: true, retryAfterMs: 0 }
    }
    entry.count += 1
    if (entry.count > this.limit) {
      return { allowed: false, retryAfterMs: entry.windowStart + this.windowMs - now }
    }
    return { allowed: true, retryAfterMs: 0 }
  }

  /**
   * Drop windows that have expired.
   * @param now - current epoch milliseconds.
   */
  prune(now: number = Date.now()): void {
    for (const [key, entry] of this.#attempts) {
      if (now - entry.windowStart >= this.windowMs) this.#attempts.delete(key)
    }
  }
}
