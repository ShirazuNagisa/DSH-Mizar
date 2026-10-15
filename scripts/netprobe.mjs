#!/usr/bin/env node
/**
 * What kind of NAT is this machine behind?
 *
 * This decides whether serverless hole punching is worth building at all. The
 * answer is not a matter of engineering effort: a symmetric NAT drops the return
 * packet that a peer sends to the endpoint you were observed from, so the direct
 * path fails no matter how many ports you spray at it. Knowing which kind you
 * have is the difference between "this works" and "this works on some networks
 * and fails silently on others".
 *
 * STUN is the whole measurement. A public STUN server echoes back the address it
 * saw you from, and the *pattern across several queries* is what classifies the
 * NAT:
 *
 *   - Same endpoint against every server  → endpoint-independent mapping
 *     (full-cone family). A peer can reach you at that endpoint, which is what
 *     hole punching needs.
 *   - Endpoint changes with the destination → address-dependent mapping.
 *     Punching can still work if both sides are, but it needs timing.
 *   - Endpoint changes per destination *and port* → symmetric. Punching does not
 *     work; there is nothing to do about it.
 *
 * It also measures whether the external port is predictable, because that is the
 * one trick that rescues the address-dependent case.
 *
 * Only UDP and public STUN servers are used, and
 * no traffic is sent anywhere except a binding request.
 *
 * Usage: node scripts/netprobe.mjs
 */

import { createSocket } from 'node:dgram'
import { hostname, networkInterfaces } from 'node:os'

/** Public STUN servers, deliberately spread across operators and countries. */
const SERVERS = [
  { host: 'stun.l.google.com', port: 19302, note: 'Google (US)' },
  { host: 'stun1.l.google.com', port: 19302, note: 'Google (US)' },
  { host: 'stun.cloudflare.com', port: 3478, note: 'Cloudflare' },
  { host: 'stun.nextcloud.com', port: 443, note: 'Nextcloud (EU)' },
  { host: 'stun.miwifi.com', port: 3478, note: 'Xiaomi (CN)' },
  { host: 'stun.chat.bilibili.com', port: 3478, note: 'Bilibili (CN)' },
]

const MAGIC_COOKIE = 0x2112a442
const BINDING_REQUEST = 0x0001
const BINDING_SUCCESS = 0x0101
const BINDING_ERROR = 0x0111
const ATTR_MAPPED_ADDRESS = 0x0001
const ATTR_XOR_MAPPED_ADDRESS = 0x0020
const ATTR_CHANGE_REQUEST = 0x0003

/**
 * Servers that honour CHANGE-REQUEST, which is what makes filtering measurable
 * without running anything ourselves.
 *
 * RFC 5780's test is elegantly cheap: ask the server to reply from a *different*
 * address than the one you sent to. If the reply still arrives, this NAT accepts
 * inbound packets from anywhere once a mapping exists -- full cone. If it only
 * arrives when the server changes port but keeps its address, the NAT filters by
 * address. If neither arrives, it filters by address and port, and only a peer
 * you have already talked to can get in.
 *
 * These two answered a probe; most public STUN servers ignore the attribute and
 * look identical to a filtering NAT.
 */
const RFC5780_SERVERS = [
  { host: 'stun.antisip.com', port: 3478, note: 'antisip' },
  { host: 'stun.framasoft.org', port: 3478, note: 'framasoft' },
]

/**
 * Build a binding request with a fresh transaction id.
 * @param change - ask the server to reply from a different address and/or port.
 * @returns the encoded request.
 */
function bindingRequest(change) {
  const header = Buffer.alloc(change === undefined ? 20 : 28)
  header.writeUInt16BE(BINDING_REQUEST, 0)
  header.writeUInt16BE(change === undefined ? 0 : 8, 2)
  header.writeUInt32BE(MAGIC_COOKIE, 4)
  const transactionId = Buffer.alloc(12)
  for (let i = 0; i < 12; i += 1) transactionId[i] = Math.floor(Math.random() * 256)
  transactionId.copy(header, 8)
  if (change !== undefined) {
    header.writeUInt16BE(ATTR_CHANGE_REQUEST, 20)
    header.writeUInt16BE(4, 22)
    header.writeUInt32BE((change.ip ? 0x04 : 0) | (change.port ? 0x02 : 0), 24)
  }
  return header
}

