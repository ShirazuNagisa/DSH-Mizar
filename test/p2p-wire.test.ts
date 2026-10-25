/**
 * The MizarNet wire format, checked against the Swift implementation.
 *
 * `iOS/MizarKit/Tests/MizarKitTests/MizarNetFixtureEmitter.swift` writes
 * `protocol/fixtures/p2p-wire.json`; this suite has to reproduce it byte for
 * byte. Two implementations reading one artifact is what makes the contract
 * testable: neither language can drift from the other without a red test, and
 * a packet this module builds is one the phone accepts without a flag.
 *
 * Regenerate the fixture with:
 *
 *     cd iOS && MIZAR_P2P_FIXTURES=1 scripts/swift.sh test --filter MizarNetFixtureEmitter
 *
 * then copy `iOS/protocol/fixtures/p2p-wire.json` over this repository's copy.
 *
 * @module dsh-mizar/test/p2p-wire
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  encodeAck,
  encodeClose,
  encodeData,
  encodeHeader,
  encodeHello,
  encodeKeepalive,
  handshakeMessage,
  HEADER_LENGTH,
  MAGIC,
  PacketType,
  parseAck,
  parseClose,
  parseData,
  parseHeader,
  parseHello,
} from '../src/transport/p2p/wire.js'

/** The fixture, typed loosely: it is data, and the assertions narrow it. */
interface WireFixture {
  readonly identity: {
    readonly secretHex: string
    readonly purpose: string
    readonly endpointId: string
    readonly shortId: string
    readonly messageHex: string
    readonly signatureHex: string
  }
  readonly clientHello: {
    readonly connectionId: string
    readonly endpointId: string
    readonly ephemeralPublicKeyHex: string
    readonly handshakeMessageHex: string
    readonly signatureHex: string
    readonly packetHex: string
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
  readonly data: {
    readonly connectionId: string
    readonly packetNumber: number
    readonly acks: readonly number[]
    readonly messageLength: number
    readonly plaintextHex: string
    readonly authenticatedDataHex: string
    readonly sealedHex: string
    readonly packetHex: string
  }
  readonly control: {
    readonly keepaliveHex: string
    readonly ackHex: string
    readonly closeHex: string
  }
}

const FIXTURE_PATH = fileURLToPath(new URL('../protocol/fixtures/p2p/wire.json', import.meta.url))
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as WireFixture

/**
 * The fixture's connection id, as a bigint.
 *
 * Held in a string there because it exceeds 2^53: reading it as a `number`
 * would silently round it to a different connection.
 */
const connectionId = BigInt(fixture.clientHello.connectionId)

/** Write a big-endian uint32, for the authenticated-data check. */
function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4)
  buffer.writeUInt32BE(value, 0)
  return buffer
}

describe('connection id', () => {
  it('survives the round trip above 2^53', () => {
    // The point of bigint: this value cannot be held in a double. A `number`
    // implementation would parse it, round it, and address a connection that
    // does not exist — a failure that looks like the network.
    expect(connectionId).toBeGreaterThan(BigInt(Number.MAX_SAFE_INTEGER))
    const header = encodeHeader(PacketType.Keepalive, connectionId, 0)
    expect(parseHeader(header)?.connectionId).toBe(connectionId)
  })
})

describe('header', () => {
  it('starts with the magic and the type', () => {
    const header = encodeHeader(PacketType.Data, 1n, 0)
    expect(header.length).toBe(HEADER_LENGTH)
    expect(header.subarray(0, 4).equals(MAGIC)).toBe(true)
    expect(header.readUInt8(4)).toBe(PacketType.Data)
  })

  it('rejects a foreign datagram', () => {
    const notOurs = Buffer.from('HTTP/1.1 200 OK\r\n\r\n', 'utf8')
    expect(parseHeader(notOurs)).toBeNull()
    const wrongMagic = encodeHeader(PacketType.Data, 1n, 0)
    wrongMagic.writeUInt8(0x00, 0)
    expect(parseHeader(wrongMagic)).toBeNull()
  })

  it('rejects a truncated datagram', () => {
    const packet = encodeKeepalive(1n)
    expect(parseHeader(packet.subarray(0, packet.length - 1))).toBeNull()
  })

  it('rejects a header whose length disagrees with the datagram', () => {
    const packet = encodeKeepalive(1n)
    // Claim four payload bytes that are not there. Accepting this would hand
    // the session a payload with the wrong bounds.
    packet.writeUInt16BE(4, 13)
    expect(parseHeader(packet)).toBeNull()
  })

  it('rejects an unknown type', () => {
    const packet = encodeKeepalive(1n)
    packet.writeUInt8(9, 4)
    expect(parseHeader(packet)).toBeNull()
  })
})

