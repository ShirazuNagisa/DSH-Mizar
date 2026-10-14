/** Prefix identifying a Mizar device token in logs and support requests. */
export declare const TOKEN_PREFIX = "mz_";
/** Longest accepted device name, in characters. */
export declare const MAX_DEVICE_NAME = 64;
/** One paired device. */
export interface DeviceRecord {
    /** Stable identity, generated at pairing time. */
    readonly deviceId: string;
    /** Operator-visible name, defaulted from the device model. */
    readonly name: string;
    /** Device model reported by the app, when it sent one. */
    readonly model?: string;
    /** App version reported at pairing time. */
    readonly appVersion?: string;
    /** SHA-256 of the token, hex encoded. */
    readonly tokenHash: string;
    /** Short, non-secret display id derived from the token. */
    readonly tokenPrefix: string;
    /** When the device paired, in epoch milliseconds. */
    readonly createdAt: number;
    /** Last successful authentication, in epoch milliseconds. */
    readonly lastSeenAt: number;
    /** When the device was revoked; absent while it is valid. */
    readonly revokedAt?: number;
}
/** A freshly minted token and the record material derived from it. */
export interface IssuedToken {
    /** The secret handed to the phone exactly once. */
    readonly token: string;
    /** The record fields to persist. */
    readonly tokenHash: string;
    /** The short display id. */
    readonly tokenPrefix: string;
}
/**
 * Hash a token for storage or comparison.
 * @param token - the token.
 * @returns the hex-encoded SHA-256 digest.
 */
export declare function hashToken(token: string): string;
/**
 * Mint a new device token.
 * @returns the token plus the material to persist.
 */
export declare function issueToken(): IssuedToken;
/**
 * Build a device record for a pairing request.
 * @param issued - the minted token material.
 * @param details - what the phone reported about itself.
 * @param now - current epoch milliseconds.
 * @returns the record to persist.
 */
export declare function createDeviceRecord(issued: IssuedToken, details: {
    name?: string;
    model?: string;
    appVersion?: string;
}, now?: number): DeviceRecord;
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
export declare function verifyToken(devices: readonly DeviceRecord[], token: string): DeviceRecord | null;
/**
 * Mark a device revoked, preserving its record for the roster.
 * @param devices - the known records.
 * @param deviceId - the device to revoke.
 * @param now - current epoch milliseconds.
 * @returns the updated records, or the input when the id is unknown.
 */
export declare function revokeDevice(devices: readonly DeviceRecord[], deviceId: string, now?: number): readonly DeviceRecord[];
/**
 * Record a successful authentication against a device.
 * @param devices - the known records.
 * @param deviceId - the authenticated device.
 * @param now - current epoch milliseconds.
 * @returns the updated records.
 */
export declare function touchDevice(devices: readonly DeviceRecord[], deviceId: string, now?: number): readonly DeviceRecord[];
/**
 * Split the roster into live and revoked devices, newest first.
 * @param devices - the known records.
 * @returns the two lists, each ordered by creation time descending.
 */
export declare function partitionDevices(devices: readonly DeviceRecord[]): {
    live: readonly DeviceRecord[];
    revoked: readonly DeviceRecord[];
};
