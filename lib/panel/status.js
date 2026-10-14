import { displayCode } from '../auth/pairing.js';
import { buildPairingUri } from '../protocol/pairing-uri.js';
/**
 * Narrow one device record.
 * @param device - the stored record.
 * @returns the panel row.
 */
function toDeviceView(device) {
    return {
        deviceId: device.deviceId,
        name: device.name,
        model: device.model ?? null,
        tokenPrefix: device.tokenPrefix,
        createdAt: device.createdAt,
        lastSeenAt: device.lastSeenAt,
        revoked: device.revokedAt !== undefined,
    };
}
/**
 * Order devices for display: live first, newest first within each group.
 *
 * An operator opening this panel wants to know who currently has access, not the
 * full history.
 *
 * @param devices - the stored records.
 * @returns the ordered rows.
 */
function orderDevices(devices) {
    return devices.map(toDeviceView).sort((a, b) => {
        if (a.revoked !== b.revoked)
            return a.revoked ? 1 : -1;
        return b.createdAt - a.createdAt;
    });
}
/**
 * Build the panel's status view.
 *
 * A pairing slot is only reported while it is live. The slot persists with
 * `expiresAt: 0` once a code is redeemed, and showing a spent code would invite
 * an operator to read out something that can never work.
 *
 * @param input - host facts, stored state, and the code derivation.
 * @returns the status the panel renders.
 */
export function buildPanelStatus(input) {
    const live = input.pairing !== null && input.pairing.expiresAt > input.now ? input.pairing : null;
    let pairing = null;
    if (live !== null) {
        const code = input.deriveCode(live);
        // An empty derivation means the caller could not recover the code; reporting
        // no code is honest, reporting a blank one is not.
        if (code !== '') {
            const display = displayCode(code);
            pairing = {
                display,
                expiresAt: live.expiresAt,
                uri: buildPairingUri(input.authorities[0] ?? '', display, input.hostName, input.protocolVersion),
            };
        }
    }
    return {
        hostId: input.hostId,
        hostName: input.hostName,
        protocolVersion: input.protocolVersion,
        listening: input.authorities.length > 0,
        authorities: input.authorities,
        bind: {
            mode: input.plan.mode,
            fellBack: input.plan.fellBack,
            reason: input.plan.reason,
        },
        pairing,
        devices: orderDevices(input.devices),
        clients: input.clients,
    };
}
