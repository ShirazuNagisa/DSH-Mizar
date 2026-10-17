/** Prefix identifying a Mizar device token in logs and support requests. */
export declare const TOKEN_PREFIX = "mz_";
/** Longest accepted device name, in characters. */
export declare const MAX_DEVICE_NAME = 64;
/** Longest accepted Live Activity push token, in characters. */
export declare const MAX_LIVE_ACTIVITY_TOKEN = 200;
/**
 * Whether a value is an APNs Live Activity push token.
 *
 * Lowercase hex, because that is what APNs issues and therefore what the app
 * reports. The length bound is the wire contract's: wide enough for any token
 * APNs has ever issued, narrow enough that a stored file cannot be made to hold
 * an unbounded string.
 *
 * @param value - the candidate, normally straight from a client payload or from state.json.
 * @returns whether it is usable.
 */
export declare function isLiveActivityToken(value: unknown): value is string;
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
    /**
     * Where to send a notification for this device, once its app has asked.
     *
     * Kept on the device rather than in a store of its own, because that is what
     * it is: a property of a paired phone. Revoking a device drops it with the
     * record, and there is no second roster to keep in step with this one.
     *
     * Absent until the app registers, which it does on its own after the operator
     * grants notification permission -- so a host whose phone never asked simply
     * never grows this field.
     */
    readonly push?: DevicePush;
}
/** A device's push endpoint. */
export interface DevicePush {
    /** The device token: hex for APNs, an opaque registration token for FCM. */
    readonly token: string;
    /**
     * Which push service the token belongs to.
     *
     * Stored rather than inferred from the token's shape, because a relay that
     * guessed would send an Android token to Apple on the strength of it looking
     * unusual. Defaulted to `'ios'` when a record predates the field, which is
     * what every stored record does.
     */
    readonly platform: 'ios' | 'android';
    /**
     * Which APNs environment issued it, or `null` on Android.
     *
     * Not inferable and not interchangeable: a token minted for the sandbox is
     * rejected by the production endpoint with `BadDeviceToken`, which says
     * nothing about why. FCM has one service, so an Android registration has no
     * environment to record.
     */
    readonly environment: 'sandbox' | 'production' | null;
    /** The language the app is running in, so notifications match it. */
    readonly locale: string;
    /**
     * The APNs push token of the Live Activity currently on screen.
     *
     * Not the same token as {@link DevicePush.token}, and not interchangeable: a
     * Live Activity is addressed by a per-activity token, so an end push sent to
     * the app's device token would reach the app rather than the activity.
     *
     * Absent means no Live Activity is up. That is why registering without it has
     * to *clear* the stored one rather than leave it alone: a token held past its
     * activity is a credential for ending a countdown that no longer exists.
     */
    readonly liveActivityToken?: string;
    /** When the app last told this host where it is. */
    readonly updatedAt: number;
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
 * A token's record, and whether that record has been revoked.
 *
 * Both are needed because the two are different answers for the client:
 * "this host has never seen you" sends the app back to pairing, while "you were
 * removed on purpose" also makes it clear its stored token is dead.
 */
export interface TokenMatch {
    readonly record: DeviceRecord;
    readonly revoked: boolean;
}
/**
 * Find the record a token belongs to, revoked or not.
 *
 * Every record is compared without an early exit, so a caller cannot time which
 * record matched or how close a wrong token was. A live record wins over a
 * revoked one when a token somehow appears twice, which is the order the roster
 * itself is kept in.
 *
 * @param devices - the known device records.
 * @param token - the token presented by the client.
 * @returns the match, or `null` when no record holds this token.
 */
export declare function matchToken(devices: readonly DeviceRecord[], token: string): TokenMatch | null;
/**
 * Find the live device a token belongs to.
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
