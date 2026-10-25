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
/** A granted forwarding. */
export interface PortMapping {
    /** The port the router forwards to this host. */
    readonly externalPort: number;
    /** How long the router promised to keep it, in seconds. Zero means forever. */
    readonly lifetimeSeconds: number;
}
/** A thing that can ask a router for a port. */
export interface PortMapper {
    /** Which protocol answered; for logs. */
    readonly provider: string;
    /** The mapping in force, or `null` before {@link PortMapper.map}. */
    readonly current: PortMapping | null;
    /**
     * Ask for the mapping.
     * @param internalPort - the local port to forward to.
     * @param lifetimeSeconds - how long to ask for; 0 means "until removed".
     */
    map(internalPort: number, lifetimeSeconds: number): Promise<PortMapping>;
    /** Ask again, extending the lease. */
    renew(): Promise<PortMapping>;
    /** Remove the mapping. */
    remove(): Promise<void>;
    /** Release anything the mapper itself holds. */
    close(): Promise<void>;
}
/** NAT-PMP, over a dedicated UDP socket. */
export declare class NATPMPMapper implements PortMapper {
    readonly provider = "nat-pmp";
    private readonly socket;
    private readonly gateway;
    private internalPort;
    private lifetimeSeconds;
    private mapping;
    private constructor();
    /** The mapping in force, once {@link map} has succeeded. */
    get current(): PortMapping | null;
    /**
     * Open a mapper.
     * @param gateway - the gateway's IPv4 address.
     * @param port - the gateway's NAT-PMP port. Fixed at 5351 by the RFC; the
     *   override exists so a test can stand in for a gateway without binding a
     *   well-known number.
     * @returns the mapper.
     */
    static open(gateway: string, port?: number): Promise<NATPMPMapper>;
    map(internalPort: number, lifetimeSeconds: number): Promise<PortMapping>;
    renew(): Promise<PortMapping>;
    remove(): Promise<void>;
    close(): Promise<void>;
    /**
     * One request/response exchange, retried.
     *
     * NAT-PMP runs over UDP with no session, so the first packet can be lost to
     * a busy router. Three attempts at 250ms is short enough to stay inside a
     * dial budget and long enough to survive one drop.
     */
    private request;
}
/** A gateway that answered SSDP, with the control endpoint for its service. */
export interface IGDDevice {
    /** The SOAP endpoint. */
    readonly controlURL: string;
    /** The service type that endpoint implements. */
    readonly serviceType: string;
}
/** UPnP-IGD, over HTTP and SOAP. */
export declare class UPnPMapper implements PortMapper {
    readonly provider = "upnp-igd";
    private readonly device;
    private readonly localAddress;
    private internalPort;
    private lifetimeSeconds;
    private mapping;
    private constructor();
    /**
     * Open a mapper.
     * @param device - the IGD's control endpoint.
     * @param localAddress - the address to forward to; the router must be able
     *   to reach it, which is why it is the LAN address and not loopback.
     * @returns the mapper.
     */
    static create(device: IGDDevice, localAddress: string): UPnPMapper;
    /** The mapping in force, once {@link map} has succeeded. */
    get current(): PortMapping | null;
    map(internalPort: number, lifetimeSeconds: number): Promise<PortMapping>;
    renew(): Promise<PortMapping>;
    remove(): Promise<void>;
    close(): Promise<void>;
    private addPortMapping;
    /**
     * One SOAP call.
     *
     * A UPnP refusal arrives as HTTP 500 with a `UPnPError` body, so the status
     * code alone is not enough — the error code inside is what says whether the
     * port is taken (718) or UPnP is disabled (401).
     */
    private soap;
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
export declare function discoverIGD(): Promise<IGDDevice | null>;
/**
 * Read an IGD's description document and find its control endpoint.
 * @param location - the `LOCATION` URL from SSDP.
 * @returns the device, or `null` when the document names no usable service.
 */
export declare function describeIGD(location: string): Promise<IGDDevice | null>;
/** What the caller can tell the orchestrator. */
export interface PortMappingOptions {
    /** The internal port to forward. */
    readonly internalPort: number;
    /** The gateway's IPv4 address, when NAT-PMP should be tried. */
    readonly gateway?: string;
    /** A known IGD description URL, skipping SSDP. */
    readonly descriptionURL?: string;
    /** The address the router should forward to; defaults to the LAN address. */
    readonly localAddress?: string;
    /** How long to ask for. Zero means permanent. */
    readonly lifetimeSeconds?: number;
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
export declare function openPortMapping(options: PortMappingOptions): Promise<PortMapper | null>;
/**
 * The LAN address a router could forward to.
 *
 * Loopback is useless here — the router cannot reach it — so this picks the
 * first non-internal IPv4 address and gives up when there is none.
 *
 * @returns the address, or `null`.
 */
export declare function defaultLocalAddress(): string | null;
