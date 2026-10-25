/**
 * The MizarNet handshake and seal, checked against the Swift implementation.
 *
 * The wire test proves the two sides agree on *shape*; this one proves they
 * agree on *keys*. Every constant in `src/transport/p2p/crypto.ts` is part of
 * the protocol — an info string, a purpose string, a salt construction — and a
 * mismatch in any of them produces a session that neither errors nor works.
 * The fixture is the only thing that can catch that, so the assertions here are
 * exact bytes rather than round trips.
 *
 * @module dsh-mizar/test/p2p-crypto
 */
import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  agree,
  deriveIdentity,
  ephemeralKeyPair,
  open,
  packetNonce,
  seal,
  sessionKeys,
  sessionSalt,
  verifySignature,
} from '../src/transport/p2p/crypto.js'
import { base64URLDecode, base64URLEncode, crockfordBase32 } from '../src/transport/p2p/encoding.js'
import { handshakeMessage, PacketType } from '../src/transport/p2p/wire.js'

interface CryptoFixture {
  readonly identity: {
    readonly secretHex: string
    readonly endpointId: string
    readonly shortId: string
    readonly messageHex: string
    readonly signatureHex: string
  }
  readonly session: {
    readonly sharedSecretHex: string
    readonly localEndpointId: string
    readonly remoteEndpointId: string
    readonly saltHex: string
    readonly dialerToAcceptorKeyHex: string
    readonly acceptorToDialerKeyHex: string
  }
  readonly agreement: {
    readonly localSecretHex: string
    readonly localPublicKeyHex: string
    readonly remotePublicKeyHex: string
    readonly sharedSecretHex: string
  }
  readonly clientHello: {
    readonly connectionId: string
    readonly endpointId: string
    readonly ephemeralPublicKeyHex: string
    readonly handshakeMessageHex: string
    readonly signatureHex: string
  }
  readonly data: {
    readonly packetNumber: number
    readonly plaintextHex: string
    readonly authenticatedDataHex: string
    readonly sealedHex: string
  }
}

const FIXTURE_PATH = fileURLToPath(new URL('../protocol/fixtures/p2p/wire.json', import.meta.url))
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as CryptoFixture

/** Decode a hex field from the fixture. */
function hex(value: string): Buffer {
  return Buffer.from(value, 'hex')
}

describe('encoding', () => {
  it('round trips base64url without padding', () => {
    const bytes = Buffer.from([0xfb, 0xff, 0x00, 0x01, 0x02])
    const text = base64URLEncode(bytes)
    expect(text).not.toContain('=')
    expect(text).not.toContain('+')
    expect(text).not.toContain('/')
    expect(base64URLDecode(text)?.equals(bytes)).toBe(true)
  })

  it('refuses text that is not base64url', () => {
    expect(base64URLDecode('not base64!')).toBeNull()
    // A single character cannot encode a byte, and re-encoding catches it:
    // Node's decoder would otherwise return an empty buffer and the caller
    // would treat it as a zero-length key.
    expect(base64URLDecode('a')).toBeNull()
  })

  it('encodes the fixture public key as Crockford base32', () => {
    const publicKey = base64URLDecode(fixture.identity.endpointId)
    expect(publicKey).not.toBeNull()
    if (publicKey === null) throw new Error('unreachable')
    expect(crockfordBase32(publicKey, 8)).toBe(fixture.identity.shortId)
  })
})

