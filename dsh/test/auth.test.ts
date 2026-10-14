/**
 * Tests for the pairing and device credential layer.
 *
 * These are the security-critical pure functions backing the only
 * unauthenticated endpoint and the long-lived device credential, so the cases
 * below target the failure modes that would actually matter: replayed codes,
 * codes outliving their deadline, revoked tokens still working, and compare
 * paths that short-circuit.
 *
 * @module dsh-mizar/test/auth
 */
import { describe, expect, it } from 'vitest'
import {
  base32,
  deriveCode,
  displayCode,
  generateHostSecret,
  issueCode,
  normalizeCode,
  RateLimiter,
  redeemCode,
  CODE_LENGTH,
  DEFAULT_CODE_TTL_SECONDS,
} from '../src/auth/pairing.js'
import {
  createDeviceRecord,
  hashToken,
  issueToken,
  MAX_DEVICE_NAME,
  partitionDevices,
  revokeDevice,
  touchDevice,
  verifyToken,
  TOKEN_PREFIX,
} from '../src/auth/devices.js'

const SECRET = new Uint8Array(32).fill(7)
const T0 = 1_700_000_000_000

describe('base32', () => {
  it('uses only Crockford characters', () => {
    const encoded = base32(new Uint8Array([0, 1, 2, 250, 251, 255, 128, 64]))
    expect(encoded).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/)
    // I, L, O and U are excluded so a code survives being read aloud.
    expect(encoded).not.toMatch(/[ILOU]/)
  })

  it('is deterministic', () => {
    const bytes = new Uint8Array([9, 8, 7])
    expect(base32(bytes)).toBe(base32(bytes))
  })
})

describe('normalizeCode', () => {
  it('uppercases and strips separators', () => {
    expect(normalizeCode('ab2c-d3ef')).toBe('AB2CD3EF')
    expect(normalizeCode(' AB2C D3EF ')).toBe('AB2CD3EF')
  })

  it('folds the characters Crockford treats as equivalent', () => {
    expect(normalizeCode('IL0O')).toBe('1100')
  })
})

