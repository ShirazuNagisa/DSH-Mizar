/**
 * The two text encodings MizarNet puts on the wire.
 *
 * Both exist to keep the kernel's small control payloads — an endpoint id, a
 * ticket, a candidate — inside a text frame or a URL query without escaping.
 * Base64url because a ticket has to survive a query string and a JSON string
 * unchanged; Crockford base32 because an endpoint id gets read aloud and typed
 * by a human eventually, and Crockford has no I, L, O or U to confuse a reader.
 *
 * These must produce exactly what `MizarNetCodec.swift` produces — an endpoint
 * id computed differently on the two sides is an endpoint the other side cannot
 * dial. The fixture (`protocol/fixtures/p2p-wire.json`) pins both encodings.
 *
 * @module dsh-mizar/transport/p2p/encoding
 */
/** Crockford's base32 alphabet: no I, L, O or U. */
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/**
 * URL-safe base64 without padding.
 * @param data - the bytes to encode.
 * @returns the base64url text.
 */
export function base64URLEncode(data) {
    return Buffer.from(data).toString('base64url');
}
/**
 * The inverse of {@link base64URLEncode}.
 * @param text - the base64url text.
 * @returns the bytes, or `null` when the text is not base64url.
 */
export function base64URLDecode(text) {
    // Node's decoder is lenient about the alphabet but strict about length; a
    // ticket that does not decode is a broken ticket, and every caller treats
    // `null` as "broken" rather than guessing.
    if (!/^[A-Za-z0-9_-]*$/.test(text))
        return null;
    const decoded = Buffer.from(text, 'base64url');
    // Re-encoding is the only reliable check: `Buffer.from` accepts truncated
    // input and silently drops the remainder.
    return base64URLEncode(decoded) === text ? decoded : null;
}
/**
 * The first `length` Crockford base32 characters of `data`.
 *
 * The bit stream is the same one the Swift side walks — most significant bit
 * first, five bits per character, stopping as soon as `length` characters
 * exist. A 32-byte key yields 51 characters, so any prefix is available.
 *
 * @param data - the bytes to encode.
 * @param length - how many characters to keep.
 * @returns the prefix, in Crockford base32.
 */
export function crockfordBase32(data, length) {
    let value = 0;
    let bits = 0;
    let output = '';
    for (const byte of data) {
        // `value` never needs more than 12 bits at a time: at most 7 bits carried
        // over plus the 8 just read, so a plain number is safe here.
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5 && output.length < length) {
            bits -= 5;
            output += CROCKFORD_ALPHABET[(value >> bits) & 0x1f];
        }
        if (output.length >= length)
            break;
    }
    return output;
}
