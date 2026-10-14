/**
 * The Mizar listener.
 *
 * A standalone `node:http` server plus one WebSocket endpoint, deliberately
 * separate from DSH's own webserver. DSH's server carries no TLS, no
 * authentication and no origin policy of its own, and the web app refuses to
 * bind it beyond loopback for good reason; by owning its own listener Mizar
 * never has to touch that posture, can bind exactly the tailnet addresses it
 * chose, and can carry its own device-credential model.
 *
 * The plain-HTTP surface is exactly two endpoints — an identity probe and the
 * one unauthenticated state change, pairing. Everything else travels over the
 * authenticated socket.
 *
 * @module dsh-mizar/server/listener
 */
import { createServer } from 'node:http';
import { hostname } from 'node:os';
import { WebSocketServer } from 'ws';
import { createDeviceRecord, issueToken, revokeDevice, touchDevice, verifyToken } from '../auth/devices.js';
import { issueCode, RateLimiter, redeemCode } from '../auth/pairing.js';
import { MizarStore } from '../auth/store.js';
import { authorityOf } from '../net/interfaces.js';
import { encodeFrame, ERROR_CODES, errorFrame, HELLO_PATH, okFrame, PAIR_PATH, isHelloFrame, parseClientFrame, PROTOCOL_VERSION, WS_PATH, } from '../protocol/frames.js';
/** Largest accepted request body, in bytes. A pairing request is tiny. */
const MAX_BODY_BYTES = 64 * 1024;
/** Ports probed past the configured one when fallback is enabled. */
const PORT_PROBE_RANGE = 10;
/** How often to sweep the rate limiter's expired windows. */
const RATE_LIMIT_SWEEP_MS = 60_000;
/** A running listener. */
export class MizarListener {
    #servers = [];
    #sockets = new Set();
    #sessions = new Set();
    #limiter;
    #options;
    #plan;
    #hostName;
    #wss;
    #heartbeat;
    #sweep;
    #boundPort = 0;
    constructor(options) {
        this.#options = options;
        this.#plan = options.plan;
        this.#hostName = hostname();
        this.#limiter = new RateLimiter(options.maxAttemptsPerMinute, 60_000);
    }
    /**
     * Bind every planned address on the first free port.
     *
     * The port is probed as a unit across all addresses: a half-bound listener is
     * worse than a failure, because the app would reach one family and not the
     * other with no explanation.
     *
     * @param options - host wiring and configuration.
     * @returns the running listener.
     */
    static async start(options) {
        const listener = new MizarListener(options);
        await listener.#bind();
        listener.#startHeartbeat();
        return listener;
    }
    /** The port actually bound. */
    get port() {
        return this.#boundPort;
    }
    /** The addresses actually bound. */
    get addresses() {
        return this.#plan.addresses;
    }
    /** The `host:port` authorities a phone can dial, one per bound address. */
    get authorities() {
        return this.#plan.addresses.map((address) => authorityOf(address, this.#boundPort));
    }
    /** Every live authenticated session. */
    get sessions() {
        return [...this.#sessions];
    }
    /** How many authenticated clients could currently answer a question. */
    get clientCount() {
        return this.#sessions.size;
    }
    /**
     * Send one frame to every authenticated client.
     *
     * Used for interactions that every client should see — an approval or a
     * question is addressed to the operator, not to one device.
     *
     * @param frame - the frame to deliver.
     */
    broadcast(frame) {
        for (const session of this.#sessions)
            session.send(frame);
    }
    /**
     * Issue a fresh pairing code and persist the slot.
     * @param now - current epoch milliseconds.
     * @returns the code to display.
     */
    async issuePairingCode(now = Date.now()) {
        const issued = issueCode(this.#options.store.secret, this.#options.store.state.pairing, now, this.#options.pairingTtlSeconds);
        await this.#options.store.mutate((state) => ({ ...state, pairing: issued.slot }));
        await this.#options.store.audit({ time: now, event: 'pairing-issued' });
        return { code: issued.code, display: issued.display, expiresAt: issued.slot.expiresAt };
    }
    /**
     * Revoke one device and drop its live sessions.
     * @param deviceId - the device to revoke.
     * @returns whether a device was revoked.
     */
    async revokeDevice(deviceId) {
        const before = this.#options.store.state.devices;
        const after = revokeDevice(before, deviceId);
        if (after === before)
            return false;
        await this.#options.store.mutate((state) => ({ ...state, devices: after }));
        await this.#options.store.audit({ time: Date.now(), event: 'device-revoked', detail: deviceId });
        for (const session of this.#sessions) {
            if (session.deviceId === deviceId)
                session.close(4401, 'device revoked');
        }
        return true;
    }
    /** Close every socket and server. */
    async stop() {
        if (this.#heartbeat !== undefined)
            clearInterval(this.#heartbeat);
        if (this.#sweep !== undefined)
            clearInterval(this.#sweep);
        for (const socket of this.#sockets)
            socket.terminate();
        this.#sockets.clear();
        this.#sessions.clear();
        await new Promise((resolve) => {
            this.#wss?.close(() => resolve());
            if (this.#wss === undefined)
                resolve();
        });
        await Promise.all(this.#servers.map((server) => new Promise((resolve) => {
            server.closeAllConnections?.();
            server.close(() => resolve());
        })));
        this.#servers.length = 0;
    }
    /**
     * Move the listener to a different set of addresses.
     *
     * Used when the host's network changes under it — most often a tailnet that
     * appeared, or came back, after DSH had already started. Connected clients are
     * dropped rather than migrated: their sockets were accepted on an address that
     * may no longer exist, and a phone reconnecting is cheaper than a socket that
     * silently stops delivering.
     *
     * @param plan - the new plan to bind.
     */
    async rebind(plan) {
        await this.#closeServers();
        for (const socket of this.#sockets)
            socket.terminate();
        this.#sockets.clear();
        this.#sessions.clear();
        this.#options.onClientCount?.(0);
        this.#plan = plan;
        await this.#bind();
    }
    /** Bind all planned addresses, probing ports when allowed. */
    async #bind() {
        const plan = this.#plan;
        const { port, portFallback } = this.#options;
        const candidates = portFallback
            ? Array.from({ length: PORT_PROBE_RANGE }, (_, index) => port + index)
            : [port];
        let lastError;
        for (const candidate of candidates) {
            try {
                await this.#bindAll(plan.addresses, candidate);
                // With `port: 0` the OS picks the port, so the candidate is not the
                // answer. Reading it back from the socket is the only way `authorities`
                // can name somewhere a phone could actually dial.
                this.#boundPort = this.#actualPort() ?? candidate;
                if (candidate !== port) {
                    this.#options.log(`port ${port} was busy; listening on ${candidate} instead`);
                }
                if (plan.fellBack)
                    this.#options.log(`bind fallback — ${plan.reason}`);
                this.#options.log(`listening on ${this.addresses.map((a) => authorityOf(a, candidate)).join(', ')}`);
                return;
            }
            catch (error) {
                lastError = error;
                await this.#closeServers();
                if (!isAddressInUse(error))
                    throw error;
            }
        }
        throw new Error(`mizar: no free port in ${port}..${port + candidates.length - 1} — ${describe(lastError)}`);
    }
    /**
     * Listen on every address for one port, rolling back if any address fails.
     * @param addresses - the addresses to bind.
     * @param port - the port to bind.
     */
    async #bindAll(addresses, port) {
        this.#wss = new WebSocketServer({ noServer: true });
        for (const address of addresses) {
            const server = createServer((request, response) => {
                void this.#handleHttp(request, response);
            });
            server.on('upgrade', (request, socket, head) => {
                this.#handleUpgrade(request, socket, head);
            });
            await new Promise((resolve, reject) => {
                const onError = (error) => {
                    server.removeListener('listening', onListening);
                    reject(error);
                };
                const onListening = () => {
                    server.removeListener('error', onError);
                    resolve();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(port, address);
            });
            this.#servers.push(server);
        }
    }
    /** The port the OS actually bound, when a socket is listening. */
    #actualPort() {
        const address = this.#servers[0]?.address();
        if (address === null || address === undefined || typeof address === 'string')
            return undefined;
        return address.port;
    }
    /** Close and forget the servers created by a failed bind attempt. */
    async #closeServers() {
        await Promise.all(this.#servers.map((server) => new Promise((resolve) => {
            server.close(() => resolve());
        })));
        this.#servers.length = 0;
        this.#wss = undefined;
    }
    /** Send WebSocket pings and drop sockets that stop answering. */
    #startHeartbeat() {
        const { heartbeatMs, pongTimeoutMs } = this.#options;
        const grace = Math.max(1, Math.ceil(pongTimeoutMs / heartbeatMs));
        this.#heartbeat = setInterval(() => {
            for (const socket of this.#sockets) {
                const tracked = socket;
                if (tracked.__mizarAlive === false) {
                    tracked.__mizarMisses = (tracked.__mizarMisses ?? 0) + 1;
                    if ((tracked.__mizarMisses ?? 0) >= grace) {
                        socket.terminate();
                        continue;
                    }
                }
                else {
                    tracked.__mizarMisses = 0;
                }
                tracked.__mizarAlive = false;
                try {
                    socket.ping();
                }
                catch {
                    socket.terminate();
                }
            }
        }, heartbeatMs);
        this.#heartbeat.unref?.();
        this.#sweep = setInterval(() => this.#limiter.prune(), RATE_LIMIT_SWEEP_MS);
        this.#sweep.unref?.();
    }
    /**
     * Route one plain-HTTP request.
     * @param request - the inbound request.
     * @param response - the response to write.
     */
    async #handleHttp(request, response) {
        const url = new URL(request.url ?? '/', 'http://localhost');
        try {
            if (url.pathname === HELLO_PATH && request.method === 'GET') {
                this.#writeJson(response, 200, this.#helloBody());
                return;
            }
            if (url.pathname === PAIR_PATH && request.method === 'POST') {
                await this.#handlePair(request, response);
                return;
            }
            // 405 only for a path that exists under a different method. An unknown
            // path is a 404 — conflating the two sends a client hunting for a method
            // it was never going to find.
            if (url.pathname === HELLO_PATH || url.pathname === PAIR_PATH) {
                this.#writeJson(response, 405, { error: 'method not allowed' });
                return;
            }
            this.#writeJson(response, 404, { error: 'not found' });
        }
        catch (error) {
            this.#options.log(`request failed — ${describe(error)}`);
            if (!response.headersSent)
                this.#writeJson(response, 500, { error: 'internal error' });
        }
    }
    /** The unauthenticated identity probe body. */
    #helloBody() {
        const state = this.#options.store.state;
        return {
            hostId: state.hostId,
            hostName: this.#hostName,
            protocolVersion: PROTOCOL_VERSION,
            pairingOpen: state.pairing !== null && state.pairing.expiresAt > Date.now(),
            paired: state.devices.some((device) => device.revokedAt === undefined),
        };
    }
    /**
     * Redeem a pairing code for a device token.
     *
     * This is the only unauthenticated endpoint that changes state, so it is also
     * the only place a limiter is needed.
     *
     * @param request - the inbound request.
     * @param response - the response to write.
     */
    async #handlePair(request, response) {
        const remote = remoteOf(request);
        const verdict = this.#limiter.check(remote);
        if (!verdict.allowed) {
            await this.#options.store.audit({
                time: Date.now(),
                event: 'pairing-failed',
                remote,
                detail: 'rate limited',
            });
            response.setHeader('retry-after', String(Math.ceil(verdict.retryAfterMs / 1000)));
            this.#writeJson(response, 429, { error: 'RATE_LIMITED' });
            return;
        }
        const body = await readBody(request);
        if (body === null) {
            this.#writeJson(response, 413, { error: 'body too large' });
            return;
        }
        let parsed;
        try {
            const value = JSON.parse(body);
            if (typeof value !== 'object' || value === null)
                throw new Error('not an object');
            parsed = value;
        }
        catch {
            this.#writeJson(response, 400, { error: 'MALFORMED_FRAME' });
            return;
        }
        const code = typeof parsed['code'] === 'string' ? parsed['code'] : '';
        const now = Date.now();
        const store = this.#options.store;
        const result = redeemCode(store.secret, store.state.pairing, code, now);
        if (!result.ok) {
            await store.audit({ time: now, event: 'pairing-failed', remote, detail: result.reason });
            // `consumed` and `expired` answer identically on purpose: distinguishing
            // them for the caller would turn this endpoint into an oracle. The audit
            // line above keeps the distinction for the operator.
            const gone = result.reason === 'expired' || result.reason === 'no-code' || result.reason === 'consumed';
            this.#writeJson(response, gone ? 410 : 401, {
                error: result.reason === 'mismatch'
                    ? 'PAIRING_CODE_INVALID'
                    : result.reason === 'expired'
                        ? 'PAIRING_CODE_EXPIRED'
                        : 'PAIRING_CODE_UNKNOWN',
            });
            return;
        }
        const issued = issueToken();
        const device = createDeviceRecord(issued, {
            ...(typeof parsed['deviceName'] === 'string' ? { name: parsed['deviceName'] } : {}),
            ...(typeof parsed['deviceModel'] === 'string' ? { model: parsed['deviceModel'] } : {}),
            ...(typeof parsed['appVersion'] === 'string' ? { appVersion: parsed['appVersion'] } : {}),
        }, now);
        await store.mutate((state) => ({
            ...state,
            pairing: result.slot,
            devices: [...state.devices, device],
        }));
        await store.audit({
            time: now,
            event: 'device-paired',
            remote,
            detail: `${device.name} (${device.tokenPrefix})`,
        });
        const payload = {
            deviceToken: issued.token,
            deviceId: device.deviceId,
            hostId: store.state.hostId,
            hostName: this.#hostName,
            protocolVersion: PROTOCOL_VERSION,
        };
        this.#writeJson(response, 200, payload);
    }
    /**
     * Handle a WebSocket upgrade.
     * @param request - the upgrade request.
     * @param socket - the raw socket.
     * @param head - any bytes already read.
     */
    #handleUpgrade(request, socket, head) {
        const url = new URL(request.url ?? '/', 'http://localhost');
        if (url.pathname !== WS_PATH) {
            socket.destroy();
            return;
        }
        this.#wss?.handleUpgrade(request, socket, head, (websocket) => {
            this.#acceptSocket(websocket, remoteOf(request));
        });
    }
    /**
     * Wire one accepted socket: authenticate on `hello`, then serve requests.
     * @param socket - the accepted socket.
     * @param remote - the remote address.
     */
    #acceptSocket(socket, remote) {
        this.#sockets.add(socket);
        let session;
        const tracked = socket;
        tracked.__mizarAlive = true;
        socket.on('pong', () => {
            tracked.__mizarAlive = true;
        });
        const send = (frame) => {
            if (socket.readyState === socket.OPEN)
                socket.send(encodeFrame(frame));
        };
        // A client that never authenticates is dropped rather than left open; the
        // unauthenticated state is the one an attacker would park in.
        const handshakeTimer = setTimeout(() => {
            if (session === undefined) {
                send(errorFrame('UNAUTHENTICATED', 'no hello frame within the handshake window'));
                socket.close(4401, 'unauthenticated');
            }
        }, 10_000);
        handshakeTimer.unref?.();
        socket.on('message', (data, isBinary) => {
            // Tracked outside the async body so the failure path can still correlate.
            let currentId;
            void (async () => {
                if (isBinary) {
                    send(errorFrame('MALFORMED_FRAME', 'binary frames are not accepted'));
                    return;
                }
                const raw = typeof data === 'string' ? data : data.toString('utf8');
                const parsed = parseClientFrame(raw);
                if (!parsed.ok) {
                    send(errorFrame(parsed.code, parsed.message));
                    return;
                }
                const frame = parsed.frame;
                const correlationId = frame.id;
                currentId = correlationId;
                if (isHelloFrame(frame)) {
                    if (session !== undefined) {
                        send(errorFrame('MALFORMED_FRAME', 'already authenticated', correlationId));
                        return;
                    }
                    const device = verifyToken(this.#options.store.state.devices, frame.token);
                    if (device === null) {
                        await this.#options.store.audit({
                            time: Date.now(),
                            event: 'client-rejected',
                            remote,
                            detail: 'unknown or revoked token',
                        });
                        send(errorFrame('UNAUTHENTICATED', 'unknown or revoked device token', correlationId));
                        socket.close(4401, 'unauthenticated');
                        return;
                    }
                    clearTimeout(handshakeTimer);
                    const current = {
                        deviceId: device.deviceId,
                        deviceName: device.name,
                        remote,
                        send,
                        close: (code = 1000, reason = 'closed') => socket.close(code, reason),
                    };
                    session = current;
                    this.#sessions.add(current);
                    this.#options.onClientCount?.(this.#sessions.size);
                    await this.#options.store.mutate((state) => ({
                        ...state,
                        devices: touchDevice(state.devices, device.deviceId),
                    }));
                    await this.#options.store.audit({
                        time: Date.now(),
                        event: 'client-connected',
                        remote,
                        detail: `${device.name} (${device.tokenPrefix})`,
                    });
                    const state = this.#options.store.state;
                    send({
                        v: PROTOCOL_VERSION,
                        type: 'welcome',
                        hostId: state.hostId,
                        hostName: this.#hostName,
                        protocolVersion: PROTOCOL_VERSION,
                        home: process.env['DSH_HOME'] ?? '',
                        deviceId: device.deviceId,
                    });
                    this.#options.onSession?.(current);
                    return;
                }
                if (session === undefined) {
                    send(errorFrame('UNAUTHENTICATED', 'send a hello frame first', correlationId));
                    return;
                }
                if (frame.type === 'ping') {
                    send(okFrame(frame.id, { time: Date.now() }));
                    return;
                }
                const handler = this.#options.methods?.[frame.type];
                if (handler === undefined) {
                    send(errorFrame('NOT_IMPLEMENTED', `method "${frame.type}" is not implemented`, frame.id));
                    return;
                }
                try {
                    const result = await handler(frame.payload, session);
                    send(okFrame(frame.id, result));
                }
                catch (error) {
                    // A method that knows its own failure code may say so; anything else
                    // is an internal fault and must not leak its message shape to a client.
                    const code = error.code;
                    if (typeof code === 'string' && ERROR_CODES.includes(code)) {
                        send(errorFrame(code, describe(error), frame.id));
                    }
                    else {
                        send(errorFrame('INTERNAL', describe(error), frame.id));
                    }
                }
            })().catch((error) => {
                send(errorFrame('INTERNAL', describe(error), currentId));
            });
        });
        const forget = () => {
            clearTimeout(handshakeTimer);
            this.#sockets.delete(socket);
            if (session !== undefined && this.#sessions.delete(session)) {
                this.#options.onClientCount?.(this.#sessions.size);
            }
        };
        socket.on('close', forget);
        socket.on('error', forget);
    }
    /**
     * Write a JSON response.
     * @param response - the response.
     * @param status - the HTTP status.
     * @param body - the JSON body.
     */
    #writeJson(response, status, body) {
        const payload = JSON.stringify(body);
        response.writeHead(status, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': Buffer.byteLength(payload),
            'cache-control': 'no-store',
        });
        response.end(payload);
    }
}
/**
 * Read a request body, refusing anything over the limit.
 * @param request - the inbound request.
 * @returns the body text, or `null` when it is too large.
 */
async function readBody(request) {
    const chunks = [];
    let total = 0;
    for await (const chunk of request) {
        const buffer = chunk;
        total += buffer.length;
        if (total > MAX_BODY_BYTES) {
            request.destroy();
            return null;
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}
/**
 * Extract the remote address from a request.
 * @param request - the inbound request.
 * @returns the address, or an empty string.
 */
function remoteOf(request) {
    return request.socket.remoteAddress ?? '';
}
/**
 * Test whether a bind failure was a port conflict.
 * @param error - the thrown value.
 * @returns whether the address was in use.
 */
function isAddressInUse(error) {
    return error?.code === 'EADDRINUSE';
}
/**
 * Render an unknown thrown value as one line.
 * @param error - the thrown value.
 * @returns a readable description.
 */
function describe(error) {
    if (error instanceof Error)
        return `${error.name}: ${error.message}`;
    return String(error);
}