describe('identity', () => {
  it('derives the same endpoint id from the same secret', () => {
    const identity = deriveIdentity(hex(fixture.identity.secretHex), 'host')
    // Both halves of the name, because they use different encoders: a match
    // here means the SHA-256 construction, the Ed25519 seed handling and both
    // text encodings all agree with Swift.
    expect(identity.endpointId).toBe(fixture.identity.endpointId)
    expect(identity.shortId).toBe(fixture.identity.shortId)
  })

  it('derives a different id for a different purpose', () => {
    const host = deriveIdentity(hex(fixture.identity.secretHex), 'host')
    const device = deriveIdentity(hex(fixture.identity.secretHex), 'device')
    expect(host.endpointId).not.toBe(device.endpointId)
  })

  it('verifies what Swift signed', () => {
    const message = hex(fixture.identity.messageHex)
    expect(verifySignature(hex(fixture.identity.signatureHex), message, fixture.identity.endpointId)).toBe(true)
  })

  it('signs verifiably, though not identically', () => {
    const identity = deriveIdentity(hex(fixture.identity.secretHex), 'host')
    const message = hex(fixture.identity.messageHex)
    const signature = identity.sign(message)
    expect(signature.length).toBe(64)
    expect(verifySignature(signature, message, identity.endpointId)).toBe(true)
    // CryptoKit signs Ed25519 with a randomized nonce, so the same key and
    // message produce different bytes on every call. The contract between the
    // two implementations is therefore *verification*: a peer checks the
    // signature, and nothing anywhere may compare signature bytes for
    // identity, deduplication or replay detection.
  })

  it('accepts the signature on the Swift hello, and only over that transcript', () => {
    const hello = fixture.clientHello
    const ephemeral = hex(hello.ephemeralPublicKeyHex)
    const connectionId = BigInt(hello.connectionId)
    const message = handshakeMessage(PacketType.ClientHello, connectionId, ephemeral, hello.endpointId)
    expect(message.toString('hex')).toBe(hello.handshakeMessageHex)
    expect(verifySignature(hex(hello.signatureHex), message, hello.endpointId)).toBe(true)

    // The type byte is domain separation: the same key signing the same
    // fields as a ServerHello must not verify as a ClientHello, which is what
    // stops a reflected hello from being replayed back at its sender.
    const asServerHello = handshakeMessage(PacketType.ServerHello, connectionId, ephemeral, hello.endpointId)
    expect(verifySignature(hex(hello.signatureHex), asServerHello, hello.endpointId)).toBe(false)

    // And the connection id is inside the signature: a hello cannot be moved
    // to another connection.
    const otherConnection = handshakeMessage(PacketType.ClientHello, connectionId + 1n, ephemeral, hello.endpointId)
    expect(verifySignature(hex(hello.signatureHex), otherConnection, hello.endpointId)).toBe(false)
  })

  it('rejects a signature over different bytes', () => {
    const message = hex(fixture.identity.messageHex)
    const tampered = Buffer.from(message)
    tampered[0] = (tampered[0] ?? 0) ^ 0x01
    expect(verifySignature(hex(fixture.identity.signatureHex), tampered, fixture.identity.endpointId)).toBe(false)
  })

  it('rejects a signature checked against another endpoint', () => {
    const other = deriveIdentity(Buffer.alloc(32, 0x33), 'device')
    expect(verifySignature(hex(fixture.identity.signatureHex), hex(fixture.identity.messageHex), other.endpointId)).toBe(false)
  })

  it('rejects a malformed endpoint id instead of throwing', () => {
    expect(verifySignature(Buffer.alloc(64, 0), Buffer.alloc(0), 'not-a-key')).toBe(false)
    expect(verifySignature(Buffer.alloc(64, 0), Buffer.alloc(0), '')).toBe(false)
  })
})

describe('key agreement', () => {
  it('reproduces the Swift shared secret', () => {
    const local = ephemeralKeyPairFromSecret(hex(fixture.agreement.localSecretHex))
    const shared = agree(local, hex(fixture.agreement.remotePublicKeyHex))
    expect(shared.toString('hex')).toBe(fixture.agreement.sharedSecretHex)
  })

  it('derives the expected public key from a scalar', () => {
    const local = ephemeralKeyPairFromSecret(hex(fixture.agreement.localSecretHex))
    expect(publicKeyOf(local).toString('hex')).toBe(fixture.agreement.localPublicKeyHex)
  })

  it('agrees symmetrically on a fresh pair', () => {
    const a = ephemeralKeyPair()
    const b = ephemeralKeyPair()
    expect(a.publicKey.length).toBe(32)
    expect(agree(a.privateKey, b.publicKey).equals(agree(b.privateKey, a.publicKey))).toBe(true)
  })

  it('refuses a public key of the wrong size', () => {
    const a = ephemeralKeyPair()
    expect(() => agree(a.privateKey, Buffer.alloc(31, 1))).toThrow(RangeError)
  })
})

