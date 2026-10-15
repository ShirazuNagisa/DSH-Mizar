import { deriveCode } from '../auth/pairing.js';
import { buildPanelStatus } from './status.js';
/**
 * Route paths.
 *
 * These carry the `/api` prefix themselves. The interface doc calls `path` an
 * "absolute path below `/api`", but the shipped registrations pass `/api/file`
 * and friends — the prefix is part of the path, and omitting it produces a
 * silent 404 with no registration error.
 */
export const PANEL_ROUTES = {
    status: '/api/mizar.status',
    pairing: '/api/mizar.pairing',
    revoke: '/api/mizar.revoke',
};
/**
 * Build a JSON response.
 * @param body - the value to serialise.
 * @param status - the HTTP status.
 * @returns the response.
 */
function json(body, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
}
/**
 * Register the panel's routes on the shared API channel.
 *
 * @param ctx - the plugin context.
 * @param options - host wiring.
 */
export function registerPanelApi(ctx, options) {
    const snapshot = () => {
        const state = options.store.state;
        return buildPanelStatus({
            hostId: state.hostId,
            hostName: options.hostName,
            protocolVersion: options.protocolVersion,
            authorities: options.host.authorities,
            plan: options.plan,
            pairing: state.pairing,
            devices: state.devices,
            clients: options.host.clientCount,
            relay: options.relay === null || !options.relay.enabled
                ? null
                : {
                    connected: options.relay.state.connected,
                    room: options.relay.state.room,
                    pairBaseURL: options.relay.pairBaseURL,
                    lastError: options.relay.state.lastError,
                },
            now: Date.now(),
            // The code is derived, never stored, so the panel reads it back the same
            // way the host verified it.
            deriveCode: (slot) => deriveCode(options.store.secret, slot.epoch),
        });
    };
    options.log('panel: waiting for the connection service');
    ctx.inject(['connection'], (scoped) => {
        options.log('panel: connection is available, registering routes');
        const disposers = [];
        disposers.push(scoped.connection.fetch.register({
            path: PANEL_ROUTES.status,
            methods: ['GET'],
            requestBody: 'buffered',
            fetch: async () => json(snapshot()),
        }));
        disposers.push(scoped.connection.fetch.register({
            path: PANEL_ROUTES.pairing,
            methods: ['POST'],
            requestBody: 'buffered',
            // Issuing invalidates any outstanding code, so this doubles as "show me
            // a fresh one" — the panel's only pairing action.
            fetch: async () => {
                await options.host.issuePairingCode();
                return json(snapshot());
            },
        }));
        disposers.push(scoped.connection.fetch.register({
            path: PANEL_ROUTES.revoke,
            methods: ['POST'],
            requestBody: 'buffered',
            fetch: async (request) => {
                const body = (await request.json().catch(() => null));
                const deviceId = body?.deviceId;
                if (typeof deviceId !== 'string' || deviceId === '') {
                    return json({ error: 'deviceId must be a non-empty string' }, 400);
                }
                const revoked = await options.host.revokeDevice(deviceId);
                if (!revoked)
                    return json({ error: 'unknown device' }, 404);
                return json(snapshot());
            },
        }));
        options.log(`panel: registered ${disposers.length} routes (${Object.values(PANEL_ROUTES).join(', ')})`);
        return async () => {
            // Unregister in reverse, so a partially-registered panel leaves nothing
            // behind if one disposer throws.
            for (const dispose of disposers.reverse()) {
                await dispose().catch(() => { });
            }
        };
    });
}
