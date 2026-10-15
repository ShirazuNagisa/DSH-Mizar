#!/usr/bin/env node
/**
 * Will an unsolicited packet from a stranger reach this machine?
 *
 * This is the one measurement that decides whether serverless hole punching can
 * work without a rendezvous, and it is the one a public STUN server cannot make
 * for you. Mapping behaviour (see netprobe.mjs) tells you what address you
 * appear at; *filtering* tells you whether a peer may actually send to it. A NAT
 * with endpoint-independent mapping and address-dependent filtering is a
 * perfectly ordinary router, and it drops the first packet from anyone you have
 * not already spoken to -- which, in a design with no signalling server, is
 * everyone.
 *
 * The test is deliberately manual, because it needs a second machine on a
 * different network and there is no way around that: the whole question is what
 * happens between two paths that cannot see each other yet.
 *
 *   Terminal 1 (the Mac, on Wi-Fi):   node scripts/natfilter.mjs
 *   Terminal 2 (anywhere else):       send one UDP datagram to the endpoint it prints
 *
 * The second machine must be on a *different* network -- a phone on cellular is
 * ideal, because cellular is a different NAT entirely. Sending from another
 * computer on the same Wi-Fi proves nothing: that traffic never crosses the NAT.
 *
 * Usage: node scripts/natfilter.mjs [seconds]
 */

import { createSocket } from 'node:dgram'

const MAGIC_COOKIE = 0x2112a442
const STUN_SERVER = { host: 'stun.l.google.com', port: 19302 }
const waitSeconds = Number(process.argv[2] ?? 180)

/** A binding request, so the NAT creates a mapping and tells us what it is. */
function bindingRequest() {
  const header = Buffer.alloc(20)
  header.writeUInt16BE(0x0001, 0)
  header.writeUInt16BE(0, 2)
  header.writeUInt32BE(MAGIC_COOKIE, 4)
  for (let i = 8; i < 20; i += 1) header[i] = Math.floor(Math.random() * 256)
  return header
}

/** The address the STUN server saw, from its XOR-MAPPED-ADDRESS. */
function mappedAddress(message) {
  if (message.readUInt16BE(0) !== 0x0101) return null
  const length = message.readUInt16BE(2)
  let offset = 20
  while (offset + 4 <= 20 + length) {
    const type = message.readUInt16BE(offset)
    const size = message.readUInt16BE(offset + 2)
    // The value is [reserved 1][family 1][port 2][address 4]. The family is the
    // *second* byte: reading the first reads the reserved zero, the check never
    // matches, and every reply is then classified as a stranger. netprobe.mjs
    // had this right by reading through a subarray; inlining it here lost the
    // offset.
    if (type === 0x0020 && message.readUInt8(offset + 5) === 0x01) {
      const raw = Buffer.from(message.subarray(offset + 8, offset + 12))
      for (let i = 0; i < 4; i += 1) raw[i] ^= (MAGIC_COOKIE >>> (24 - i * 8)) & 0xff
      const port = message.readUInt16BE(offset + 6) ^ (MAGIC_COOKIE >>> 16)
      return { address: `${raw[0]}.${raw[1]}.${raw[2]}.${raw[3]}`, port }
    }
    offset += 4 + size + ((4 - (size % 4)) % 4)
  }
  return null
}

console.log('\nNAT filtering test')
console.log('='.repeat(64))
console.log(`
This keeps one UDP socket open and prints where it appears from the outside.
Then it waits. If a datagram arrives from an address it has never contacted,
this NAT admits strangers and serverless hole punching is viable.
`)

const socket = createSocket('udp4')
let external = null
let strangers = 0

socket.on('message', (message, from) => {
  // A STUN reply is never a stranger, however many of them arrive. Classifying
  // by payload rather than by sender address means a server answering from a
  // second address cannot be mistaken for the thing being measured -- the first
  // version counted its own STUN reply as an unsolicited packet and reported a
  // permissive NAT on the strength of it.
  const mapped = mappedAddress(message)
  if (mapped !== null) {
    if (external === null) {
      external = mapped
      report()
    }
    return
  }
  strangers += 1
  console.log(`\n  ✅ UNSOLICITED PACKET from ${from.address}:${from.port} (${message.length} bytes)`)
  console.log('     This NAT admits strangers. The QR-only design is viable on this')
  console.log('     network, provided the Mac stays on it and off cellular.')
})

socket.on('error', (error) => {
  console.error(`\n  socket error: ${error.message}`)
  process.exit(1)
})

socket.bind(0, () => {
  socket.send(bindingRequest(), STUN_SERVER.port, STUN_SERVER.host)
})

/** Print the endpoint and the instructions, once the mapping is known. */
function report() {
  const local = socket.address()
  console.log('  local port   ', local.port)
  console.log('  appears as   ', `${external.address}:${external.port}`)
  console.log()
  console.log('-'.repeat(64))
  console.log('\n  From a machine on a DIFFERENT network, send ONE UDP datagram to:')
  console.log()
  console.log(`      ${external.address}:${external.port}`)
  console.log()
  console.log('  Any payload will do. On iOS, an app like "UDP Sender" or any network')
  console.log('  utility that can emit a raw datagram works; the phone must be on')
  console.log('  cellular, not on this Wi-Fi.')
  console.log()
  console.log(`  Waiting ${waitSeconds}s...\n`)
}

setTimeout(() => {
  console.log('\n' + '='.repeat(64))
  if (strangers === 0) {
    console.log(`
  No unsolicited packet arrived.

  That is not proof of filtering -- it is also what happens if nothing was
  sent, or if the phone was on the same Wi-Fi. But if a datagram really was
  sent from another network and nothing arrived, this NAT filters by address,
  and a design with no signalling server cannot open the path: the Mac does not
  know the phone's address, so it cannot send first to admit it.
`)
  } else {
    console.log(`\n  ${strangers} unsolicited packet(s) arrived. Filtering is permissive.\n`)
  }
  process.exit(0)
}, waitSeconds * 1000)
