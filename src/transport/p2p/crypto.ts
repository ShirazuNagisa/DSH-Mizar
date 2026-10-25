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

import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  createHash,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto'
import { base64URLEncode, crockfordBase32 } from './encoding.js'

/** The info string mixed into the session salt. Part of the wire contract. */
export const SESSION_SALT_INFO = 'mizar-net/session/v1'

/** HKDF info for the dialler→acceptor key. Part of the wire contract. */
export const DIALER_TO_ACCEPTOR_INFO = 'mizar-net/dialer-to-acceptor/v1'

/** HKDF info for the acceptor→dialler key. Part of the wire contract. */
export const ACCEPTOR_TO_DIALER_INFO = 'mizar-net/acceptor-to-dialer/v1'

/** The AEAD's tag length. Also the smallest possible sealed payload. */
export const TAG_LENGTH = 16

/**
 * DER prefixes for the two key types, as PKCS#8 (private) and SPKI (public).
 *
 * `node:crypto` cannot build a raw 32-byte key, so the seed is wrapped in the
 * smallest legal container for its algorithm. The bytes are fixed by RFC 8410;
 * the only variable part is the final 32.
 */
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex')
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')

/** What a derived key is for. Part of the wire contract, like the info strings. */
export type IdentityPurpose = 'host' | 'device'

/** The purpose strings, exactly as `MizarNetIdentity.Purpose` spells them. */
const PURPOSE_STRINGS: Readonly<Record<IdentityPurpose, string>> = {
  host: 'mizar-net/host/v1',
  device: 'mizar-net/device/v1',
}

/** An endpoint's key pair, and the two forms of its name. */
export interface EndpointIdentity {
  /** The base64url Ed25519 public key. 43 characters. What a ticket names. */
  readonly endpointId: string
  /** 8 Crockford base32 characters — enough to tell two endpoints apart in a log. */
  readonly shortId: string
  /** The raw 32-byte public key. */
  readonly publicKey: Buffer
  /**
   * Sign a message with the endpoint key.
   * @param message - the bytes to sign.
   * @returns the 64-byte signature.
   */
  sign(message: Uint8Array): Buffer
}

/** An X25519 key pair, ephemeral by convention. */
export interface EphemeralKeyPair {
  /** The raw 32-byte public key, as it travels in a hello. */
  readonly publicKey: Buffer
  /** The private key, kept for the agreement. */
  readonly privateKey: KeyObject
}

/**
 * Extract the raw 32-byte public key from a Node key object.
 * @param key - a public (or private, whose public half is derived) key.
 * @returns the trailing 32 bytes of its SPKI encoding.
 */
function rawPublicKey(key: KeyObject): Buffer {
  const isPrivate = key.type === 'private' || key.type === 'secret'
  const publicKey = isPrivate ? createPublicKey(key) : key
  const der = publicKey.export({ format: 'der', type: 'spki' })
  return Buffer.from(der).subarray(-32)
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
export function deriveIdentity(secret: Uint8Array, purpose: IdentityPurpose): EndpointIdentity {
  const material = Buffer.concat([Buffer.from(secret), Buffer.from(PURPOSE_STRINGS[purpose], 'utf8'), Buffer.from([0x01])])
  const seed = createHash('sha256').update(material).digest()
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, seed]),
    format: 'der',
    type: 'pkcs8',
  })
  const publicKey = rawPublicKey(privateKey)
  return {
    endpointId: base64URLEncode(publicKey),
    shortId: crockfordBase32(publicKey, 8),
    publicKey,
    sign: (message: Uint8Array) => edSign(null, message, privateKey),
  }
}

/**
 * Verify a signature against an endpoint id.
 *
 * @param signature - the 64-byte signature.
 * @param message - the bytes that were signed.
 * @param endpointId - the base64url public key to check against.
 * @returns whether the signature is valid for that key and message.
 */
export function verifySignature(signature: Uint8Array, message: Uint8Array, endpointId: string): boolean {
  const raw = base64URLDecodeStrict(endpointId)
  if (raw === null || raw.length !== 32) return false
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]),
      format: 'der',
      type: 'spki',
    })
    return edVerify(null, message, publicKey, signature)
  } catch {
    return false
  }
}

/**
 * Decode base64url text, strictly.
 *
 * A public key is not a place to be forgiving: a value that decodes to the
 * wrong length is a different key, and accepting it would silently verify
 * against something nobody signed.
 *
 * @param text - the text to decode.
 * @returns the bytes, or `null` when the text is not base64url.
 */
function base64URLDecodeStrict(text: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null
  const decoded = Buffer.from(text, 'base64url')
  return base64URLEncode(decoded) === text ? decoded : null
}

