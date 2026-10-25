/**
 * Asking the router to open a door.
 *
 * The matrix says exactly one thing cannot be punched: a symmetric NAT on the
 * side being dialled. Its mapping changes per destination, so nothing a peer
 * learns about it is true for the peer itself. STUN cannot help, and neither
 * can more punch rounds — the address the peer has is genuinely not the
 * address this side answers on.
 *
 * What can help is not asking the NAT at all. A port mapping is a request to
 * the gateway: "forward this UDP port to me, permanently". A router that
 * grants it turns the endpoint into something every dialer can reach, cone or
 * symmetric, which is why this is the highest-value NAT traversal work left.
 *
 * Two protocols, because consumer routers speak one or the other:
 *
 *  - **UPnP-IGD** — SSDP discovery, then SOAP. What most home routers ship.
 *  - **NAT-PMP** — a twelve-byte binary request to the gateway on port 5351.
 *    Simpler and faster, found on Apple routers and some others.
 *
 * Neither carries the external address (NAT-PMP does not, and IGD's is a
 * separate call), so the caller pairs the mapped *port* with the address STUN
 * already reported. That is the one thing this module cannot do alone, and the
 * engine does it in `engine.ts`.
 *
 * Failing is normal and cheap: a router with UPnP off, a network that blocks
 * multicast, a corporate gateway. Every failure here returns `null` and the
 * punch proceeds exactly as it would have.
 *
 * @module dsh-mizar/transport/p2p/portmap
 */

import { createSocket, type Socket } from 'node:dgram'
import { networkInterfaces } from 'node:os'
import { DatagramSocket } from './socket.js'

/** A granted forwarding. */
export interface PortMapping {
  /** The port the router forwards to this host. */
  readonly externalPort: number
  /** How long the router promised to keep it, in seconds. Zero means forever. */
  readonly lifetimeSeconds: number
}

/** A thing that can ask a router for a port. */
export interface PortMapper {
  /** Which protocol answered; for logs. */
  readonly provider: string
  /** The mapping in force, or `null` before {@link PortMapper.map}. */
  readonly current: PortMapping | null
  /**
   * Ask for the mapping.
   * @param internalPort - the local port to forward to.
   * @param lifetimeSeconds - how long to ask for; 0 means "until removed".
   */
  map(internalPort: number, lifetimeSeconds: number): Promise<PortMapping>
  /** Ask again, extending the lease. */
  renew(): Promise<PortMapping>
  /** Remove the mapping. */
  remove(): Promise<void>
  /** Release anything the mapper itself holds. */
  close(): Promise<void>
}

// MARK: - NAT-PMP

/** The port NAT-PMP listens on, at the gateway. */
const NATPMP_PORT = 5351

/** Opcode 0: a UDP mapping. */
const NATPMP_OPCODE_UDP = 0

/** How many times a NAT-PMP request is retried, and how long between. */
const NATPMP_ATTEMPTS = 3
const NATPMP_RETRY_MS = 250

/** NAT-PMP, over a dedicated UDP socket. */
export class NATPMPMapper implements PortMapper {
  readonly provider = 'nat-pmp'

  private readonly socket: DatagramSocket
  private readonly gateway: { address: string; port: number }
  private internalPort = 0
  private lifetimeSeconds = 0
  private mapping: PortMapping | null = null

  private constructor(socket: DatagramSocket, gateway: { address: string; port: number }) {
    this.socket = socket
    this.gateway = gateway
  }

  /** The mapping in force, once {@link map} has succeeded. */
  get current(): PortMapping | null {
    return this.mapping
  }

  /**
   * Open a mapper.
   * @param gateway - the gateway's IPv4 address.
   * @param port - the gateway's NAT-PMP port. Fixed at 5351 by the RFC; the
   *   override exists so a test can stand in for a gateway without binding a
   *   well-known number.
   * @returns the mapper.
   */
  static async open(gateway: string, port: number = NATPMP_PORT): Promise<NATPMPMapper> {
    const socket = await DatagramSocket.bind(0)
    return new NATPMPMapper(socket, { address: gateway, port })
  }

