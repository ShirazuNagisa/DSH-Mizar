/**
 * Device credentials.
 *
 * A device token is the long-lived credential the phone stores in the Keychain.
 * It is opaque, 256-bit random, and never persisted on the host — only its
 * SHA-256 hash is, so a leaked `devices.json` cannot be replayed against the
 * listener. Verification walks every record without an early exit so the time it
 * takes does not reveal which record matched.
 *
 * @module dsh-mizar/auth/devices
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { base32 } from './pairing.js';
/** Prefix identifying a Mizar device token in logs and support requests. */
export const TOKEN_PREFIX = 'mz_';
/** Random bytes behind one token. 32 bytes is 256 bits. */
const TOKEN_BYTES = 32;
/** Longest accepted device name, in characters. */
export const MAX_DEVICE_NAME = 64;
/**
 * Hash a token for storage or comparison.
 * @param token - the token.
 * @returns the hex-encoded SHA-256 digest.
 */
export function hashToken(token) {
    return createHash('sha256').update(token, 'utf8').digest('hex');
}
/**
 * Mint a new device token.
 * @returns the token plus the material to persist.
 */
export function issueToken() {
    const token = `${TOKEN_PREFIX}${base32(new Uint8Array(randomBytes(TOKEN_BYTES)))}`;
    const tokenHash = hashToken(token);
    return { token, tokenHash, tokenPrefix: tokenHash.slice(0, 8) };
}
/**
 * Build a device record for a pairing request.
 * @param issued - the minted token material.
 * @param details - what the phone reported about itself.
 * @param now - current epoch milliseconds.
 * @returns the record to persist.
 */
export function createDeviceRecord(issued, details, now = Date.now()) {
    const rawName = details.name?.trim() ?? '';
    const model = details.model?.trim();
    const name = rawName !== '' ? rawName : (model ?? '').trim() !== '' ? model : 'Unnamed device';
    return {
        deviceId: randomUUID(),
        name: name.slice(0, MAX_DEVICE_NAME),
        ...(model !== undefined && model !== '' ? { model: model.slice(0, MAX_DEVICE_NAME) } : {}),
        ...(details.appVersion !== undefined && details.appVersion !== ''
            ? { appVersion: details.appVersion.slice(0, 32) }
            : {}),
        tokenHash: issued.tokenHash,
        tokenPrefix: issued.tokenPrefix,
        createdAt: now,
        lastSeenAt: now,
    };
}
/**
 * Find the live device a token belongs to.
 *
 * Every record is compared, and the result is merged rather than returned early,
 * so a caller cannot time which record matched or how close a wrong token was.
 *
 * @param devices - the known device records.
 * @param token - the token presented by the client.
 * @returns the matching live record, or `null`.
 */
export function verifyToken(devices, token) {
    const presented = Buffer.from(hashToken(token), 'utf8');
    let match = null;
    for (const device of devices) {
        const stored = Buffer.from(device.tokenHash, 'utf8');
        const equal = stored.length === presented.length && timingSafeEqual(stored, presented);
        if (equal && device.revokedAt === undefined && match === null)
            match = device;
    }
    return match;
}
/**
 * Mark a device revoked, preserving its record for the roster.
 * @param devices - the known records.
 * @param deviceId - the device to revoke.
 * @param now - current epoch milliseconds.
 * @returns the updated records, or the input when the id is unknown.
 */
export function revokeDevice(devices, deviceId, now = Date.now()) {
    let changed = false;
    const next = devices.map((device) => {
        if (device.deviceId !== deviceId || device.revokedAt !== undefined)
            return device;
        changed = true;
        return { ...device, revokedAt: now };
    });
    return changed ? next : devices;
}
/**
 * Record a successful authentication against a device.
 * @param devices - the known records.
 * @param deviceId - the authenticated device.
 * @param now - current epoch milliseconds.
 * @returns the updated records.
 */
export function touchDevice(devices, deviceId, now = Date.now()) {
    return devices.map((device) => device.deviceId === deviceId ? { ...device, lastSeenAt: now } : device);
}
/**
 * Split the roster into live and revoked devices, newest first.
 * @param devices - the known records.
 * @returns the two lists, each ordered by creation time descending.
 */
export function partitionDevices(devices) {
    const byNewest = [...devices].sort((a, b) => b.createdAt - a.createdAt);
    return {
        live: byNewest.filter((device) => device.revokedAt === undefined),
        revoked: byNewest.filter((device) => device.revokedAt !== undefined),
    };
}