/**
 * A fresh ephemeral X25519 key pair.
 * @returns the pair, with the public key already raw.
 */
export function ephemeralKeyPair(): EphemeralKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('x25519')
  return { privateKey, publicKey: rawPublicKey(publicKey) }
}

/**
 * Rebuild a key object from a raw X25519 public key that arrived in a hello.
 * @param raw - the 32-byte key.
 * @returns the key object to agree against.
 */
export function x25519PublicKey(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) throw new RangeError(`an X25519 public key is 32 bytes, not ${raw.length}`)
  return createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b656e032100', 'hex'), Buffer.from(raw)]),
    format: 'der',
    type: 'spki',
  })
}

/**
 * The ephemeral-ephemeral agreement.
 * @param local - this side's ephemeral private key.
 * @param remoteRawPublicKey - the peer's ephemeral public key from its hello.
 * @returns the 32-byte shared secret.
 */
export function agree(local: KeyObject, remoteRawPublicKey: Uint8Array): Buffer {
  return diffieHellman({ privateKey: local, publicKey: x25519PublicKey(remoteRawPublicKey) })
}

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
export function sessionSalt(localEndpointId: string, remoteEndpointId: string): Buffer {
  const ordered = [localEndpointId, remoteEndpointId].sort()
  const parts: Buffer[] = [Buffer.from(SESSION_SALT_INFO, 'utf8')]
  for (const id of ordered) {
    parts.push(Buffer.from(id, 'utf8'), Buffer.from([0x00]))
  }
  return createHash('sha256').update(Buffer.concat(parts)).digest()
}

/** The pair of session keys, from this side's point of view. */
export interface SessionKeys {
  /** The key this side seals with. */
  readonly seal: Buffer
  /** The key it expects the peer's packets under. */
  readonly open: Buffer
  /** The key the dialler seals with, whichever side this is. */
  readonly dialerToAcceptor: Buffer
  /** The key the acceptor seals with, whichever side this is. */
  readonly acceptorToDialer: Buffer
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
export function sessionKeys(sharedSecret: Uint8Array, salt: Uint8Array, localIsDialer: boolean): SessionKeys {
  const derive = (info: string): Buffer =>
    Buffer.from(hkdfSync('sha256', Buffer.from(sharedSecret), Buffer.from(salt), Buffer.from(info, 'utf8'), 32))
  const dialerToAcceptor = derive(DIALER_TO_ACCEPTOR_INFO)
  const acceptorToDialer = derive(ACCEPTOR_TO_DIALER_INFO)
  return localIsDialer
    ? { seal: dialerToAcceptor, open: acceptorToDialer, dialerToAcceptor, acceptorToDialer }
    : { seal: acceptorToDialer, open: dialerToAcceptor, dialerToAcceptor, acceptorToDialer }
}

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
export function packetNonce(packetNumber: number): Buffer {
  const nonce = Buffer.alloc(12)
  nonce.writeUInt32BE(0, 0)
  nonce.writeBigUInt64BE(BigInt(packetNumber), 4)
  return nonce
}

/**
 * Seal one packet's payload.
 *
 * @param plaintext - the chunk.
 * @param key - this side's seal key.
 * @param packetNumber - the packet's number, which is also its nonce.
 * @param authenticatedData - the header bytes that must not change in flight.
 * @returns ciphertext with the tag appended.
 */
export function seal(
  plaintext: Uint8Array,
  key: Uint8Array,
  packetNumber: number,
  authenticatedData: Uint8Array,
): Buffer {
  const cipher = createCipheriv('chacha20-poly1305', key, packetNonce(packetNumber), { authTagLength: TAG_LENGTH })
  cipher.setAAD(authenticatedData, { plaintextLength: plaintext.length })
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([ciphertext, cipher.getAuthTag()])
}

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
export function open(
  sealed: Uint8Array,
  key: Uint8Array,
  packetNumber: number,
  authenticatedData: Uint8Array,
): Buffer | null {
  const bytes = Buffer.from(sealed)
  if (bytes.length < TAG_LENGTH) return null
  const decipher = createDecipheriv('chacha20-poly1305', key, packetNonce(packetNumber), { authTagLength: TAG_LENGTH })
  decipher.setAAD(authenticatedData, { plaintextLength: bytes.length - TAG_LENGTH })
  decipher.setAuthTag(bytes.subarray(bytes.length - TAG_LENGTH))
  try {
    return Buffer.concat([decipher.update(bytes.subarray(0, bytes.length - TAG_LENGTH)), decipher.final()])
  } catch {
    // Wrong key, tampered bytes and a truncated packet all land here; the
    // caller cannot act on the difference.
    return null
  }
}
