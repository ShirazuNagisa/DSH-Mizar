/**
 * The tunnel client: the Mac dialling out.
 *
 * The contract this exists to satisfy is that a Mac behind a firewall which
 * blocks all inbound traffic is still reachable, and the only way to do that is
 * to be the one who dials. So this connects *out* to the relay and holds the
 * connection open; the relay replays phone requests down it and this replays
 * them against the listener already running on loopback.
 *
 * Replaying rather than reimplementing is the point. The listener, the pairing
 * endpoint, the method table and every error code keep working exactly as they
 * do on a LAN, because from their side nothing has changed -- a request arrives
 * on a socket and an answer goes back. Nothing in `src/server/listener.ts` knows
 * this file exists.
 *
 * @module dsh-mizar/relay/client
 */
import { WebSocket } from 'ws';
import { TUNNEL_PATH, TUNNEL_PROTOCOL_VERSION, parseRelayFrame, } from './protocol.js';
/** Headers that describe one hop and must not be replayed onto the next. */
const HOP_BY_HOP = new Set([
    'connection',
    'upgrade',
    'keep-alive',
    'transfer-encoding',
    'te',
    'trailer',
    'proxy-authenticate',
    'proxy-authorization',
    'proxy-connection',
]);
/**
 * Turn a relay URL into the WebSocket URL for the tunnel.
 *
 * @param url - `https://relay.example.com`, `wss://…`, or either with a path.
 * @returns the absolute tunnel URL, or `null` when the URL is unusable.
 */
export function tunnelURL(url) {
    let parsed;
    try {
        parsed = new URL(url);
    }
    catch {
        return null;
    }
    const scheme = parsed.protocol === 'https:' || parsed.protocol === 'wss:'
        ? 'wss:'
        : parsed.protocol === 'http:' || parsed.protocol === 'ws:'
            ? 'ws:'
            : null;
    if (scheme === null)
        return null;
    const base = parsed.pathname.replace(/\/+$/, '');
    const result = new URL(parsed.toString());
    result.protocol = scheme;
    result.pathname = `${base}${TUNNEL_PATH}`;
    result.search = '';
    result.hash = '';
    return result.toString();
}
/**
 * The base URL a phone should be given, for a room.
 *
 * A Mac on the same LAN as its relay may dial a private address while a phone
 * has to use the public one, so this prefers `publicUrl` when it is set. With
 * neither set there is nothing to give a phone, and returning `null` beats
 * inventing a URL that will not resolve.
 *
 * @param url - the relay URL the Mac dials.
 * @param publicUrl - the operator's override, or empty.
 * @param room - the room, when it is known.
 * @returns the base URL, or `null`.
 */
