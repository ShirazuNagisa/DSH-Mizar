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
            // A loopback authority is left out of the QR rather than offered: a phone
            // cannot reach 127.0.0.1 on the Mac, and putting it in would make every
            // scan spend its direct-connection timeout before falling back to the
            // relay that actually works.
            const direct = input.authorities.find((authority) => !isLoopbackAuthority(authority)) ?? '';
            const uri = buildPairingUri(direct, display, input.hostName, input.protocolVersion, input.relay?.pairBaseURL ?? null);
            // `null` means there is no address at all -- neither direct nor relayed.
            // Rendering a QR that cannot work is worse than rendering none.
            if (uri !== null) {
                pairing = { display, expiresAt: live.expiresAt, uri };
            }
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
        relay: input.relay === null
            ? null
            : {
                enabled: true,
                connected: input.relay.connected,
                room: input.relay.room,
                pairBaseURL: input.relay.pairBaseURL,
                lastError: input.relay.lastError,
            },
    };
}
/**
 * Whether an authority points at this machine's own loopback.
 *
 * @param authority - `host:port`.
 * @returns whether a phone could not possibly reach it.
 */
function isLoopbackAuthority(authority) {
    const host = authority.startsWith('[')
        ? authority.slice(1, authority.indexOf(']'))
        : authority.split(':')[0] ?? '';
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}
