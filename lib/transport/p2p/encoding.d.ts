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
/**
 * URL-safe base64 without padding.
 * @param data - the bytes to encode.
 * @returns the base64url text.
 */
export declare function base64URLEncode(data: Uint8Array): string;
/**
 * The inverse of {@link base64URLEncode}.
 * @param text - the base64url text.
 * @returns the bytes, or `null` when the text is not base64url.
 */
export declare function base64URLDecode(text: string): Buffer | null;
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
export declare function crockfordBase32(data: Uint8Array, length: number): string;
