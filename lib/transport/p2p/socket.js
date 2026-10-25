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
import { createSocket } from 'node:dgram';
import { networkInterfaces } from 'node:os';
/** A bound UDP socket. */
export class DatagramSocket {
    socket;
    queue = [];
    waiters = [];
    closed = false;
    boundPort;
    constructor(socket, port) {
        this.socket = socket;
        this.boundPort = port;
        socket.on('message', (data, remote) => {
            this.push({ data, from: { address: remote.address, port: remote.port } });
        });
        // A socket-level error (ICMP-induced, address family trouble) must not
        // take the process down: this link is one route among several, and the
        // layer above is responsible for falling back.
        socket.on('error', () => { });
    }
    /**
     * Bind a socket.
     * @param port - the port to bind, or 0 for an ephemeral one.
     * @returns the bound socket.
     */
    static bind(port = 0) {
        const raw = createSocket({ type: 'udp4', reuseAddr: false });
        return new Promise((resolve, reject) => {
            raw.once('error', reject);
            raw.bind(port, () => {
                raw.removeListener('error', reject);
                resolve(new DatagramSocket(raw, raw.address().port));
            });
        });
    }
    /** The port this socket is bound to. */
    get localPort() {
        return this.boundPort;
    }
    /**
     * Send one datagram.
     * @param data - the bytes.
     * @param to - the destination.
     */
    send(data, to) {
        if (this.closed)
            return Promise.reject(new Error('the socket is closed'));
        return new Promise((resolve, reject) => {
            this.socket.send(data, to.port, to.address, (error) => {
                if (error)
                    reject(error);
                else
                    resolve();
            });
        });
    }
    /**
     * The datagrams, in arrival order.
     *
     * One consumer: the engine's dispatch loop. A second reader would split the
     * stream by timing rather than by connection id, which is exactly the bug
     * the connection id exists to prevent.
     */
    async *events() {
        while (true) {
            const next = this.queue.shift();
            if (next !== undefined) {
                yield next;
                continue;
            }
            if (this.closed)
                return;
            const waited = await new Promise((resolve) => this.waiters.push(resolve));
            if (waited === null)
                return;
            yield waited;
        }
    }
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
    next(milliseconds) {
        const queued = this.queue.shift();
        if (queued !== undefined)
            return Promise.resolve(queued);
        if (this.closed)
            return Promise.resolve(null);
        return new Promise((resolve) => {
            let timer;
            const waiter = (value) => {
                if (timer !== undefined)
                    clearTimeout(timer);
                resolve(value);
            };
            this.waiters.push(waiter);
            if (milliseconds !== undefined) {
                timer = setTimeout(() => {
                    const index = this.waiters.indexOf(waiter);
                    if (index >= 0)
                        this.waiters.splice(index, 1);
                    resolve(null);
                }, Math.max(0, milliseconds));
                timer.unref?.();
            }
        });
    }
    /** Close the socket and drain the reader. */
    close() {
        if (this.closed)
            return Promise.resolve();
        this.closed = true;
        for (const waiter of this.waiters.splice(0))
            waiter(null);
        return new Promise((resolve) => this.socket.close(() => resolve()));
    }
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
    static hostAddresses() {
        const seen = new Set();
        for (const entries of Object.values(networkInterfaces())) {
            for (const entry of entries ?? []) {
                if (entry.family !== 'IPv4')
                    continue;
                if (entry.address.startsWith('169.254.'))
                    continue;
                seen.add(entry.address);
            }
        }
        return [...seen];
    }
    push(datagram) {
        const waiter = this.waiters.shift();
        if (waiter !== undefined)
            waiter(datagram);
        else
            this.queue.push(datagram);
    }
}