  async map(internalPort: number, lifetimeSeconds: number): Promise<PortMapping> {
    this.internalPort = internalPort
    this.lifetimeSeconds = lifetimeSeconds
    const mapping = await this.request(internalPort, internalPort, lifetimeSeconds)
    this.mapping = mapping
    return mapping
  }

  async renew(): Promise<PortMapping> {
    if (this.mapping === null) throw new Error('nothing to renew')
    const mapping = await this.request(this.internalPort, this.mapping.externalPort, this.lifetimeSeconds)
    this.mapping = mapping
    return mapping
  }

  async remove(): Promise<void> {
    if (this.mapping === null) return
    // A zero lifetime is the delete: NAT-PMP has no separate opcode for it.
    await this.request(this.internalPort, 0, 0).catch(() => undefined)
    this.mapping = null
  }

  async close(): Promise<void> {
    await this.socket.close()
  }

  /**
   * One request/response exchange, retried.
   *
   * NAT-PMP runs over UDP with no session, so the first packet can be lost to
   * a busy router. Three attempts at 250ms is short enough to stay inside a
   * dial budget and long enough to survive one drop.
   */
  private async request(internalPort: number, suggestedExternalPort: number, lifetimeSeconds: number): Promise<PortMapping> {
    const request = Buffer.alloc(12)
    request.writeUInt8(0, 0) // version
    request.writeUInt8(NATPMP_OPCODE_UDP, 1)
    request.writeUInt16BE(0, 2) // reserved
    request.writeUInt16BE(internalPort, 4)
    request.writeUInt16BE(suggestedExternalPort, 6)
    request.writeUInt32BE(lifetimeSeconds, 8)

    for (let attempt = 0; attempt < NATPMP_ATTEMPTS; attempt += 1) {
      await this.socket.send(request, this.gateway)
      const reply = await this.socket.next(NATPMP_RETRY_MS)
      if (reply === null) continue
      return parseNATPMPResponse(reply.data)
    }
    throw new Error('the gateway did not answer a NAT-PMP request')
  }
}

/**
 * Parse a NAT-PMP mapping response.
 * @param data - the datagram.
 * @returns the mapping.
 * @throws when the response is malformed or the gateway refused.
 */
function parseNATPMPResponse(data: Buffer): PortMapping {
  if (data.length < 16) throw new Error('short NAT-PMP response')
  if (data.readUInt8(0) !== 0) throw new Error('not a NAT-PMP v0 response')
  const opcode = data.readUInt8(1)
  if ((opcode & 0x7f) !== NATPMP_OPCODE_UDP) throw new Error('unexpected NAT-PMP opcode')
  const result = data.readUInt16BE(2)
  if (result !== 0) throw new Error(`the gateway refused the mapping (result ${result})`)
  return {
    // The mapped port sits after the epoch, the internal port and the result.
    externalPort: data.readUInt16BE(10),
    lifetimeSeconds: data.readUInt32BE(12),
  }
}

// MARK: - UPnP-IGD

/** Where SSDP listens. */
const SSDP_ADDRESS = '239.255.255.250'
const SSDP_PORT = 1900

/** How long to wait for SSDP replies. */
const SSDP_WINDOW_MS = 2000

/** The service types that can add a port mapping, in preference order. */
const IGD_SERVICE_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
]

/** A gateway that answered SSDP, with the control endpoint for its service. */
export interface IGDDevice {
  /** The SOAP endpoint. */
  readonly controlURL: string
  /** The service type that endpoint implements. */
  readonly serviceType: string
}

/** UPnP-IGD, over HTTP and SOAP. */
export class UPnPMapper implements PortMapper {
  readonly provider = 'upnp-igd'

  private readonly device: IGDDevice
  private readonly localAddress: string
  private internalPort = 0
  private lifetimeSeconds = 0
  private mapping: PortMapping | null = null

  private constructor(device: IGDDevice, localAddress: string) {
    this.device = device
    this.localAddress = localAddress
  }

