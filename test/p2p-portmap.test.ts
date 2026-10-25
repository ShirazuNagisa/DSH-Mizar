/**
 * Port mapping, against a router that either grants or refuses.
 *
 * Two protocols are tested the way they will fail in the field: a gateway that
 * answers (and must be answered correctly), a gateway that refuses (and must be
 * read correctly — a UPnP refusal is HTTP 500 with a code inside), and the one
 * case that decides whether any of this matters: a mapping that shows up in the
 * engine's candidates as an address a peer can actually dial.
 *
 * @module dsh-mizar/test/p2p-portmap
 */
import { createServer, type Server } from 'node:http'
import { randomBytes } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { candidate, CandidateKind } from '../src/transport/p2p/candidate.js'
import { deriveIdentity } from '../src/transport/p2p/crypto.js'
import { Engine } from '../src/transport/p2p/engine.js'
import { STANDARD_POLICY } from '../src/transport/p2p/policy.js'
import {
  describeIGD,
  NATPMPMapper,
  UPnPMapper,
  type PortMapper,
  type PortMapping,
} from '../src/transport/p2p/portmap.js'
import { DatagramSocket, type Datagram } from '../src/transport/p2p/socket.js'
import { MAGIC_COOKIE, bindingRequest, looksLikeSTUN, transactionId } from '../src/transport/p2p/stun.js'

/** Everything a test opened, closed afterwards. */
const closers: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close().catch(() => undefined)
})

/**
 * A gateway that speaks NAT-PMP and records what it was asked.
 * @param resultCode - 0 to grant, anything else to refuse.
 */
async function fakeGateway(resultCode = 0): Promise<{
  address: string
  port: number
  requests: Array<{ internalPort: number; suggestedPort: number; lifetime: number }>
}> {
  const socket = await DatagramSocket.bind(0)
  const requests: Array<{ internalPort: number; suggestedPort: number; lifetime: number }> = []
  const loop = (async (): Promise<void> => {
    for await (const datagram of socket.events()) {
      if (datagram.data.length < 12) continue
      requests.push({
        internalPort: datagram.data.readUInt16BE(4),
        suggestedPort: datagram.data.readUInt16BE(6),
        lifetime: datagram.data.readUInt32BE(8),
      })
      const internalPort = datagram.data.readUInt16BE(4)
      const lifetime = datagram.data.readUInt32BE(8)
      const response = Buffer.alloc(16)
      response.writeUInt8(0, 0)
      response.writeUInt8(0x80, 1) // opcode 0, response bit
      response.writeUInt16BE(resultCode, 2)
      response.writeUInt32BE(0, 4) // epoch
      response.writeUInt16BE(internalPort, 8)
      // The gateway picks its own external port; deliberately not the suggested
      // one, so a mapper that echoes the suggestion instead of reading the
      // answer fails this test.
      response.writeUInt16BE(internalPort === 0 ? 0 : 41234, 10)
      response.writeUInt32BE(lifetime, 12)
      await socket.send(response, datagram.from)
    }
  })()
  closers.push(async () => {
    await socket.close()
    await loop
  })
  return { address: '127.0.0.1', port: socket.localPort, requests }
}

describe('NAT-PMP', () => {
  it('asks for the port and reports what the gateway granted', async () => {
    const gateway = await fakeGateway()
    const mapper = await NATPMPMapper.open(gateway.address, gateway.port)
    closers.push(async () => {
      await mapper.close()
    })

    const mapping = await mapper.map(40001, 3600)
    // 41234, not the 40001 suggested: the answer is the router's, not ours.
    expect(mapping.externalPort).toBe(41234)
    expect(mapping.lifetimeSeconds).toBe(3600)
    expect(gateway.requests[0]).toEqual({ internalPort: 40001, suggestedPort: 40001, lifetime: 3600 })
  })

  it('deletes by asking for a zero lifetime', async () => {
    const gateway = await fakeGateway()
    const mapper = await NATPMPMapper.open(gateway.address, gateway.port)
    closers.push(async () => {
      await mapper.close()
    })
    await mapper.map(40002, 0)
    await mapper.remove()
    expect(gateway.requests.at(-1)).toEqual({ internalPort: 40002, suggestedPort: 0, lifetime: 0 })
  })

  it('reports a refusal instead of pretending', async () => {
    const gateway = await fakeGateway(2) // "not authorized"
    const mapper = await NATPMPMapper.open(gateway.address, gateway.port)
    closers.push(async () => {
      await mapper.close()
    })
    await expect(mapper.map(40003, 0)).rejects.toThrow(/refused/)
  })

  it('gives up when nothing answers', async () => {
    // A port bound by nobody: the requests go into the void.
    const mapper = await NATPMPMapper.open('127.0.0.1', 9)
    closers.push(async () => {
      await mapper.close()
    })
    await expect(mapper.map(40004, 0)).rejects.toThrow(/did not answer/)
  }, 5000)
})

