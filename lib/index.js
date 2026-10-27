/**
 * dsh-mizar 0.9.0 — the helper plugin.
 *
 * This is not the 0.8.x plugin with features removed. It is a different thing
 * with the same name: a pipe between the DSH process and the AGI Mizar desktop
 * app, and nothing else. There is no listener, no pairing, no device roster, no
 * relay, no push, no panel. Those all moved to the desktop, which is the only
 * side that talks to a phone now.
 *
 * ### What is left, and why each part has to be here
 *
 * - **The event feed** — `session/event` and `projection/changed` are in-process
 *   subscriptions. Nothing outside the process can hear them.
 * - **The endpoint proxy** — `ctx.typertGateway` is an in-process service.
 * - **The service proxy** — the workspace registry and projection store have no
 *   Typert endpoint at all.
 * - **The waterfall answerers** — `approval/request` and `user-questions/request`
 *   are Cordis waterfalls. A channel that is not in the process cannot be a peer
 *   in one, which is exactly why the desktop cannot do this half itself.
 *
 * ### What a user sees if they install this alone
 *
 * Nothing. That is deliberate and it is logged once at startup: with no desktop
 * running, this plugin must behave as though it were not installed at all.
 *
 * @module dsh-mizar
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Config } from './config.js';
import { InteractionBroker, registerAnswerers } from './bridge/interactions.js';
import { LinkClient } from './link/client.js';
import { Dispatcher } from './link/dispatch.js';
import { EventFeed } from './link/events.js';
import { LINK_VERSION } from './link/frames.js';
import { sharedMountRegistry } from './mount.js';
import { localEndpoints } from './ready.js';
/** Cordis plugin name. Unchanged from 0.8.x so profiles keep loading it. */
export const name = 'mizar';
/**
 * Services this plugin must observe before it activates.
 *
 * `typert` backs the descriptor registry the handshake reports, `typertGateway`
 * carries endpoint calls, `sessionProjections` feeds the change subscription, and
 * `sessions` is what a session event arrives with. Everything else — the
 * workspace registry in particular — is read through `ctx.get` so that a
 * composition without it still activates.
 */
export const inject = ['typert', 'typertGateway', 'sessionProjections', 'sessions'];
/**
 * The version this build reports.
 *
 * Printed at startup because the most expensive confusion in this project's
 * history was not knowing whether a fix was running: a plugin loads when DSH
 * starts, so reinstalling without restarting leaves the old code in place.
 */
const PLUGIN_VERSION = '0.9.0';
/** Operator-facing diagnostics, on plain stdout. */
function report(message) {
    console.log(`[mizar] ${message}`);
}
/** Render an unknown thrown value as one line. */
function describe(error) {
    if (error instanceof Error)
        return `${error.name}: ${error.message}`;
    return String(error);
}
/**
 * Start the link and wire the two feeds to it.
 *
 * @param ctx - the plugin context.
 * @param config - validated plugin configuration.
 * @param signal - aborted when the plugin unloads.
 */
function startLink(ctx, config, signal) {
    const broker = new InteractionBroker();
    let client = null;
    const send = (frame) => client === null ? false : client.send(frame);
    broker.setSender(send);
    const dispatcher = new Dispatcher({
        ctx,
        send,
        broker,
        services: config.services,
        log: report,
    });
    const feed = new EventFeed(send, config.logEvents);
    const unbind = feed.bind(ctx);
    // Registered before the first dial: an approval that arrives while the link is
    // still connecting must find the answerer in place, or it is answered by the
    // GUI alone and the desktop never sees it.
    registerAnswerers(ctx, broker);
    client = new LinkClient({
        endpointFile: config.endpointFile,
        identity: () => {
            let endpoints = [];
            try {
                endpoints = [...localEndpoints(ctx)];
            }
            catch {
                // A registry that is not readable yet is not a reason to refuse the
                // handshake: the desktop can ask again through `invoke`.
            }
            return {
                plugin: { name: 'dsh-mizar', version: PLUGIN_VERSION, linkVersion: LINK_VERSION },
                dsh: {
                    platform: process.platform,
                    home: process.env['DSH_HOME'] ?? join(homedir(), '.dsh'),
                    node: process.version,
                },
                endpoints,
                services: config.services,
            };
        },
        onFrame: (frame) => dispatcher.handle(frame),
        onUp: (welcome) => {
            broker.setConnected(true);
            report(`link up with ${welcome.desktop ?? 'AGI Mizar'} — ` +
                `${localEndpointsSafe(ctx)} endpoints, ${config.services.length} services`);
        },
        onDown: (reason) => {
            broker.setConnected(false);
            report(`link down — ${reason} (pending approvals settled unavailable)`);
        },
        log: report,
        reconnect: config.reconnect,
    });
    client.start();
    let shutdown = null;
    const dispose = () => {
        shutdown ??= (async () => {
            // Stop writing first, then release the work: a stream that is still
            // pumping would otherwise send into a closed socket, and a pending
            // approval would keep an agent waiting for an operator who has left.
            client?.stop();
            dispatcher.dispose();
            broker.dispose();
            unbind();
        })();
        return shutdown;
    };
    signal.addEventListener('abort', () => {
        void dispose();
    });
    return { connected: () => client?.connected ?? false, dispose };
}
/** The endpoint count, without letting a failed read break a log line. */
function localEndpointsSafe(ctx) {
    try {
        return localEndpoints(ctx).size;
    }
    catch {
        return 0;
    }
}
/**
 * The one mount this process runs at a time.
 *
 * DSH may compose or re-apply a bundle more than once. Two mounts would mean two
 * links and two sets of waterfall listeners, which shows up as duplicated
 * approvals and events. The registry serialises them.
 */
const mounts = sharedMountRegistry();
/**
 * Mount the helper plugin.
 * @param ctx - the plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
    report('apply() entered — injects resolved');
    if (!config.enabled) {
        report('disabled by configuration');
        return;
    }
    report(`dsh-mizar ${PLUGIN_VERSION} — helper plugin: no listener, no pairing, no relay. ` +
        `Waiting for AGI Mizar at ${config.endpointFile}`);
    ctx.effect(() => {
        const controller = new AbortController();
        let mounted = null;
        void mounts.start(async () => {
            if (controller.signal.aborted)
                return null;
            try {
                mounted = startLink(ctx, config, controller.signal);
                return mounted;
            }
            catch (error) {
                report(`link failed to start — ${describe(error)}`);
                return null;
            }
        });
        return () => {
            controller.abort();
            void mounts.stop(mounted);
            mounted = null;
        };
    }, 'mizar:link');
}
export { Config };
