/**
 * The MizarNet handshake and per-packet seal, in TypeScript.
 *
 * The same stripped-down Noise IK the Swift kernel implements:
 *
 *  - a static Ed25519 identity per endpoint, *derived* from a secret the
 *    pairing already established (the host secret, or the phone's device
 *    token) rather than generated and stored;
 *  - a fresh X25519 ephemeral per connection, signed with the static identity,
 *    so the peer that answers is provably the endpoint the ticket named;
 *  - session keys from the ephemeral-ephemeral agreement through HKDF, one key
 *    per direction, salted with both endpoint ids so the session is bound to
 *    *these two* peers;
 *  - ChaCha20-Poly1305 per packet, nonce = packet number, header as
 *    authenticated data.
 *
 * Every constant here is part of the wire contract: change an info string and
 * every existing session stops opening. `protocol/fixtures/p2p-wire.json` pins
 * them against the Swift implementation.
 *
 * @module dsh-mizar/transport/p2p/crypto
 */
import { type KeyObject } from 'node:crypto';
/** The info string mixed into the session salt. Part of the wire contract. */
export declare const SESSION_SALT_INFO = "mizar-net/session/v1";
/** HKDF info for the dialler→acceptor key. Part of the wire contract. */
export declare const DIALER_TO_ACCEPTOR_INFO = "mizar-net/dialer-to-acceptor/v1";
/** HKDF info for the acceptor→dialler key. Part of the wire contract. */
export declare const ACCEPTOR_TO_DIALER_INFO = "mizar-net/acceptor-to-dialer/v1";
/** The AEAD's tag length. Also the smallest possible sealed payload. */
export declare const TAG_LENGTH = 16;
/** What a derived key is for. Part of the wire contract, like the info strings. */
export type IdentityPurpose = 'host' | 'device';
/** An endpoint's key pair, and the two forms of its name. */
export interface EndpointIdentity {
    /** The base64url Ed25519 public key. 43 characters. What a ticket names. */
    readonly endpointId: string;
    /** 8 Crockford base32 characters — enough to tell two endpoints apart in a log. */
    readonly shortId: string;
    /** The raw 32-byte public key. */
    readonly publicKey: Buffer;
    /**
     * Sign a message with the endpoint key.
     * @param message - the bytes to sign.
     * @returns the 64-byte signature.
     */
    sign(message: Uint8Array): Buffer;
}
/** An X25519 key pair, ephemeral by convention. */
export interface EphemeralKeyPair {
    /** The raw 32-byte public key, as it travels in a hello. */
    readonly publicKey: Buffer;
    /** The private key, kept for the agreement. */
    readonly privateKey: KeyObject;
}
/**
 * Derive an identity from a secret that already exists.
 *
 * `SHA-256(secret ‖ purpose ‖ 0x01)`, the same construction and the same
 * purpose strings as the Swift side. Derivation rather than generation is what
 * lets an endpoint id survive a reinstall without storing a new credential:
 * whoever holds the host secret holds the host's endpoint key.
 *
 * @param secret - high-entropy bytes: a host secret, or the SHA-256 of a device token.
 * @param purpose - what the key is for.
 * @returns the identity.
 */
export declare function deriveIdentity(secret: Uint8Array, purpose: IdentityPurpose): EndpointIdentity;
/**
 * Verify a signature against an endpoint id.
 *
 * @param signature - the 64-byte signature.
 * @param message - the bytes that were signed.
 * @param endpointId - the base64url public key to check against.
 * @returns whether the signature is valid for that key and message.
 */
export declare function verifySignature(signature: Uint8Array, message: Uint8Array, endpointId: string): boolean;
/**
 * A fresh ephemeral X25519 key pair.
 * @returns the pair, with the public key already raw.
 */
export declare function ephemeralKeyPair(): EphemeralKeyPair;
/**
 * Rebuild a key object from a raw X25519 public key that arrived in a hello.
 * @param raw - the 32-byte key.
 * @returns the key object to agree against.
 */
export declare function x25519PublicKey(raw: Uint8Array): KeyObject;
/**
 * The ephemeral-ephemeral agreement.
 * @param local - this side's ephemeral private key.
 * @param remoteRawPublicKey - the peer's ephemeral public key from its hello.
 * @returns the 32-byte shared secret.
 */
export declare function agree(local: KeyObject, remoteRawPublicKey: Uint8Array): Buffer;
/**
 * The salt that binds a session to its two peers.
 *
 * Sorted by endpoint id so both sides compute the same salt without
 * negotiating who is "first". The NUL after each id keeps `"ab"+"c"` from
 * hashing the same as `"a"+"bc"`.
 *
 * @param localEndpointId - this side's endpoint id.
 * @param remoteEndpointId - the peer's endpoint id.
 * @returns the 32-byte salt.
 */
export declare function sessionSalt(localEndpointId: string, remoteEndpointId: string): Buffer;
/** The pair of session keys, from this side's point of view. */
export interface SessionKeys {
    /** The key this side seals with. */
    readonly seal: Buffer;
    /** The key it expects the peer's packets under. */
    readonly open: Buffer;
    /** The key the dialler seals with, whichever side this is. */
    readonly dialerToAcceptor: Buffer;
    /** The key the acceptor seals with, whichever side this is. */
    readonly acceptorToDialer: Buffer;
}
/**
 * The two session keys, one per direction.
 *
 * Both are derived on both sides and then selected by role — deriving only
 * one's own direction would need a negotiation the handshake does not have.
 *
 * @param sharedSecret - the ephemeral-ephemeral agreement.
 * @param salt - from {@link sessionSalt}.
 * @param localIsDialer - whether this side dialled.
 * @returns the keys, in both orientations.
 */
export declare function sessionKeys(sharedSecret: Uint8Array, salt: Uint8Array, localIsDialer: boolean): SessionKeys;
/**
 * The nonce for a packet number: four zero bytes, then the number as eight
 * big-endian bytes.
 *
 * The packet number *is* the nonce — nothing is carried on the wire for it, and
 * there is no nonce to forge. The 2^32 space per key is far beyond any session
 * this protocol expects to hold, and the receiver's window rejects replays.
 *
 * @param packetNumber - the packet's number.
 * @returns the 12-byte nonce.
 */
export declare function packetNonce(packetNumber: number): Buffer;
/**
 * Seal one packet's payload.
 *
 * @param plaintext - the chunk.
 * @param key - this side's seal key.
 * @param packetNumber - the packet's number, which is also its nonce.
 * @param authenticatedData - the header bytes that must not change in flight.
 * @returns ciphertext with the tag appended.
 */
export declare function seal(plaintext: Uint8Array, key: Uint8Array, packetNumber: number, authenticatedData: Uint8Array): Buffer;
/**
 * Open one packet's payload.
 *
 * A failed open is a *return value*, not a thrown error: the caller is a
 * receive loop, and one bad packet is not a reason to tear down a session.
 *
 * @param sealed - ciphertext with the tag appended.
 * @param key - the key to open with.
 * @param packetNumber - the packet's number, which is also its nonce.
 * @param authenticatedData - the bytes the sealer authenticated.
 * @returns the plaintext, or `null` when the tag does not verify.
 */
export declare function open(sealed: Uint8Array, key: Uint8Array, packetNumber: number, authenticatedData: Uint8Array): Buffer | null;