export function phoneBaseURL(url, publicUrl, room) {
    const source = publicUrl === '' ? url : publicUrl;
    let parsed;
    try {
        parsed = new URL(source);
    }
    catch {
        return null;
    }
    // A phone speaks https; the Mac may have been configured with wss or ws.
    parsed.protocol =
        parsed.protocol === 'wss:' || parsed.protocol === 'https:' ? 'https:' : 'http:';
    parsed.hash = '';
    parsed.search = '';
    const base = parsed.toString().replace(/\/+$/, '');
    return room === undefined || room === null ? base : `${base}/r/${room}`;
}
/** Filter replay headers down to the ones that describe the request itself. */
function forwardable(headers) {
    const out = {};
    for (const [name, value] of Object.entries(headers)) {
        if (HOP_BY_HOP.has(name.toLowerCase()))
            continue;
        out[name] = value;
    }
    return out;
}
/** The tunnel client. */
export class RelayClient {
    #options;
    #localOrigin;
    #socket = null;
    #stopped = false;
    #attempt = 0;
    #timer;
    /** Phone WebSockets currently bridged through this tunnel, by tunnel id. */
    #streams = new Map();
    #state = { connected: false, room: null, lastError: null };
    /**
     * @param options - the configuration.
     */
    constructor(options) {
        this.#options = options;
        const host = options.localHost ?? '127.0.0.1';
        this.#localOrigin = `http://${host}:${options.localPort}`;
    }
    /** The relay connection's current state. */
    get state() {
        return this.#state;
    }
    /** The room the relay assigned, or `null` before the first welcome. */
    get room() {
        return this.#state.room;
    }
    /** Connect, and keep reconnecting until {@link stop}. */
    start() {
        this.#stopped = false;
        this.#connect();
    }
    /** Stop reconnecting and close the tunnel. */
    stop() {
        this.#stopped = true;
        if (this.#timer !== undefined)
            clearTimeout(this.#timer);
        this.#timer = undefined;
        this.#closeStreams('the tunnel is shutting down');
        this.#socket?.close(1000, 'shutting down');
        this.#socket = null;
        this.#setState({ connected: false });
    }
    /** Open a connection attempt. */
    #connect() {
        if (this.#stopped)
            return;
        const url = tunnelURL(this.#options.url);
        if (url === null) {
            this.#setState({ connected: false, lastError: `not a usable relay URL: ${this.#options.url}` });
            return;
        }
        const socket = this.#options.socketFactory?.(url, this.#options.token) ??
            new WebSocket(url, {
                headers: { authorization: `Bearer ${this.#options.token}` },
            });
        this.#socket = socket;
        socket.on('open', () => {
            this.#options.log(`relay: connected to ${url}`);
        });
        socket.on('message', (data) => this.#receive(data.toString('utf8')));
        socket.on('error', (error) => {
            this.#options.log(`relay: ${error.message}`);
        });
        socket.on('close', () => {
            this.#socket = null;
            this.#closeStreams('the tunnel closed');
            if (this.#stopped)
                return;
            const delay = this.#backoff();
            this.#setState({ connected: false, lastError: 'the relay connection closed' });
            this.#options.log(`relay: reconnecting in ${Math.round(delay / 1000)}s`);
            this.#timer = setTimeout(() => this.#connect(), delay);
            this.#timer.unref?.();
        });
    }
    /** Exponential backoff with jitter, so many Macs do not return in lockstep. */
    #backoff() {
        const base = this.#options.reconnectBaseMs ?? 1_000;
        const cap = this.#options.reconnectMaxMs ?? 60_000;
        const raw = Math.min(cap, base * 2 ** this.#attempt);
        this.#attempt += 1;
        // Full jitter. A relay restart would otherwise bring every Mac back at once.
        return Math.round(raw / 2 + Math.random() * (raw / 2));
    }
    /** Merge a state change and report it. */
    #setState(patch) {
        this.#state = { ...this.#state, ...patch };
        this.#options.onState?.(this.#state);
    }
    /** Write a frame, ignoring failures: a dead socket will be noticed by `close`. */
    #send(frame) {
        try {
            this.#socket?.send(JSON.stringify(frame));
        }
        catch {
            // The close handler owns recovery.
        }
    }
    /** Handle one frame from the relay. */
    #receive(text) {
        const frame = parseRelayFrame(text);
        if (frame === null)
            return;
        switch (frame.t) {
            case 'welcome': {
                // A successful welcome is the only thing that resets the backoff: a TCP
                // connect that is immediately refused would otherwise look like progress.
                this.#attempt = 0;
                this.#setState({ connected: true, room: frame.room, lastError: null });
                this.#options.log(`relay: serving room ${frame.room} (protocol ${frame.protocolVersion}, ` +
                    `this build speaks ${TUNNEL_PROTOCOL_VERSION})`);
                return;
            }
            case 'ping':
                this.#send({ t: 'pong', id: frame.id });
                return;
            case 'req':
                void this.#replayRequest(frame);
                return;
            case 'ws-open':
                this.#openStream(frame.id, frame.path, frame.headers);
                return;
            case 'ws-msg':
                this.#streamMessage(frame);
                return;
            case 'ws-close': {
                const stream = this.#streams.get(frame.id);
                this.#streams.delete(frame.id);
                stream?.close(frame.code ?? 1000, frame.reason ?? 'closed by the phone');
                return;
            }
            default:
                return;
        }
    }
    /**
     * Replay an HTTP request against the local listener.
     *
     * The answer is always sent, including when the local listener refused or is
     * not listening at all. A relay request that never gets an answer would hold a
     * phone connection open until its timeout, and the honest answer -- 502, with
     * the reason -- is available immediately.
     */
    async #replayRequest(frame) {
        const body = frame.body === null ? undefined : Buffer.from(frame.body, 'base64');
        try {
            const response = await fetch(`${this.#localOrigin}${frame.path}`, {
                method: frame.method,
                headers: forwardable(frame.headers),
                ...(body === undefined ? {} : { body }),
                redirect: 'manual',
            });
            const payload = Buffer.from(await response.arrayBuffer());
            const headers = {};
            response.headers.forEach((value, name) => {
                if (!HOP_BY_HOP.has(name.toLowerCase()))
                    headers[name] = value;
            });
            this.#send({
                t: 'res',
                id: frame.id,
                status: response.status,
                headers,
                body: payload.length === 0 ? null : payload.toString('base64'),
            });
        }
        catch (error) {
            this.#send({
                t: 'error',
                id: frame.id,
                message: `the local listener did not answer: ${error instanceof Error ? error.message : String(error)}`,
            });
        }
    }
    /** Bridge a phone WebSocket onto a local one. */
    #openStream(id, path, headers) {
        const wsURL = `${this.#localOrigin.replace(/^http/, 'ws')}${path}`;
        let socket;
        try {
            socket = new WebSocket(wsURL, { headers: forwardable(headers) });
        }
        catch (error) {
            this.#send({
                t: 'error',
                id,
                message: `could not open a local socket: ${error instanceof Error ? error.message : String(error)}`,
            });
            return;
        }
        this.#streams.set(id, socket);
        socket.on('open', () => {
            this.#send({ t: 'ws-open-ok', id });
        });
        socket.on('message', (data, isBinary) => {
            this.#send({
                t: 'ws-msg',
                id,
                data: (Buffer.isBuffer(data) ? data : Buffer.from(String(data))).toString('base64'),
                binary: isBinary,
            });
        });
        socket.on('close', (code, reason) => {
            if (!this.#streams.delete(id))
                return;
            this.#send({ t: 'ws-close', id, code, reason: reason.toString('utf8') });
        });
        socket.on('error', (error) => {
            if (!this.#streams.delete(id))
                return;
            this.#send({ t: 'error', id, message: error.message });
        });
    }
    /** Pass a message from the phone to the local socket. */
    #streamMessage(frame) {
        const stream = this.#streams.get(frame.id);
        if (stream === undefined)
            return;
        try {
            stream.send(Buffer.from(frame.data, 'base64'), { binary: frame.binary });
        }
        catch {
            // The socket's own error handler reports it; nothing to add here.
        }
    }
    /** Close every bridged stream, telling the phone why. */
    #closeStreams(reason) {
        for (const [id, stream] of this.#streams) {
            this.#streams.delete(id);
            try {
                stream.close(1011, reason);
            }
            catch {
                // Already gone.
            }
            // No frame back to the relay: it is the one that went away.
        }
    }
}