describe('hello', () => {
  it('rebuilds the Swift packet byte for byte', () => {
    const ephemeral = Buffer.from(fixture.clientHello.ephemeralPublicKeyHex, 'hex')
    // The signature is taken from the packet rather than re-created: CryptoKit
    // signs with a randomized nonce, so signing again produces a different
    // (equally valid) 64 bytes. The encoding is what this asserts.
    const parsed = parseHello(Buffer.from(fixture.clientHello.packetHex, 'hex'))
    if (parsed === null) throw new Error('the fixture hello did not parse')

    const message = handshakeMessage(PacketType.ClientHello, connectionId, ephemeral, fixture.clientHello.endpointId)
    expect(message.toString('hex')).toBe(fixture.clientHello.handshakeMessageHex)

    const packet = encodeHello(
      PacketType.ClientHello,
      connectionId,
      fixture.clientHello.endpointId,
      ephemeral,
      parsed.handshake.signature,
    )
    expect(packet.toString('hex')).toBe(fixture.clientHello.packetHex)
  })

  it('parses the Swift packet back into its parts', () => {
    const packet = Buffer.from(fixture.clientHello.packetHex, 'hex')
    const parsed = parseHello(packet)
    expect(parsed).not.toBeNull()
    expect(parsed?.header.type).toBe(PacketType.ClientHello)
    expect(parsed?.header.connectionId).toBe(connectionId)
    expect(parsed?.handshake.endpointId).toBe(fixture.clientHello.endpointId)
    expect(parsed?.handshake.ephemeralPublicKey.toString('hex')).toBe(fixture.clientHello.ephemeralPublicKeyHex)
    expect(parsed?.handshake.signature.toString('hex')).toBe(fixture.clientHello.signatureHex)
  })

  it('rejects a hello with no endpoint id', () => {
    const ephemeral = Buffer.alloc(32, 1)
    const packet = encodeHello(PacketType.ClientHello, 1n, 'x', ephemeral, Buffer.alloc(64, 2))
    packet.writeUInt8(0, HEADER_LENGTH + 32)
    expect(parseHello(packet)).toBeNull()
  })

  it('rejects a truncated hello', () => {
    const packet = Buffer.from(fixture.clientHello.packetHex, 'hex')
    expect(parseHello(packet.subarray(0, packet.length - 8))).toBeNull()
  })

  it('refuses a data packet as a hello', () => {
    expect(parseHello(Buffer.from(fixture.data.packetHex, 'hex'))).toBeNull()
  })
})

describe('data', () => {
  it('rebuilds the Swift packet byte for byte', () => {
    const plaintext = Buffer.from(fixture.data.plaintextHex, 'hex')
    const acks = fixture.data.acks
    // The authenticated data is header ‖ packet number ‖ message length, which
    // means the header has to be built first — and its length field depends on
    // the sealed size, which the session computes the same way.
    const payloadLength = 4 + 1 + acks.length * 4 + 4 + plaintext.length + 16
    const header = encodeHeader(PacketType.Data, connectionId, payloadLength)
    const authenticatedData = Buffer.concat([
      header,
      u32(fixture.data.packetNumber),
      u32(fixture.data.messageLength),
    ])
    expect(authenticatedData.toString('hex')).toBe(fixture.data.authenticatedDataHex)

    const packet = encodeData(
      connectionId,
      fixture.data.packetNumber,
      acks,
      fixture.data.messageLength,
      Buffer.from(fixture.data.sealedHex, 'hex'),
    )
    expect(packet.toString('hex')).toBe(fixture.data.packetHex)
  })

  it('parses the Swift packet back into its parts', () => {
    const parsed = parseData(Buffer.from(fixture.data.packetHex, 'hex'))
    expect(parsed).not.toBeNull()
    expect(parsed?.connectionId).toBe(connectionId)
    expect(parsed?.packetNumber).toBe(fixture.data.packetNumber)
    expect(parsed?.acks).toEqual(fixture.data.acks)
    expect(parsed?.messageLength).toBe(fixture.data.messageLength)
    expect(parsed?.sealed.toString('hex')).toBe(fixture.data.sealedHex)
    expect(parsed?.authenticatedData.toString('hex')).toBe(fixture.data.authenticatedDataHex)
  })

  it('round trips through the parser', () => {
    const sealed = Buffer.alloc(32, 7)
    const packet = encodeData(42n, 9, [1, 2, 3], 16, sealed)
    const parsed = parseData(packet)
    expect(parsed?.packetNumber).toBe(9)
    expect(parsed?.acks).toEqual([1, 2, 3])
    expect(parsed?.messageLength).toBe(16)
    expect(parsed?.sealed.equals(sealed)).toBe(true)
  })

  it('carries at most eight acks', () => {
    const many = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    const packet = encodeData(1n, 0, many, 1, Buffer.alloc(17, 0))
    expect(parseData(packet)?.acks).toEqual(many.slice(0, 8))
  })

  it('rejects a data packet with no sealed payload', () => {
    const packet = encodeData(1n, 0, [], 1, Buffer.alloc(16, 0))
    // Truncate the tag away entirely: not an empty message, a broken packet.
    const truncated = packet.subarray(0, HEADER_LENGTH + 4 + 1 + 4)
    truncated.writeUInt16BE(9, 13)
    expect(parseData(truncated)).toBeNull()
  })
})

describe('control packets', () => {
  it('matches the Swift keepalive', () => {
    expect(encodeKeepalive(connectionId).toString('hex')).toBe(fixture.control.keepaliveHex)
  })

  it('matches the Swift ack', () => {
    const packet = encodeAck(connectionId, fixture.data.acks)
    expect(packet.toString('hex')).toBe(fixture.control.ackHex)
    const parsed = parseAck(packet)
    expect(parsed?.connectionId).toBe(connectionId)
    expect(parsed?.acks).toEqual(fixture.data.acks)
  })

  it('matches the Swift close', () => {
    const packet = encodeClose(connectionId, 'bye')
    expect(packet.toString('hex')).toBe(fixture.control.closeHex)
    expect(parseClose(packet)?.reason).toBe('bye')
  })

  it('truncates a long close reason rather than overflowing', () => {
    const packet = encodeClose(1n, 'x'.repeat(400))
    expect(parseClose(packet)?.reason.length).toBe(255)
  })

  it('reads a close with no reason', () => {
    const packet = encodeClose(1n, '')
    expect(parseClose(packet)).toEqual({ connectionId: 1n, reason: '' })
  })
})
