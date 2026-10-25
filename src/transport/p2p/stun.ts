/**
 * The one question a STUN server can answer: what do I look like from the
 * outside?
 *
 * A punch needs the *server-reflexive* address — the public ip:port the NAT
 * maps this socket to — because that is what the far peer has to send to.
 * RFC 5389's Binding transaction is the whole protocol for asking: a 20-byte
 * request with a random transaction id, and a response carrying
 * XOR-MAPPED-ADDRESS.
 *
 * Only the parts a punch client needs, exactly as the Swift side implements
 * them: no SOFTWARE, no FINGERPRINT, no realm/authenticator. Unknown
 * attributes are skipped by length, the way the RFC requires — which is what
 * lets this talk to coturn, to a home router and to the iOS kernel's own fake
 * responder without special cases.
 *
 * @module dsh-mizar/transport/p2p/stun
 */

import { randomBytes } from 'node:crypto'

/** The magic cookie every STUN message carries after its type. */
export const MAGIC_COOKIE = 0x2112a442

/** The fixed header: type, length, cookie, transaction id. */
export const STUN_HEADER_LENGTH = 20

/** Binding Request. */
export const BINDING_REQUEST_TYPE = 0x0001

/** Binding Success Response. */
export const BINDING_SUCCESS_RESPONSE_TYPE = 0x0101

/** MAPPED-ADDRESS — the pre-XOR form, still answered by old servers. */
export const MAPPED_ADDRESS_ATTRIBUTE = 0x0001

/** XOR-MAPPED-ADDRESS — the form everything modern answers with. */
export const XOR_MAPPED_ADDRESS_ATTRIBUTE = 0x0020

/** What the server thinks this socket looks like. */
export interface MappedAddress {
  readonly ip: string
  readonly port: number
}

/**
 * A fresh 12-byte transaction id.
 * @returns the id.
 */
export function randomTransactionId(): Buffer {
  return randomBytes(12)
}

/**
 * Whether a datagram is a STUN message.
 *
 * The first two bits of a STUN message are zero, and the magic cookie sits at
 * offset four. Checking both is what lets the engine tell a STUN answer from
 * a punch packet on the same socket.
 *
 * @param data - the datagram.
 * @returns whether it looks like STUN.
 */
export function looksLikeSTUN(data: Buffer): boolean {
  if (data.length < STUN_HEADER_LENGTH) return false
  if ((data.readUInt8(0) & 0xc0) !== 0) return false
  return data.readUInt32BE(4) === MAGIC_COOKIE
}

/**
 * The transaction id of a message.
 * @param data - a datagram that looks like STUN.
 * @returns the 12-byte id.
 */
export function transactionId(data: Buffer): Buffer {
  return data.subarray(8, STUN_HEADER_LENGTH)
}

/**
 * Build a Binding Request.
 * @param id - the transaction id to use.
 * @returns the 20-byte request.
 */
export function bindingRequest(id: Buffer): Buffer {
  const message = Buffer.alloc(STUN_HEADER_LENGTH)
  message.writeUInt16BE(BINDING_REQUEST_TYPE, 0)
  message.writeUInt16BE(0, 2)
  message.writeUInt32BE(MAGIC_COOKIE, 4)
  id.copy(message, 8)
  return message
}

/**
 * Parse a Binding Success Response.
 * @param data - the datagram.
 * @param expectedTransactionId - the id the request carried. A response for a
 *   different transaction is somebody else's answer.
 * @returns the mapped address, or `null` when this is not a usable answer.
 */
export function parseBindingResponse(data: Buffer, expectedTransactionId: Buffer): MappedAddress | null {
  if (data.length < STUN_HEADER_LENGTH) return null
  if (data.readUInt16BE(0) !== BINDING_SUCCESS_RESPONSE_TYPE) return null
  if (data.readUInt32BE(4) !== MAGIC_COOKIE) return null
  if (!data.subarray(8, STUN_HEADER_LENGTH).equals(expectedTransactionId)) return null

  const messageLength = data.readUInt16BE(2)
  const end = Math.min(data.length, STUN_HEADER_LENGTH + messageLength)
  let offset = STUN_HEADER_LENGTH
  let fallback: MappedAddress | null = null
  while (offset + 4 <= end) {
    const type = data.readUInt16BE(offset)
    const length = data.readUInt16BE(offset + 2)
    const valueStart = offset + 4
    if (length > 0 && valueStart + length <= end) {
      const value = data.subarray(valueStart, valueStart + length)
      if (type === XOR_MAPPED_ADDRESS_ATTRIBUTE) {
        const address = parseXORAddress(value)
        if (address !== null) return address
      } else if (type === MAPPED_ADDRESS_ATTRIBUTE) {
        fallback = parsePlainAddress(value)
      }
    }
    // Attributes are padded to a four-byte boundary.
    offset = valueStart + (((length + 3) >> 2) << 2)
  }
  return fallback
}

/**
 * XOR-MAPPED-ADDRESS: one reserved byte, family, then port and address XOR'd
 * with the cookie.
 *
 * RFC 5389 §15.2 — the reserved byte is why this reads the family at offset 1
 * and the port at 2. Getting that off by one produces a plausible-looking
 * address that no peer can reach.
 *
 * @param value - the attribute value.
 * @returns the address, or `null` for a non-IPv4 encoding.
 */
function parseXORAddress(value: Buffer): MappedAddress | null {
  if (value.length < 8) return null
  if (value.readUInt8(1) !== 0x01) return null
  const port = value.readUInt16BE(2) ^ (MAGIC_COOKIE >>> 16)
  const cookie = Buffer.alloc(4)
  cookie.writeUInt32BE(MAGIC_COOKIE, 0)
  const address = Buffer.alloc(4)
  for (let index = 0; index < 4; index += 1) {
    address[index] = (value[4 + index] ?? 0) ^ (cookie[index] ?? 0)
  }
  return { ip: dottedQuad(address), port }
}

/**
 * MAPPED-ADDRESS, the pre-XOR form.
 * @param value - the attribute value.
 * @returns the address, or `null` for a non-IPv4 encoding.
 */
function parsePlainAddress(value: Buffer): MappedAddress | null {
  if (value.length < 8) return null
  if (value.readUInt8(1) !== 0x01) return null
  return { ip: dottedQuad(value.subarray(4, 8)), port: value.readUInt16BE(2) }
}

/**
 * Render four bytes as a dotted quad.
 * @param bytes - the four address bytes.
 * @returns the text form.
 */
function dottedQuad(bytes: Buffer): string {
  return `${bytes[0] ?? 0}.${bytes[1] ?? 0}.${bytes[2] ?? 0}.${bytes[3] ?? 0}`
}