/** An IGD that serves a description and answers SOAP, recording the bodies. */
async function fakeIGD(options: { refuse?: number } = {}): Promise<{
  descriptionURL: string
  bodies: string[]
}> {
  const bodies: string[] = []
  const server: Server = createServer((request, response) => {
    if (request.url === '/desc.xml') {
      response.setHeader('Content-Type', 'text/xml')
      response.end(
        `<?xml version="1.0"?><root><device><serviceList><service>` +
          `<serviceType>urn:schemas-upnp-org:service:WANIPConnection:1</serviceType>` +
          `<controlURL>/control</controlURL>` +
          `</service></serviceList></device></root>`,
      )
      return
    }
    let body = ''
    request.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8')
    })
    request.on('end', () => {
      bodies.push(body)
      if (options.refuse !== undefined) {
        response.statusCode = 500
        response.end(
          `<?xml version="1.0"?><s:Envelope><s:Body><s:Fault><detail><UPnPError>` +
            `<errorCode>${options.refuse}</errorCode><errorDescription>refused</errorDescription>` +
            `</UPnPError></detail></s:Fault></s:Body></s:Envelope>`,
        )
        return
      }
      response.setHeader('Content-Type', 'text/xml')
      response.end(
        `<?xml version="1.0"?><s:Envelope><s:Body><u:AddPortMappingResponse xmlns:u="urn:schemas-upnp-org:service:WANIPConnection:1"/>` +
          `</s:Body></s:Envelope>`,
      )
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  // A server still holding the socket keeps vitest alive; not closing it is a
  // leak, closing it is not optional.
  closers.push(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
  return { descriptionURL: `http://127.0.0.1:${port}/desc.xml`, bodies }
}

describe('UPnP-IGD', () => {
  it('finds the control endpoint in the description', async () => {
    const igd = await fakeIGD()
    const device = await describeIGD(igd.descriptionURL)
    expect(device?.serviceType).toBe('urn:schemas-upnp-org:service:WANIPConnection:1')
    // Relative control URLs are resolved against the description's own URL —
    // routers write them both ways and a raw string is useless to fetch.
    expect(device?.controlURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/control$/)
  })

  it('sends the mapping the router needs', async () => {
    const igd = await fakeIGD()
    const device = await describeIGD(igd.descriptionURL)
    if (device === null) throw new Error('the fake IGD did not describe itself')
    const mapper = UPnPMapper.create(device, '192.168.1.10')

    const mapping = await mapper.map(40010, 0)
    expect(mapping.externalPort).toBe(40010)
    const body = igd.bodies.at(-1) ?? ''
    for (const fragment of [
      '<NewExternalPort>40010</NewExternalPort>',
      '<NewProtocol>UDP</NewProtocol>',
      '<NewInternalPort>40010</NewInternalPort>',
      '<NewInternalClient>192.168.1.10</NewInternalClient>',
      '<NewEnabled>1</NewEnabled>',
      '<NewLeaseDuration>0</NewLeaseDuration>',
      'AddPortMapping',
    ]) {
      expect(body).toContain(fragment)
    }
  })

  it('removes the mapping it added', async () => {
    const igd = await fakeIGD()
    const device = await describeIGD(igd.descriptionURL)
    if (device === null) throw new Error('the fake IGD did not describe itself')
    const mapper = UPnPMapper.create(device, '192.168.1.10')
    await mapper.map(40011, 0)
    await mapper.remove()
    expect(igd.bodies.at(-1) ?? '').toContain('DeletePortMapping')
    expect(igd.bodies.at(-1) ?? '').toContain('<NewExternalPort>40011</NewExternalPort>')
  })

  it('reads the error code out of a refusal', async () => {
    // 718 is ConflictInMappingEntry — the one a user actually hits when
    // something else on the LAN already forwards that port.
    const igd = await fakeIGD({ refuse: 718 })
    const device = await describeIGD(igd.descriptionURL)
    if (device === null) throw new Error('the fake IGD did not describe itself')
    const mapper = UPnPMapper.create(device, '192.168.1.10')
    await expect(mapper.map(40012, 0)).rejects.toThrow(/718/)
  })
})

/** A STUN responder that reports one fixed mapping, for the engine test. */
async function fakeSTUN(address = '203.0.113.9', port = 4444): Promise<number> {
  const socket = await DatagramSocket.bind(0)
  const loop = (async (): Promise<void> => {
    for await (const datagram of socket.events()) {
      if (!looksLikeSTUN(datagram.data)) continue
      const id = transactionId(datagram.data)
      const cookie = Buffer.alloc(4)
      cookie.writeUInt32BE(MAGIC_COOKIE, 0)
      const attribute = Buffer.alloc(12)
      attribute.writeUInt16BE(0x0020, 0) // XOR-MAPPED-ADDRESS
      attribute.writeUInt16BE(8, 2)
      attribute.writeUInt8(0, 4) // reserved
      attribute.writeUInt8(1, 5) // IPv4
      attribute.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 6)
      const octets = address.split('.').map(Number)
      for (let index = 0; index < 4; index += 1) {
        attribute.writeUInt8((octets[index] ?? 0) ^ cookie.readUInt8(index), 8 + index)
      }
      const header = Buffer.alloc(20)
      header.writeUInt16BE(0x0101, 0)
      header.writeUInt16BE(attribute.length, 2)
      header.writeUInt32BE(MAGIC_COOKIE, 4)
      id.copy(header, 8)
      await socket.send(Buffer.concat([header, attribute]), datagram.from)
    }
  })()
  closers.push(async () => {
    await socket.close()
    await loop
  })
  return socket.localPort
}

/** A mapper that grants whatever it is asked, and records the calls. */
function stubMapper(): PortMapper & { calls: string[] } {
  const calls: string[] = []
  let current: PortMapping | null = null
  return {
    provider: 'stub',
    calls,
    get current() {
      return current
    },
    async map(internalPort: number) {
      calls.push(`map:${internalPort}`)
      current = { externalPort: 55555, lifetimeSeconds: 0 }
      return current
    },
    async renew() {
      calls.push('renew')
      return current ?? { externalPort: 55555, lifetimeSeconds: 0 }
    },
    async remove() {
      calls.push('remove')
      current = null
    },
    async close() {
      calls.push('close')
    },
  }
}

describe('the engine', () => {
  it('advertises a forwarded port next to the reflexive address, and deletes it on close', async () => {
    const stunPort = await fakeSTUN()
    const mapper = stubMapper()
    const engine = await Engine.create({
      identity: deriveIdentity(randomBytes(32), 'host'),
      policy: STANDARD_POLICY,
      stunServers: [`127.0.0.1:${stunPort}`],
      portMapper: mapper,
    })
    closers.push(async () => {
      await engine.close()
    })

    const candidates = engine.localCandidates()
    const reflexive = candidates.filter((entry) => entry.kind === CandidateKind.ServerReflexive)
    // Two reflexive-looking candidates: what STUN saw, and the port the router
    // forwards. The forwarded one is first — it works from places the other
    // does not.
    expect(reflexive.map((entry) => `${entry.address}:${entry.port}`)).toEqual([
      '203.0.113.9:55555',
      '203.0.113.9:4444',
    ])
    expect(mapper.calls.some((call) => call.startsWith('map:'))).toBe(true)

    await engine.close()
    expect(mapper.calls).toContain('remove')
    expect(mapper.calls).toContain('close')
  })

  it('drops a mapping it cannot put an address on', async () => {
    // No STUN: the mapper is granted, but there is no external address to pair
    // the port with, so advertising it would be advertising half an address.
    const mapper = stubMapper()
    const engine = await Engine.create({
      identity: deriveIdentity(randomBytes(32), 'host'),
      policy: STANDARD_POLICY,
      stunServers: [],
      portMapper: mapper,
    })
    closers.push(async () => {
      await engine.close()
    })

    expect(engine.localCandidates().some((entry) => entry.port === 55555)).toBe(false)
    expect(mapper.calls).toContain('remove')
  })

  it('keeps the plain reflexive candidate when the mapping fails', async () => {
    const stunPort = await fakeSTUN()
    const failing: PortMapper = {
      provider: 'failing',
      current: null,
      async map() {
        throw new Error('the router said no')
      },
      async renew() {
        throw new Error('the router said no')
      },
      async remove() {},
      async close() {},
    }
    const engine = await Engine.create({
      identity: deriveIdentity(randomBytes(32), 'host'),
      policy: STANDARD_POLICY,
      stunServers: [`127.0.0.1:${stunPort}`],
      portMapper: failing,
    })
    closers.push(async () => {
      await engine.close()
    })
    // Punching still works exactly as before: a refused favicon is a favicon
    // that does not exist, not a broken engine.
    expect(engine.localCandidates().some((entry) => entry.port === 4444)).toBe(true)
  })
})

describe('candidates', () => {
  it('orders a forwarded port above the plain reflexive one it shares a kind with', () => {
    const plain = candidate(CandidateKind.ServerReflexive, '203.0.113.9', 4444)
    const forwarded = candidate(CandidateKind.ServerReflexive, '203.0.113.9', 55555, 1)
    expect(forwarded.priority).toBeGreaterThan(plain.priority)
  })
})
