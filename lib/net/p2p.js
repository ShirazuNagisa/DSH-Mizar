/**
 * The direct path, from the desktop's side.
 *
 * Until now the plugin served one way: relay → tunnel → loopback listener. That
 * works from anywhere and costs a detour — every byte goes phone → relay →
 * this machine, with the relay metering it and a round trip neither end can
 * remove.
 *
 * This module makes the plugin a *destination* as well: it holds a UDP socket,
 * publishes where it can be reached, and accepts punched connections. A phone
 * that gets through talks to the same listener it always did — the frames are
 * identical, because a punch changes the transport, not the protocol.
 *
 * Three pieces, and they only make sense together:
 *
 *  - **identity**, derived from the tunnel secret the pairing already trusts,
 *    so the endpoint id needs no new secret and survives a reinstall;
 *  - **the engine**, started once and accepting for the life of the process —
 *    the desktop is the side being dialled, so it cannot create one per call;
 *  - **signaling**, a WebSocket the phone reaches through the relay's room
 *    bridge, which is how the two ends learn each other's addresses.
 *
 * Nothing here decides whether to use the direct path: a phone that dials and
 * fails falls back to the relay exactly as before. Two components that both
 * route will eventually disagree.
 *
 * @module dsh-mizar/net/p2p
 */
import { createHash } from 'node:crypto';
import { candidate, CandidateKind } from '../transport/p2p/candidate.js';
import { deriveIdentity } from '../transport/p2p/crypto.js';
import { Engine } from '../transport/p2p/engine.js';
import { STANDARD_POLICY } from '../transport/p2p/policy.js';
/** The path a phone dials for signaling, behind the relay's room prefix. */
export const SIGNAL_PATH = '/mizar-net/signal';
/**
 * This install's endpoint identity.
 *
 * The secret is the tunnel secret: the same bytes that already decide which
 * room this computer serves. Deriving rather than generating means the endpoint
 * id is stable across reinstalls, and a phone that paired once can dial again
 * without another scan.
 *
 * @param tunnelSecret - the install's tunnel secret, base64url text.
 * @returns the identity.
 */
export function deriveEndpointIdentity(tunnelSecret) {
    const bytes = Buffer.from(tunnelSecret, 'base64url');
    return deriveIdentity(bytes, 'host');
}
/**
 * Turn whatever arrived over signaling into candidates, dropping what does not
 * parse.
 *
 * A signal channel is reachable by anyone holding the room, so its contents are
 * untrusted: a malformed candidate must cost that candidate, not the connection
 * or the process.
 *
 * @param value - the decoded `candidates` field.
 * @returns the usable candidates.
 */
export function readCandidates(value) {
    if (!Array.isArray(value))
        return [];
    const out = [];
    for (const entry of value.slice(0, 32)) {
        if (typeof entry !== 'object' || entry === null)
            continue;
        const wire = entry;
        if (typeof wire.address !== 'string' || wire.address === '')
            continue;
        if (!Number.isInteger(wire.port) || wire.port <= 0 || wire.port > 65535)
            continue;
        const kind = wire.kind === 'serverReflexive' || wire.kind === 'relay' ? wire.kind : 'host';
        out.push(candidate(kind, wire.address, wire.port));
    }
    return out;
}
/**
 * The desktop's direct-path service: one engine, one accept loop, one signaling
 * channel per phone.
 */