/**
 * Parse a binding response into the address the server saw.
 * @param message - the raw response.
 * @returns the endpoint, or `null` when the response carries no address.
 */
function parseResponse(message) {
  if (message.length < 20) return null
  // 420 means the server does not implement CHANGE-REQUEST, which is a fact
  // about the server and not about this NAT. Reading it as a filtering result
  // would have produced a confident wrong answer.
  if (message.readUInt16BE(0) === BINDING_ERROR) {
    const length = message.readUInt16BE(2)
    let offset = 20
    while (offset + 8 <= 20 + length) {
      const type = message.readUInt16BE(offset)
      const size = message.readUInt16BE(offset + 2)
      if (type === 0x0009) {
        const code = message.readUInt8(offset + 6) * 100 + message.readUInt8(offset + 7)
        const reason = message.subarray(offset + 8, offset + 4 + size).toString('utf8').trim()
        return { unsupported: `server replied ${code}: ${reason}` }
      }
      offset += 4 + size + ((4 - (size % 4)) % 4)
    }
    return { unsupported: 'server replied with an error' }
  }
  if (message.readUInt16BE(0) !== BINDING_SUCCESS) return null
  const cookie = message.readUInt32BE(4)
  if (cookie !== MAGIC_COOKIE) return null

  const length = message.readUInt16BE(2)
  let offset = 20
  const end = Math.min(20 + length, message.length)
  while (offset + 4 <= end) {
    const type = message.readUInt16BE(offset)
    const size = message.readUInt16BE(offset + 2)
    const value = message.subarray(offset + 4, offset + 4 + size)
    if (type === ATTR_XOR_MAPPED_ADDRESS || type === ATTR_MAPPED_ADDRESS) {
      const family = value.readUInt8(1)
      const xor = type === ATTR_XOR_MAPPED_ADDRESS
      let port = value.readUInt16BE(2)
      if (xor) port ^= MAGIC_COOKIE >>> 16
      if (family === 0x01) {
        const raw = Buffer.from(value.subarray(4, 8))
        if (xor) {
          for (let i = 0; i < 4; i += 1) raw[i] ^= (MAGIC_COOKIE >>> (24 - i * 8)) & 0xff
        }
        return { address: `${raw[0]}.${raw[1]}.${raw[2]}.${raw[3]}`, port, family: 'IPv4' }
      }
      return null
    }
    offset += 4 + size + ((4 - (size % 4)) % 4) // attributes are padded to 4 bytes
  }
  return null
}

/**
 * Ask one STUN server what it sees.
 *
 * @param server - `{host, port}`.
 * @param localPort - the local port to send from, or 0 to let the OS choose.
 * @param timeoutMs - how long to wait.
 * @returns the observation, including the local port actually used.
 */
async function query(server, localPort = 0, timeoutMs = 3000, change = undefined) {
  return new Promise((resolve) => {
    const socket = createSocket({ type: 'udp4', reuseAddr: true })
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.close()
      } catch {
        /* already closed */
      }
      resolve(result)
    }
    const timer = setTimeout(() => finish({ ok: false, reason: 'timeout' }), timeoutMs)

    socket.on('error', (error) => finish({ ok: false, reason: error.code ?? error.message }))
    socket.on('message', (message, from) => {
      const parsed = parseResponse(message)
      if (parsed === null) return finish({ ok: false, reason: 'unparseable response' })
      if (parsed.unsupported !== undefined) {
        return finish({ ok: false, reason: parsed.unsupported, unsupported: true })
      }
      const mapped = parsed
      finish({
        ok: true,
        server: `${server.host}:${server.port}`,
        // Where the answer actually came from. With CHANGE-REQUEST that is not
        // the address we sent to, and the difference is the measurement.
        answeredFrom: `${from.address}:${from.port}`,
        localPort: socket.address().port,
        ...mapped,
      })
    })
    socket.bind(localPort, () => {
      const request = bindingRequest(change)
      socket.send(request, server.port, server.host, (error) => {
        if (error) finish({ ok: false, reason: error.code ?? error.message })
      })
    })
  })
}

