/**
 * A UDP socket the engine can hold for its whole life.
 *
 * One socket, bound once, never rebound. That is not an implementation
 * preference: a NAT creates its mapping per socket, and the punch depends on
 * the local port staying the same for the lifetime of the connection.
 *
 * Datagrams arrive through {@link DatagramSocket.events}, which is sequential
 * by construction — the engine's dispatch loop and every session's reassembly
 * rely on packet order matching arrival order.
 *
 * @module dsh-mizar/transport/p2p/socket
 */
/** An address on the wire. */
export interface Address {
    readonly address: string;
    readonly port: number;
}
/** One received datagram and where it came from. */
export interface Datagram {
    readonly data: Buffer;
    readonly from: Address;
}
/** A bound UDP socket. */
export declare class DatagramSocket {
    private readonly socket;
    private readonly queue;
    private readonly waiters;
    private closed;
    private readonly boundPort;
    private constructor();
    /**
     * Bind a socket.
     * @param port - the port to bind, or 0 for an ephemeral one.
     * @returns the bound socket.
     */
    static bind(port?: number): Promise<DatagramSocket>;
    /** The port this socket is bound to. */
    get localPort(): number;
    /**
     * Send one datagram.
     * @param data - the bytes.
     * @param to - the destination.
     */
    send(data: Buffer, to: Address): Promise<void>;
    /**
     * The datagrams, in arrival order.
     *
     * One consumer: the engine's dispatch loop. A second reader would split the
     * stream by timing rather than by connection id, which is exactly the bug
     * the connection id exists to prevent.
     */
    events(): AsyncGenerator<Datagram>;
    /**
     * Wait for one datagram, and give up after a while.
     *
     * For a request/response exchange — NAT-PMP — where the reader owns the
     * socket for the length of one question. Not interchangeable with
     * {@link events}: a socket has one reader, and mixing the two would split
     * datagrams by timing.
     *
     * @param milliseconds - the budget; omitted means wait forever.
     * @returns the datagram, or `null` when the budget ran out or the socket closed.
     */
    next(milliseconds?: number): Promise<Datagram | null>;
    /** Close the socket and drain the reader. */
    close(): Promise<void>;
    /**
     * The host's own IPv4 addresses.
     *
     * Loopback is included: two endpoints on one machine is the first test, and
     * a LAN address that is not listed is a punch that never leaves the host.
     * Link-local (169.254/16) is skipped — it is what an interface reports when
     * it has no address at all.
     *
     * @returns the addresses, deduplicated.
     */
    static hostAddresses(): string[];
    private push;
}
