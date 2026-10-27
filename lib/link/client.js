/**
 * The outbound half of DSH Link v1.
 *
 * One WebSocket to `127.0.0.1:<port>/dsh`, dialled by this plugin. Everything
 * here is about staying connected without being noticed: an exponential backoff
 * with jitter, a welcome handshake with a deadline, and a ping/pong watchdog so
 * a half-open socket (a desktop that crashed, a laptop that slept) is replaced
 * rather than believed.
 *
 * ### Why the plugin dials
 *
 * A listener would need a port, a bind policy, a firewall story and a token
 * store — all of which the 0.8.x plugin had and none of which a helper should
 * have. Dialling out inverts every one of those: no port to collide with, no
 * inbound surface, and "the desktop is gone" is just a closed socket.
 *
 * ### What a disconnect means
 *
 * `onDown` is not an error report. It is the signal the broker uses to settle
 * pending approvals `unavailable` — the fail-closed rule that keeps a vanished
 * operator from hanging an agent.
 *
 * @module dsh-mizar/link/client
 */
import { WebSocket } from 'ws';
import { readEndpoint } from './endpoint.js';
import { helloFrame, parseDesktopFrame, LINK_PATH, } from './frames.js';
/** How long the desktop has to answer `hello` before the socket is replaced. */
const WELCOME_TIMEOUT_MS = 5_000;
/** How often a missing endpoint file is reported, at most. */
const MISSING_REPORT_MS = 60_000;
export class LinkClient {
    #options;
    #socket = null;
    #ready = false;
    #stopped = true;
    #attempt = 0;
    #retry = null;
    #heartbeat = null;
    #welcomeDeadline = null;
    /** Set by every pong and every inbound frame; cleared by every ping. */
    #alive = false;
    #missingReportedAt = 0;
    #lastDownReason = null;
    constructor(options) {
        this.#options = options;
    }
    /** Whether the handshake has completed on a live socket. */
    get connected() {
        return this.#ready;
    }
    /** Begin dialling. Idempotent: a second call while running is a no-op. */
    start() {
        if (!this.#stopped)
            return;
        this.#stopped = false;
        void this.#connect();
    }
    /**
     * Stop dialling and drop the socket.
     *
     * Synchronous on purpose: it is called from an effect cleanup, and the caller
     * must not be left with a socket that outlives the plugin.
     */
    stop() {
        this.#stopped = true;
        this.#clearRetry();
        this.#teardown('stopped');
    }
    /**
     * Send one frame, if the link is up.
     *
     * @param frame - what to send.
     * @returns whether it was written. `false` is not an error: a notification
     *   that cannot be delivered is dropped, and the state it described is still
     *   readable through `invoke`.
     */
    send(frame) {
        const socket = this.#socket;
        if (socket === null || !this.#ready || socket.readyState !== WebSocket.OPEN)
            return false;
        try {
            socket.send(JSON.stringify(frame));
            return true;
        }
        catch {
            return false;
        }
    }
    /** One dial attempt: read the endpoint, connect, handshake. */
    async #connect() {
        if (this.#stopped)
            return;
        const endpoint = await readEndpoint(this.#options.endpointFile);
        if (endpoint === null) {
            const now = Date.now();
            if (now - this.#missingReportedAt > MISSING_REPORT_MS) {
                this.#missingReportedAt = now;
                this.#options.log(`no desktop endpoint at ${this.#options.endpointFile} — waiting for AGI Mizar`);
            }
            this.#scheduleRetry();
            return;
        }
        if (this.#stopped)
            return;
        const socket = new WebSocket(`ws://127.0.0.1:${endpoint.port}${LINK_PATH}`, {
            handshakeTimeout: 5_000,
            perMessageDeflate: false,
        });
        this.#socket = socket;
        socket.on('open', () => {
            const identity = this.#options.identity();
            socket.send(JSON.stringify(helloFrame({
                token: endpoint.token,
                plugin: identity.plugin,
                dsh: identity.dsh,
                endpoints: identity.endpoints,
                services: identity.services,
            })));
            this.#welcomeDeadline = setTimeout(() => {
                // A socket that never answered `hello` is not a desktop this build can
                // talk to. Replacing it re-reads the endpoint, which is what picks up a
                // desktop that restarted on a new port.
                this.#teardown('the desktop did not answer the handshake');
            }, WELCOME_TIMEOUT_MS);
            this.#welcomeDeadline.unref?.();
        });
        socket.on('message', (data) => {
            this.#alive = true;
            const text = typeof data === 'string' ? data : data.toString();
            const frame = parseDesktopFrame(text);
            if (frame === null)
                return;
            if (frame.type === 'welcome') {
                this.#clearWelcomeDeadline();
                if (frame.linkVersion !== 1) {
                    this.#options.log(`desktop speaks link v${frame.linkVersion}; this plugin speaks v1 — refusing`);
                    this.#teardown('link version mismatch');
                    return;
                }
                this.#ready = true;
                this.#attempt = 0;
                this.#lastDownReason = null;
                this.#startHeartbeat();
                this.#options.onUp(frame);
                return;
            }
            // Frames before the handshake are a protocol violation, not data.
            if (!this.#ready)
                return;
            this.#options.onFrame(frame);
        });
        socket.on('pong', () => {
            this.#alive = true;
        });
        socket.on('error', (error) => {
            this.#teardown(`socket error: ${error.message}`);
        });
        socket.on('close', (code) => {
            this.#teardown(`socket closed (${code})`);
        });
    }
    /** Ping on a cadence; two silent intervals mean the peer is gone. */
    #startHeartbeat() {
        this.#stopHeartbeat();
        this.#alive = true;
        this.#heartbeat = setInterval(() => {
            const socket = this.#socket;
            if (socket === null || socket.readyState !== WebSocket.OPEN)
                return;
            if (!this.#alive) {
                // No pong and no traffic since the last ping. Terminating (rather than
                // closing) is deliberate: a half-open socket would otherwise hold the
                // "connected" state for as long as the OS keeps the fd.
                this.#teardown('the desktop stopped answering pings');
                socket.terminate();
                return;
            }
            this.#alive = false;
            try {
                socket.ping();
            }
            catch {
                this.#teardown('could not ping the desktop');
            }
        }, Math.max(1_000, this.#options.reconnect.heartbeatMs));
        this.#heartbeat.unref?.();
    }
    #stopHeartbeat() {
        if (this.#heartbeat !== null) {
            clearInterval(this.#heartbeat);
            this.#heartbeat = null;
        }
    }
    #clearWelcomeDeadline() {
        if (this.#welcomeDeadline !== null) {
            clearTimeout(this.#welcomeDeadline);
            this.#welcomeDeadline = null;
        }
    }
    #clearRetry() {
        if (this.#retry !== null) {
            clearTimeout(this.#retry);
            this.#retry = null;
        }
    }
    /**
     * Drop the current socket and report it once.
     *
     * Idempotent: a close event usually follows a teardown caused by the same
     * failure, and a second `onDown` would settle approvals that a newer
     * connection has already re-registered.
     *
     * @param reason - why the link ended.
     */
    #teardown(reason) {
        const wasReady = this.#ready;
        this.#ready = false;
        this.#clearWelcomeDeadline();
        this.#stopHeartbeat();
        const socket = this.#socket;
        this.#socket = null;
        if (socket !== null) {
            socket.removeAllListeners();
            try {
                socket.terminate();
            }
            catch {
                // Already gone.
            }
        }
        if (wasReady && reason !== 'stopped' && this.#lastDownReason !== reason) {
            this.#lastDownReason = reason;
            this.#options.onDown(reason);
        }
        if (!this.#stopped)
            this.#scheduleRetry();
    }
    /** Queue the next dial with exponential backoff and jitter. */
    #scheduleRetry() {
        if (this.#stopped || this.#retry !== null)
            return;
        const { baseMs, maxMs } = this.#options.reconnect;
        const ceiling = Math.min(maxMs, baseMs * 2 ** Math.min(this.#attempt, 16));
        // ±20% so a fleet of plugins starting with DSH does not synchronise.
        const delay = Math.max(250, Math.round(ceiling * (0.8 + Math.random() * 0.4)));
        this.#attempt += 1;
        this.#retry = setTimeout(() => {
            this.#retry = null;
            void this.#connect();
        }, delay);
        this.#retry.unref?.();
    }
}