  /**
   * Open a mapper.
   * @param device - the IGD's control endpoint.
   * @param localAddress - the address to forward to; the router must be able
   *   to reach it, which is why it is the LAN address and not loopback.
   * @returns the mapper.
   */
  static create(device: IGDDevice, localAddress: string): UPnPMapper {
    return new UPnPMapper(device, localAddress)
  }

  /** The mapping in force, once {@link map} has succeeded. */
  get current(): PortMapping | null {
    return this.mapping
  }

  async map(internalPort: number, lifetimeSeconds: number): Promise<PortMapping> {
    this.internalPort = internalPort
    this.lifetimeSeconds = lifetimeSeconds
    const mapping = await this.addPortMapping(internalPort, lifetimeSeconds)
    this.mapping = mapping
    return mapping
  }

  async renew(): Promise<PortMapping> {
    if (this.internalPort === 0) throw new Error('nothing to renew')
    // Re-adding the same external port is how UPnP renews: there is no renew
    // action, and a refresh with the same tuple is idempotent.
    const mapping = await this.addPortMapping(this.internalPort, this.lifetimeSeconds)
    this.mapping = mapping
    return mapping
  }

  async remove(): Promise<void> {
    await this.soap('DeletePortMapping', {
      NewRemoteHost: '',
      NewExternalPort: String(this.internalPort),
      NewProtocol: 'UDP',
    })
    this.mapping = null
  }

  async close(): Promise<void> {
    // Nothing held: the mapping belongs to the router until it is deleted or
    // the lease runs out.
  }

  private async addPortMapping(internalPort: number, lifetimeSeconds: number): Promise<PortMapping> {
    await this.soap('AddPortMapping', {
      NewRemoteHost: '',
      NewExternalPort: String(internalPort),
      NewProtocol: 'UDP',
      NewInternalPort: String(internalPort),
      NewInternalClient: this.localAddress,
      NewEnabled: '1',
      NewPortMappingDescription: 'mizar-net',
      // 0 asks for a permanent mapping. A router that insists on a lease
      // grants a shorter one, which is what renew() is for.
      NewLeaseDuration: String(lifetimeSeconds),
    })
    return { externalPort: internalPort, lifetimeSeconds }
  }

  /**
   * One SOAP call.
   *
   * A UPnP refusal arrives as HTTP 500 with a `UPnPError` body, so the status
   * code alone is not enough — the error code inside is what says whether the
   * port is taken (718) or UPnP is disabled (401).
   */
  private async soap(action: string, args: Readonly<Record<string, string>>): Promise<void> {
    const body =
      '<?xml version="1.0"?>' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      `<s:Body><u:${action} xmlns:u="${this.device.serviceType}">` +
      Object.entries(args)
        .map(([key, value]) => `<${key}>${escapeXML(value)}</${key}>`)
        .join('') +
      `</u:${action}></s:Body></s:Envelope>`

    const response = await fetch(this.device.controlURL, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: `"${this.device.serviceType}#${action}"`,
      },
      body,
    })
    const text = await response.text()
    if (!response.ok) {
      const code = /<errorCode>(\d+)<\/errorCode>/.exec(text)?.[1] ?? 'unknown'
      throw new Error(`UPnP ${action} failed with error ${code}`)
    }
  }
}

/**
 * Escape the five characters XML cares about.
 * @param value - the raw text.
 * @returns the escaped text.
 */