describe('pairing codes', () => {
  it('derives a fixed-length code per epoch', () => {
    expect(deriveCode(SECRET, 1)).toHaveLength(CODE_LENGTH)
    expect(deriveCode(SECRET, 1)).toBe(deriveCode(SECRET, 1))
    expect(deriveCode(SECRET, 1)).not.toBe(deriveCode(SECRET, 2))
  })

  it('derives different codes for different secrets', () => {
    expect(deriveCode(SECRET, 1)).not.toBe(deriveCode(generateHostSecret(), 1))
  })

  it('groups the display form four at a time', () => {
    expect(displayCode('AB2CD3EF')).toBe('AB2C-D3EF')
  })

  it('accepts the issued code within the deadline', () => {
    const issued = issueCode(SECRET, null, T0)
    const result = redeemCode(SECRET, issued.slot, issued.code, T0 + 1000)
    expect(result.ok).toBe(true)
  })

  it('accepts the code typed in its display form', () => {
    const issued = issueCode(SECRET, null, T0)
    expect(redeemCode(SECRET, issued.slot, issued.display, T0 + 1000).ok).toBe(true)
  })

  it('accepts a lowercased code with O/I substitutions', () => {
    const issued = issueCode(SECRET, null, T0)
    const sloppy = issued.code.toLowerCase().replace(/0/g, 'o').replace(/1/g, 'l')
    expect(redeemCode(SECRET, issued.slot, sloppy, T0 + 1000).ok).toBe(true)
  })

  it('rejects an expired code', () => {
    const issued = issueCode(SECRET, null, T0)
    const after = T0 + DEFAULT_CODE_TTL_SECONDS * 1000 + 1
    expect(redeemCode(SECRET, issued.slot, issued.code, after)).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('reports a cleared deadline as consumed, not expired', () => {
    // `expiresAt: 0` is the "already redeemed" state. The operator needs to see
    // a replay as a replay; the client-facing answer stays uniform.
    expect(redeemCode(SECRET, { epoch: 1, expiresAt: 0 }, 'ABCD1234', T0)).toEqual({
      ok: false,
      reason: 'consumed',
    })
  })

  it('rejects a wrong code', () => {
    const issued = issueCode(SECRET, null, T0)
    const wrong = issued.code === '00000000' ? '11111111' : '00000000'
    expect(redeemCode(SECRET, issued.slot, wrong, T0 + 1000)).toEqual({
      ok: false,
      reason: 'mismatch',
    })
  })

  it('rejects a code of the wrong length without comparing', () => {
    const issued = issueCode(SECRET, null, T0)
    expect(redeemCode(SECRET, issued.slot, 'ABC', T0 + 1000)).toEqual({
      ok: false,
      reason: 'mismatch',
    })
  })

  it('reports no-code when nothing is outstanding', () => {
    expect(redeemCode(SECRET, null, 'ABCD1234', T0)).toEqual({ ok: false, reason: 'no-code' })
  })

  it('issues single-use codes: a replay is reported as consumed', () => {
    const issued = issueCode(SECRET, null, T0)
    const first = redeemCode(SECRET, issued.slot, issued.code, T0 + 1000)
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // The replayed code is compared against the *advanced* epoch, and the
    // cleared deadline marks it as a replay rather than a timeout.
    expect(redeemCode(SECRET, first.slot, issued.code, T0 + 2000)).toEqual({
      ok: false,
      reason: 'consumed',
    })
  })

  it('invalidates an outstanding code when a new one is issued', () => {
    const first = issueCode(SECRET, null, T0)
    const second = issueCode(SECRET, first.slot, T0 + 1000)
    expect(second.code).not.toBe(first.code)
    expect(redeemCode(SECRET, second.slot, first.code, T0 + 2000).ok).toBe(false)
    expect(redeemCode(SECRET, second.slot, second.code, T0 + 2000).ok).toBe(true)
  })

  it('sets the deadline from the configured ttl and honours it at redeem', () => {
    const issued = issueCode(SECRET, null, T0, 60)
    // The deadline is carried in the slot, so issuing and redeeming cannot
    // disagree about it.
    expect(issued.slot.expiresAt).toBe(T0 + 60_000)
    expect(redeemCode(SECRET, issued.slot, issued.code, T0 + 60_000).ok).toBe(true)
    expect(redeemCode(SECRET, issued.slot, issued.code, T0 + 60_001)).toEqual({
      ok: false,
      reason: 'expired',
    })
  })

  it('marks the redeemed slot as having no deadline', () => {
    const issued = issueCode(SECRET, null, T0)
    const result = redeemCode(SECRET, issued.slot, issued.code, T0 + 1)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.slot.expiresAt).toBe(0)
  })
})

describe('RateLimiter', () => {
  it('allows attempts up to the limit within a window', () => {
    const limiter = new RateLimiter(3, 60_000)
    expect(limiter.check('a', T0).allowed).toBe(true)
    expect(limiter.check('a', T0 + 1).allowed).toBe(true)
    expect(limiter.check('a', T0 + 2).allowed).toBe(true)
  })

  it('refuses past the limit and reports how long to wait', () => {
    const limiter = new RateLimiter(2, 60_000)
    limiter.check('a', T0)
    limiter.check('a', T0)
    const blocked = limiter.check('a', T0 + 10_000)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBe(50_000)
  })

  it('tracks keys independently', () => {
    const limiter = new RateLimiter(1, 60_000)
    expect(limiter.check('a', T0).allowed).toBe(true)
    expect(limiter.check('a', T0).allowed).toBe(false)
    expect(limiter.check('b', T0).allowed).toBe(true)
  })

  it('resets once the window rolls over', () => {
    const limiter = new RateLimiter(1, 60_000)
    limiter.check('a', T0)
    expect(limiter.check('a', T0 + 59_999).allowed).toBe(false)
    expect(limiter.check('a', T0 + 60_000).allowed).toBe(true)
  })

  it('prunes expired windows', () => {
    const limiter = new RateLimiter(1, 1000)
    limiter.check('a', T0)
    limiter.check('b', T0)
    limiter.prune(T0 + 1001)
    expect(limiter.check('a', T0 + 1001).allowed).toBe(true)
  })
})

describe('device tokens', () => {
  it('mints a prefixed token and a matching hash', () => {
    const issued = issueToken()
    expect(issued.token.startsWith(TOKEN_PREFIX)).toBe(true)
    expect(issued.tokenHash).toBe(hashToken(issued.token))
    expect(issued.tokenPrefix).toBe(issued.tokenHash.slice(0, 8))
  })

  it('mints distinct tokens', () => {
    const a = issueToken()
    const b = issueToken()
    expect(a.token).not.toBe(b.token)
    expect(a.tokenHash).not.toBe(b.tokenHash)
  })

  it('never stores the token itself', () => {
    const issued = issueToken()
    const device = createDeviceRecord(issued, { name: 'iPhone' }, T0)
    expect(JSON.stringify(device)).not.toContain(issued.token)
  })
})

describe('device records', () => {
  const issued = issueToken()
  const device = createDeviceRecord(issued, { name: 'iPhone', model: 'iPhone 18 Pro' }, T0)

  it('names the device and stamps both timestamps', () => {
    expect(device.name).toBe('iPhone')
    expect(device.model).toBe('iPhone 18 Pro')
    expect(device.createdAt).toBe(T0)
    expect(device.lastSeenAt).toBe(T0)
  })

  it('falls back to the model, then to a placeholder', () => {
    expect(createDeviceRecord(issued, { model: 'iPad Air' }, T0).name).toBe('iPad Air')
    expect(createDeviceRecord(issued, {}, T0).name).toBe('Unnamed device')
    expect(createDeviceRecord(issued, { name: '   ' }, T0).name).toBe('Unnamed device')
  })

  it('caps an overlong name', () => {
    const long = 'x'.repeat(200)
    expect(createDeviceRecord(issued, { name: long }, T0).name).toHaveLength(MAX_DEVICE_NAME)
  })

  it('verifies the token it was created from', () => {
    expect(verifyToken([device], issued.token)?.deviceId).toBe(device.deviceId)
  })

  it('rejects a token that was never issued', () => {
    expect(verifyToken([device], issueToken().token)).toBeNull()
  })

  it('rejects an empty or malformed token', () => {
    expect(verifyToken([device], '')).toBeNull()
    expect(verifyToken([device], 'mz_not-a-real-token')).toBeNull()
  })

  it('rejects a revoked device', () => {
    const revoked = revokeDevice([device], device.deviceId, T0 + 10)
    expect(verifyToken(revoked, issued.token)).toBeNull()
    expect(revoked[0]?.revokedAt).toBe(T0 + 10)
  })

  it('preserves the record when revoking, and is idempotent', () => {
    const once = revokeDevice([device], device.deviceId, T0 + 10)
    const twice = revokeDevice(once, device.deviceId, T0 + 20)
    expect(twice[0]?.revokedAt).toBe(T0 + 10)
    expect(twice[0]?.name).toBe('iPhone')
  })

  it('ignores an unknown device id and returns the same list it was given', () => {
    const devices = [device]
    // Returning the input reference (rather than an equal copy) is what lets a
    // caller skip a state write when nothing changed.
    expect(revokeDevice(devices, 'nope', T0)).toBe(devices)
    expect(revokeDevice(devices, 'nope', T0)[0]?.revokedAt).toBeUndefined()
  })

  it('touches only the authenticating device', () => {
    const other = createDeviceRecord(issueToken(), { name: 'iPad' }, T0)
    const touched = touchDevice([device, other], device.deviceId, T0 + 500)
    expect(touched[0]?.lastSeenAt).toBe(T0 + 500)
    expect(touched[1]?.lastSeenAt).toBe(T0)
  })

  it('finds the live device even when a revoked one shares the token', () => {
    // Defensive: a duplicated hash must not shadow the live record.
    const clone = { ...device, deviceId: 'clone', revokedAt: T0 }
    expect(verifyToken([clone, device], issued.token)?.deviceId).toBe(device.deviceId)
  })

  it('partitions into live and revoked, newest first', () => {
    const older = createDeviceRecord(issueToken(), { name: 'old' }, T0)
    const newer = createDeviceRecord(issueToken(), { name: 'new' }, T0 + 1000)
    const revoked = revokeDevice([older], older.deviceId, T0 + 2000)
    const { live, revoked: dead } = partitionDevices([...revoked, newer])
    expect(live.map((d) => d.name)).toEqual(['new'])
    expect(dead.map((d) => d.name)).toEqual(['old'])
  })
})