export class P2PService {
    /** This install's endpoint id — what a phone dials and `host.info` advertises. */
    endpointId;
    engine;
    log;
    accepts = 0;
    running = true;
    streamListeners = [];
    signals = new Set();
    /**
     * A service around an engine.
     *
     * Prefer ``P2PService.start``: it derives the identity and starts the accept
     * loop. This constructor exists so a test can supply its own engine, which is
     * the only way to exercise the signaling vocabulary without a socket.
     *
     * @param engine - the engine to serve with.
     * @param log - where to report what happened.
     */
    constructor(engine, log) {
        this.engine = engine;
        this.endpointId = engine.identity.endpointId;
        this.log = log;
    }
    /**
     * Start the engine and the accept loop.
     * @param options - identity source, network hints, policy.
     * @returns the running service.
     */
    static async start(options) {
        const identity = deriveEndpointIdentity(options.tunnelSecret);
        const engine = await Engine.create({
            identity,
            policy: options.policy ?? STANDARD_POLICY,
            // No default here on purpose: this is the seam a test uses to stay
            // offline, and the production caller passes what `resolveStunServers`
            // worked out from its config. An empty list is a supported answer -- host
            // candidates only, which is the LAN case, with the relay carrying every
            // remote session the way it always did.
            stunServers: options.stunServers ?? [],
            ...(options.portMapping === undefined ? {} : { portMapping: options.portMapping }),
        });
        const service = new P2PService(engine, options.log ?? (() => undefined));
        void service.acceptLoop();
        return service;
    }
    /** Where this endpoint can be reached right now. */
    candidates() {
        return this.engine.localCandidates();
    }
    /**
     * Register the consumer of accepted connections.
     *
     * One listener, not a queue: the plugin has exactly one frame-serving path,
     * and a second consumer would split connections by timing.
     *
     * @param listener - called with a channel and the remote's description.
     */
    onStream(listener) {
        this.streamListeners.push(listener);
    }
    /**
     * Attach a signaling channel — one per phone.
     *
     * Both sides say hello on connect: the phone because it is about to dial, the
     * desktop because the dialer needs somewhere to aim. Candidates learned from
     * the phone go straight into the engine, whose acceptor punch is what opens
     * this side's filter.
     *
     * @param channel - the phone's signal channel.
     */
    attachSignal(channel) {
        this.signals.add(channel);
        channel.onMessage((text) => this.handleSignal(channel, text));
        channel.onClose(() => {
            this.signals.delete(channel);
        });
        // The desktop's own announcement. Sent first, because the phone may already
        // be dialling and a hello costs one frame.
        channel.send(JSON.stringify({ v: 1, type: 'hello', endpointId: this.endpointId, candidates: this.candidates() }));
    }
    /** Stop accepting, drop every stream, and close the engine. */
    async close() {
        this.running = false;
        for (const channel of this.signals)
            channel.close();
        this.signals.clear();
        await this.engine.close();
    }
    handleSignal(channel, text) {
        let value;
        try {
            value = JSON.parse(text);
        }
        catch {
            return;
        }
        if (typeof value !== 'object' || value === null)
            return;
        const message = value;
        // Version mismatches are dropped rather than argued with: the same
        // tolerance the Mizar protocol has for frames it does not know.
        if (message.v !== 1)
            return;
        if (message.type !== 'hello' && message.type !== 'candidates')
            return;
        const candidates = readCandidates(message.candidates);
        if (candidates.length === 0)
            return;
        this.engine.offerCandidates(candidates);
        // Answer with ours, so a phone that dialled first learns where to punch
        // after its own candidates arrived.
        channel.send(JSON.stringify({ v: 1, type: 'candidates', candidates: this.candidates() }));
    }
    async acceptLoop() {
        while (this.running) {
            let stream;
            try {
                stream = await this.engine.accept();
            }
            catch {
                // `accept` rejects only when the engine is closing.
                return;
            }
            this.accepts += 1;
            const label = `p2p/${this.accepts}`;
            this.log(`accepted a direct connection (${label})`);
            const channel = new StreamChannel(stream);
            for (const listener of this.streamListeners)
                listener(channel, label);
        }
    }
}
/**
 * A p2p stream, wearing the shape the listener serves.
 *
 * The listener speaks WebSocket frames; a punched connection carries bytes. The
 * translation is one message per frame, which is what the phone's own transport
 * does in the other direction (`P2PWebSocketTransport`).
 */
export class StreamChannel {
    stream;
    messageListeners = [];
    closeListeners = [];
    pumping = false;
    finished = false;
    constructor(stream) {
        this.stream = stream;
    }
    get open() {
        return !this.finished;
    }
    onMessage(listener) {
        this.messageListeners.push(listener);
        void this.pump();
    }
    onClose(listener) {
        this.closeListeners.push(listener);
    }
    send(text) {
        if (this.finished)
            return;
        void this.stream.send(Buffer.from(text, 'utf8')).catch(() => this.finish());
    }
    close(_code, reason) {
        if (this.finished)
            return;
        void this.stream.close(reason).catch(() => undefined);
        this.finish();
    }
    async pump() {
        // One reader per channel: two would split frames by timing.
        if (this.pumping)
            return;
        this.pumping = true;
        while (!this.finished) {
            const message = await this.stream.receive().catch(() => null);
            if (message === null) {
                this.finish();
                return;
            }
            for (const listener of this.messageListeners) {
                try {
                    listener(message, false);
                }
                catch {
                    // A handler that throws is a bug in the handler; the channel stays up
                    // so the next frame still gets its chance.
                }
            }
        }
    }
    finish() {
        if (this.finished)
            return;
        this.finished = true;
        for (const listener of this.closeListeners)
            listener();
    }
}
/**
 * A WebSocket, wearing the shape a signaling channel needs.
 *
 * The listener owns the upgrade; this only translates. Text in, text out — the
 * signal vocabulary is JSON and nothing here parses it.
 *
 * @param socket - the accepted socket.
 * @returns the channel.
 */
export function adaptSignalSocket(socket) {
    return {
        send: (text) => {
            if (socket.readyState === socket.OPEN)
                socket.send(text);
        },
        onMessage: (listener) => socket.on('message', (data) => listener(Buffer.isBuffer(data) ? data.toString('utf8') : String(data))),
        onClose: (listener) => {
            socket.on('close', listener);
            socket.on('error', listener);
        },
        close: () => socket.close(),
    };
}
/**
 * A digest of a tunnel secret, for logs.
 *
 * Prints eight characters of a SHA-256 — enough to tell two installs apart in a
 * support conversation, useless for impersonating one.
 *
 * @param tunnelSecret - the raw secret.
 * @returns the short form.
 */
export function shortSecret(tunnelSecret) {
    return createHash('sha256').update(tunnelSecret).digest('hex').slice(0, 8);
}
