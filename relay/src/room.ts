/**
 * Deriving a room from a tunnel token.
 *
 * The room is what a phone puts in its URL, so it travels: into a QR code, into
 * the app's stored pairing, into a reverse proxy's access log. The tunnel token
 * does none of that -- it is the capability that lets a process attach itself as
 * somebody's Mac, and it stays in the plugin's config and the relay's config.
 *
 * Separating the two is the point. A leaked room lets a stranger reach a
 * plugin's unauthenticated endpoints, which are two: `/hello` and `/pair`, and
 * `/pair` still demands a live single-use code and is rate limited. A leaked
 * token would let a stranger *be* the Mac.
 *
 * The relay derives the room and tells the Mac; the Mac never invents one. That
 * is why this function exists in exactly one package.
 *
 * @module dsh-mizar-relay/room
 */
import { createHash, timingSafeEqual } from 'node:crypto'

/** Crockford base32: digits plus letters excluding I, L, O and U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/** Characters in a room id. Twelve base32 characters carry 60 bits. */
const ROOM_LENGTH = 12

/**
 * Encode bytes as Crockford base32.
 *
 * @param bytes - the input.
 * @returns the encoded text.
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
 * The room a token serves.
 *
 * @param token - the tunnel token.
 * @returns the room id.
 */
export function deriveRoom(token: string): string {
  const digest = createHash('sha256').update(`dsh-mizar-relay/room:${token}`, 'utf8').digest()
  return base32(digest.subarray(0, 8)).slice(0, ROOM_LENGTH)
}

/**
 * Compare two secrets without leaking where they differ.
 *
 * `===` on a token returns as soon as it finds a difference, which times an
 * attacker's guesses. The length check is not a leak worth avoiding: token
 * lengths are fixed by the generator.
 *
 * @param a - one value.
 * @param b - the other.
 * @returns whether they are equal.
 */
export function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}