function escapeXML(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Find a gateway's IGD control endpoint over SSDP.
 *
 * Multicast discovery is best-effort by nature: a network that blocks it, a
 * router with UPnP off, or a guest Wi-Fi all produce an empty result, and the
 * caller proceeds without a mapping.
 *
 * @returns the device, or `null` when nothing answered usefully.
 */
export async function discoverIGD(): Promise<IGDDevice | null> {
  const socket: Socket = createSocket({ type: 'udp4', reuseAddr: true })
  const locations = new Set<string>()
  try {
    await new Promise<void>((resolve) => socket.bind(0, () => resolve()))
    socket.on('message', (data: Buffer) => {
      const location = /^location:\s*(.+)$/im.exec(data.toString('utf8'))?.[1]?.trim()
      if (location !== undefined) locations.add(location)
    })
    const search =
      'M-SEARCH * HTTP/1.1\r\n' +
      `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n` +
      'MAN: "ssdp:discover"\r\n' +
      'MX: 2\r\n' +
      `ST: ${IGD_SERVICE_TYPES[1]}\r\n\r\n`
    socket.send(Buffer.from(search, 'utf8'), SSDP_PORT, SSDP_ADDRESS, () => undefined)
    await sleep(SSDP_WINDOW_MS)
  } finally {
    socket.close()
  }

  for (const location of locations) {
    const device = await describeIGD(location)
    if (device !== null) return device
  }
  return null
}

/**
 * Read an IGD's description document and find its control endpoint.
 * @param location - the `LOCATION` URL from SSDP.
 * @returns the device, or `null` when the document names no usable service.
 */
export async function describeIGD(location: string): Promise<IGDDevice | null> {
  const response = await fetch(location)
  if (!response.ok) return null
  const xml = await response.text()
  // Two tags out of a large document — a real XML parser would be a dependency
  // for a regex-shaped job. Anything that is not these two tags is ignored.
  for (const serviceType of IGD_SERVICE_TYPES) {
    const block = new RegExp(`<service>(?:(?!</service>)[\\s\\S])*<serviceType>\\s*${escapeRegExp(serviceType)}\\s*</serviceType>[\\s\\S]*?</service>`).exec(xml)
    if (block === null) continue
    const controlPath = /<controlURL>\s*([^<]+?)\s*<\/controlURL>/.exec(block[0])?.[1]
    if (controlPath === undefined) continue
    return { controlURL: new URL(controlPath, location).toString(), serviceType }
  }
  return null
}

/**
 * Escape a string for use inside a regular expression.
 * @param text - the literal.
 * @returns the pattern-safe form.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// MARK: - The orchestrator

/** What the caller can tell the orchestrator. */
export interface PortMappingOptions {
  /** The internal port to forward. */
  readonly internalPort: number
  /** The gateway's IPv4 address, when NAT-PMP should be tried. */
  readonly gateway?: string
  /** A known IGD description URL, skipping SSDP. */
  readonly descriptionURL?: string
  /** The address the router should forward to; defaults to the LAN address. */
  readonly localAddress?: string
  /** How long to ask for. Zero means permanent. */
  readonly lifetimeSeconds?: number
}

/**
 * Try every protocol this host can, and return the first mapper that works.
 *
 * UPnP first, because that is what consumer routers actually ship; NAT-PMP
 * second, because when it is there it is one round trip. A gateway that
 * refuses both is not an error — it is the common case on a network somebody
 * else administers.
 *
 * @param options - the port, and whatever the caller already knows.
 * @returns a working mapper, or `null` when no router agreed.
 */
export async function openPortMapping(options: PortMappingOptions): Promise<PortMapper | null> {
  const localAddress = options.localAddress ?? defaultLocalAddress()
  if (localAddress === null) return null
  const lifetime = options.lifetimeSeconds ?? 0

  try {
    const device = options.descriptionURL !== undefined
      ? await describeIGD(options.descriptionURL)
      : await discoverIGD()
    if (device !== null) {
      const mapper = UPnPMapper.create(device, localAddress)
      await mapper.map(options.internalPort, lifetime)
      return mapper
    }
  } catch {
    // A router that answers SSDP but refuses SOAP is a router to stop asking.
  }

  if (options.gateway !== undefined) {
    try {
      const mapper = await NATPMPMapper.open(options.gateway)
      if (mapper !== null) {
        await mapper.map(options.internalPort, lifetime)
        return mapper
      }
    } catch {
      // Same story: one refusal is the answer.
    }
  }
  return null
}

/**
 * The LAN address a router could forward to.
 *
 * Loopback is useless here — the router cannot reach it — so this picks the
 * first non-internal IPv4 address and gives up when there is none.
 *
 * @returns the address, or `null`.
 */
export function defaultLocalAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      return entry.address
    }
  }
  return null
}

/**
 * Wait.
 * @param milliseconds - how long.
 */
function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}
