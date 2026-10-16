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
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { base32 } from './pairing.js'

/** Prefix identifying a Mizar device token in logs and support requests. */
export const TOKEN_PREFIX = 'mz_'

/** Random bytes behind one token. 32 bytes is 256 bits. */
const TOKEN_BYTES = 32

/** Longest accepted device name, in characters. */
export const MAX_DEVICE_NAME = 64

/** One paired device. */
export interface DeviceRecord {
  /** Stable identity, generated at pairing time. */
  readonly deviceId: string
  /** Operator-visible name, defaulted from the device model. */
  readonly name: string
  /** Device model reported by the app, when it sent one. */
  readonly model?: string
  /** App version reported at pairing time. */
  readonly appVersion?: string
  /** SHA-256 of the token, hex encoded. */
  readonly tokenHash: string
  /** Short, non-secret display id derived from the token. */
  readonly tokenPrefix: string
  /** When the device paired, in epoch milliseconds. */
  readonly createdAt: number
  /** Last successful authentication, in epoch milliseconds. */
  readonly lastSeenAt: number
  /** When the device was revoked; absent while it is valid. */
  readonly revokedAt?: number
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
  readonly push?: DevicePush
}

/** A device's APNs endpoint. */
export interface DevicePush {
  /** The APNs device token, hex. */
  readonly token: string
  /**
   * Which APNs environment issued it.
   *
   * Not inferable and not interchangeable: a token minted for the sandbox is
   * rejected by the production endpoint with `BadDeviceToken`, which says
   * nothing about why.
   */
  readonly environment: 'sandbox' | 'production'
  /** The language the app is running in, so notifications match it. */
  readonly locale: string
  /** When the app last told this host where it is. */
  readonly updatedAt: number
}

/** A freshly minted token and the record material derived from it. */
export interface IssuedToken {
  /** The secret handed to the phone exactly once. */
  readonly token: string
  /** The record fields to persist. */
  readonly tokenHash: string
  /** The short display id. */
  readonly tokenPrefix: string
}

/**
 * Hash a token for storage or comparison.
 * @param token - the token.
 * @returns the hex-encoded SHA-256 digest.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/**
 * Mint a new device token.
 * @returns the token plus the material to persist.
 */
export function issueToken(): IssuedToken {
  const token = `${TOKEN_PREFIX}${base32(new Uint8Array(randomBytes(TOKEN_BYTES)))}`
  const tokenHash = hashToken(token)
  return { token, tokenHash, tokenPrefix: tokenHash.slice(0, 8) }
}

/**
 * Build a device record for a pairing request.
 * @param issued - the minted token material.
 * @param details - what the phone reported about itself.
 * @param now - current epoch milliseconds.
 * @returns the record to persist.
 */
export function createDeviceRecord(
  issued: IssuedToken,
  details: { name?: string; model?: string; appVersion?: string },
  now: number = Date.now(),
): DeviceRecord {
  const rawName = details.name?.trim() ?? ''
  const model = details.model?.trim()
  const name = rawName !== '' ? rawName : (model ?? '').trim() !== '' ? (model as string) : 'Unnamed device'
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
  }
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
export function verifyToken(
  devices: readonly DeviceRecord[],
  token: string,
): DeviceRecord | null {
  const presented = Buffer.from(hashToken(token), 'utf8')
  let match: DeviceRecord | null = null

  for (const device of devices) {
    const stored = Buffer.from(device.tokenHash, 'utf8')
    const equal = stored.length === presented.length && timingSafeEqual(stored, presented)
    if (equal && device.revokedAt === undefined && match === null) match = device
  }

  return match
}

/**
 * Mark a device revoked, preserving its record for the roster.
 * @param devices - the known records.
 * @param deviceId - the device to revoke.
 * @param now - current epoch milliseconds.
 * @returns the updated records, or the input when the id is unknown.
 */
export function revokeDevice(
  devices: readonly DeviceRecord[],
  deviceId: string,
  now: number = Date.now(),
): readonly DeviceRecord[] {
  let changed = false
  const next = devices.map((device) => {
    if (device.deviceId !== deviceId || device.revokedAt !== undefined) return device
    changed = true
    return { ...device, revokedAt: now }
  })
  return changed ? next : devices
}

/**
 * Record a successful authentication against a device.
 * @param devices - the known records.
 * @param deviceId - the authenticated device.
 * @param now - current epoch milliseconds.
 * @returns the updated records.
 */
export function touchDevice(
  devices: readonly DeviceRecord[],
  deviceId: string,
  now: number = Date.now(),
): readonly DeviceRecord[] {
  return devices.map((device) =>
    device.deviceId === deviceId ? { ...device, lastSeenAt: now } : device,
  )
}

/**
 * Split the roster into live and revoked devices, newest first.
 * @param devices - the known records.
 * @returns the two lists, each ordered by creation time descending.
 */
export function partitionDevices(devices: readonly DeviceRecord[]): {
  live: readonly DeviceRecord[]
  revoked: readonly DeviceRecord[]
} {
  const byNewest = [...devices].sort((a, b) => b.createdAt - a.createdAt)
  return {
    live: byNewest.filter((device) => device.revokedAt === undefined),
    revoked: byNewest.filter((device) => device.revokedAt !== undefined),
  }
}