/** This machine's own addresses, so a public address can be told from a NAT'd one. */
function localAddresses() {
  const out = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      out.push({ name, address: entry.address })
    }
  }
  return out
}

/** Classify mapping behaviour from one socket's observations. */
function classifyMapping(observations) {
  const unique = new Set(observations.map((o) => `${o.address}:${o.port}`))
  if (unique.size === 1) return 'endpoint-independent'
  const addresses = new Set(observations.map((o) => o.address))
  return addresses.size === 1 ? 'address-dependent' : 'symmetric'
}

/** How predictable the external port allocation is. */
function classifyAllocation(ports) {
  const sorted = [...ports].sort((a, b) => a - b)
  const gaps = sorted.slice(1).map((port, index) => port - sorted[index])
  const sequential = gaps.every((gap) => gap > 0 && gap <= 4)
  const randomish = gaps.every((gap) => gap === 0 || Math.abs(gap) > 64)
  if (sequential) return 'sequential (predictable)'
  if (randomish) return 'random (not predictable)'
  return 'mixed'
}

const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`)

console.log(`\nNAT probe on ${hostname()}`)
console.log('='.repeat(64))

// ── what this machine looks like locally ─────────────────────────────────────
console.log('\n1. Local addresses')
const locals = localAddresses()
for (const entry of locals) line(entry.name, entry.address)
if (locals.length === 0) console.log('  (none besides loopback)')

// ── one socket, many destinations: what varies with the destination? ─────────
console.log('\n2. Mapping behaviour — same socket, six different servers')
const firstSocket = await query(SERVERS[0])
if (!firstSocket.ok) {
  console.log(`  first server unreachable (${firstSocket.reason}); cannot continue`)
  process.exit(1)
}
const pinnedLocalPort = firstSocket.localPort
console.log(`  sending from local port ${pinnedLocalPort}`)
console.log()

const observations = []
for (const server of SERVERS) {
  const result = await query(server, pinnedLocalPort)
  if (result.ok) {
    observations.push(result)
    line(server.note, `${result.address}:${result.port}`)
  } else {
    line(server.note, `— (${result.reason})`)
  }
}

if (observations.length < 2) {
  console.log('\n  fewer than two servers answered; not enough to classify')
  process.exit(1)
}

const mapping = classifyMapping(observations)
const external = observations[0]
const isPublic = locals.some((entry) => entry.address === external.address)

console.log()
line('mapping', mapping)
line('public address?', isPublic ? 'yes — no NAT in the way' : 'no — behind NAT')
line('port preserved?', String(external.port) === String(pinnedLocalPort) ? 'yes' : 'no')

// ── many sockets, one destination: how are external ports allocated? ─────────
console.log('\n3. Allocation behaviour — eight sockets, one server')
const allocated = []
for (let i = 0; i < 8; i += 1) {
  const result = await query(SERVERS[0], 0, 2500)
  if (result.ok) {
    allocated.push(result.port)
    line(`socket ${i + 1}`, `local ${result.localPort} → external ${result.port}`)
  } else {
    line(`socket ${i + 1}`, `— (${result.reason})`)
  }
}

const allocation = allocated.length >= 3 ? classifyAllocation(allocated) : 'unknown'
console.log()
line('allocation', allocation)

// ── filtering: will it let an uninvited packet in? ───────────────────────────
console.log('\n4. Filtering behaviour — RFC 5780 change-request')
let filtering = 'unmeasured'
for (const server of RFC5780_SERVERS) {
  const baseline = await query(server, 0, 3000)
  if (!baseline.ok) {
    line(server.note, `— (${baseline.reason})`)
    continue
  }
  line(server.note, `sent to ${server.host}:${server.port}, answered from ${baseline.answeredFrom}`)

  // Different address *and* port: only a NAT that filters nothing lets it in.
  const both = await query(server, baseline.localPort, 3000, { ip: true, port: true })
  const portOnly = await query(server, baseline.localPort, 3000, { ip: false, port: true })

  if (both.unsupported === true || portOnly.unsupported === true) {
    line('  change IP+port', both.ok ? `answered from ${both.answeredFrom}` : `— ${both.reason}`)
    line('  change port only', portOnly.ok ? `answered from ${portOnly.answeredFrom}` : `— ${portOnly.reason}`)
    console.log('  this server does not implement CHANGE-REQUEST; trying the next')
    continue
  }

  const changedAddress = both.ok && !both.answeredFrom.startsWith(server.host)
  const changedPort = portOnly.ok && !portOnly.answeredFrom.endsWith(String(server.port))
  line('  change IP+port', both.ok ? `answered from ${both.answeredFrom}` : `— (${both.reason})`)
  line('  change port only', portOnly.ok ? `answered from ${portOnly.answeredFrom}` : `— (${portOnly.reason})`)

  if (changedAddress) filtering = 'endpoint-independent'
  else if (changedPort) filtering = 'address-dependent'
  else filtering = 'address-and-port-dependent'
  break
}

console.log()
line('filtering', filtering)

// ── verdict ─────────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(64))
console.log('\nVerdict')
console.log(`  mapping ${mapping} · filtering ${filtering}`)
console.log()
if (isPublic) {
  console.log('  This machine has a public address. A peer can reach it directly')
  console.log('  with no hole punching at all — the strongest possible result.')
} else if (mapping !== 'endpoint-independent') {
  if (mapping === 'address-dependent') {
    console.log('  Address-dependent mapping. Punching can work but depends on both')
    console.log('  sides sending at the right moment.')
    if (allocation.startsWith('sequential')) {
      console.log('  The sequential allocation helps: the port a peer should aim at')
      console.log('  can be predicted.')
    }
  } else {
    console.log('  Symmetric NAT. Hole punching does not work, and this is worth')
    console.log('  being blunt about: a peer that sends to the endpoint observed')
    console.log('  here will be refused, because that mapping belongs to a different')
    console.log('  destination. No amount of port spraying fixes this — the only')
    console.log('  paths are a relay, or meeting on a shared network.')
  }
} else if (filtering === 'endpoint-independent') {
  console.log('  Full cone: endpoint-independent mapping *and* filtering. The best')
  console.log('  case for hole punching. Any peer that learns the endpoint above can')
  console.log('  reach this machine directly, with no coordination at all.')
} else if (filtering === 'address-dependent') {
  console.log('  Endpoint-independent mapping with address-dependent filtering.')
  console.log('  Hole punching works, but this side has to send first: an inbound')
  console.log('  packet from an address it has not spoken to is dropped.')
} else {
  // Covers both a measured address-and-port filter and an unmeasured one. The
  // advice is the same either way, and saying so is better than inventing a
  // distinction the measurement did not produce.
  if (filtering === 'unmeasured') {
    console.log('  Endpoint-independent mapping — the half that matters most, and')
    console.log('  the good half. Filtering is unmeasured: it needs a server that')
    console.log('  honours CHANGE-REQUEST, or a peer to try against.')
    console.log()
  } else {
    console.log('  Endpoint-independent mapping, filtering by address *and* port.')
  }
  console.log('  Either way this is survivable. Filtering is a per-destination')
  console.log('  rule, so a peer opens it by sending *to* the other address first —')
  console.log('  the classic simultaneous open. With the sequential port allocation')
  console.log('  measured above, the exact port does not have to be guessed right on')
  console.log('  the first try.')
}
console.log()