describe('session keys', () => {
  it('derives the salt Swift derived', () => {
    const salt = sessionSalt(fixture.session.localEndpointId, fixture.session.remoteEndpointId)
    expect(salt.toString('hex')).toBe(fixture.session.saltHex)
    // The salt is symmetric by construction: the ids are sorted, so the
    // acceptor computing it in the other argument order lands on the same one.
    expect(sessionSalt(fixture.session.remoteEndpointId, fixture.session.localEndpointId).equals(salt)).toBe(true)
  })

  it('derives both directional keys', () => {
    const keys = sessionKeys(
      hex(fixture.session.sharedSecretHex),
      hex(fixture.session.saltHex),
      true,
    )
    expect(keys.dialerToAcceptor.toString('hex')).toBe(fixture.session.dialerToAcceptorKeyHex)
    expect(keys.acceptorToDialer.toString('hex')).toBe(fixture.session.acceptorToDialerKeyHex)
  })

  it('selects the seal direction by role', () => {
    const asDialer = sessionKeys(hex(fixture.session.sharedSecretHex), hex(fixture.session.saltHex), true)
    const asAcceptor = sessionKeys(hex(fixture.session.sharedSecretHex), hex(fixture.session.saltHex), false)
    expect(asDialer.seal.toString('hex')).toBe(fixture.session.dialerToAcceptorKeyHex)
    expect(asDialer.open.toString('hex')).toBe(fixture.session.acceptorToDialerKeyHex)
    expect(asAcceptor.seal.toString('hex')).toBe(fixture.session.acceptorToDialerKeyHex)
    expect(asAcceptor.open.toString('hex')).toBe(fixture.session.dialerToAcceptorKeyHex)
  })
})

describe('packet seal', () => {
  const key = hex(fixture.session.dialerToAcceptorKeyHex)
  const plaintext = hex(fixture.data.plaintextHex)
  const aad = hex(fixture.data.authenticatedDataHex)

  it('lays the nonce out as four zeros then the number', () => {
    const nonce = packetNonce(0x0102_0304)
    expect(nonce.length).toBe(12)
    expect(nonce.subarray(0, 4).toString('hex')).toBe('00000000')
    expect(nonce.subarray(4).toString('hex')).toBe('0000000001020304')
  })

  it('produces the bytes Swift produced', () => {
    const sealed = seal(plaintext, key, fixture.data.packetNumber, aad)
    expect(sealed.toString('hex')).toBe(fixture.data.sealedHex)
  })

  it('opens what Swift sealed', () => {
    const opened = open(hex(fixture.data.sealedHex), key, fixture.data.packetNumber, aad)
    expect(opened?.toString('hex')).toBe(fixture.data.plaintextHex)
  })

  it('seals and opens an empty message', () => {
    // The tag is all there is for an empty message: 16 bytes is a valid sealed
    // payload, and treating it as "nothing" would break the keepalive path.
    const sealedEmpty = seal(Buffer.alloc(0), key, 1, aad)
    expect(sealedEmpty.length).toBe(16)
    expect(open(sealedEmpty, key, 1, aad)?.length).toBe(0)
  })

  it('refuses a packet under the wrong number', () => {
    expect(open(hex(fixture.data.sealedHex), key, fixture.data.packetNumber + 1, aad)).toBeNull()
  })

  it('refuses a packet with different authenticated data', () => {
    const tampered = Buffer.from(aad)
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0x01
    expect(open(hex(fixture.data.sealedHex), key, fixture.data.packetNumber, tampered)).toBeNull()
  })

  it('refuses a packet under the wrong key', () => {
    expect(open(hex(fixture.data.sealedHex), hex(fixture.session.acceptorToDialerKeyHex), fixture.data.packetNumber, aad)).toBeNull()
  })

  it('refuses a truncated packet', () => {
    expect(open(Buffer.alloc(8, 0), key, 0, aad)).toBeNull()
  })
})

/**
 * Rebuild a private key object from a raw X25519 scalar.
 *
 * The fixture stores a scalar rather than a DER key so it stays readable; this
 * wraps it the same way the crypto module wraps identity seeds.
 * @param scalar - the 32-byte scalar.
 * @returns the key object.
 */
function ephemeralKeyPairFromSecret(scalar: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b656e04220420', 'hex'), scalar]),
    format: 'der',
    type: 'pkcs8',
  })
}

/**
 * Read the raw public key out of a private X25519 key.
 * @param key - the key object.
 * @returns the 32-byte public key.
 */
function publicKeyOf(key: KeyObject): Buffer {
  const der = createPublicKey(key).export({ format: 'der', type: 'spki' })
  return Buffer.from(der).subarray(-32)
}
