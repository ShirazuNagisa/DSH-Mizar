import { describe, expect, it } from 'vitest'
import { base32, deriveRoom, secretsEqual } from '../src/room.js'

describe('base32', () => {
  it('encodes the Crockford alphabet, excluding I, L, O and U', () => {
    const encoded = base32(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff]))
    expect(encoded).toMatch(/^[0-9A-HJKMNP-TV-Z]+$/)
    expect(encoded).not.toMatch(/[ILOU]/)
  })

  it('encodes nothing as nothing', () => {
    expect(base32(new Uint8Array([]))).toBe('')
  })

  it('is stable for a known input', () => {
    // A golden value. If this changes, every deployed room id changes with it and
    // every QR code already in somebody's app stops resolving.
    expect(base32(new TextEncoder().encode('mizar'))).toBe('DNMQMRBJ')
  })
})

describe('deriveRoom', () => {
  it('is deterministic', () => {
    expect(deriveRoom('a-token')).toBe(deriveRoom('a-token'))
  })

  it('produces a 12-character id with no lookalike letters', () => {
    const room = deriveRoom('a-token')
    expect(room).toHaveLength(12)
    expect(room).toMatch(/^[0-9A-HJKMNP-TV-Z]{12}$/)
  })

  it('separates tokens that differ by one character', () => {
    // A room id is a function of the capability, so two tokens must never collide
    // onto one room -- that would let one Mac's phone reach a different Mac.
    expect(deriveRoom('token-a')).not.toBe(deriveRoom('token-b'))
    expect(deriveRoom('token-a')).not.toBe(deriveRoom('token-a '))
  })

  it('does not reveal the token', () => {
    const token = 'super-secret-value'
    expect(deriveRoom(token)).not.toContain(token)
  })

  it('matches a golden value', () => {
    // Pinned so the plugin's stored pairing survives a relay upgrade.
    expect(deriveRoom('mizar-test-token')).toBe('WBKW0NZVT5QZ')
  })
})

describe('secretsEqual', () => {
  it('accepts equal secrets', () => {
    expect(secretsEqual('abc123', 'abc123')).toBe(true)
  })

  it('rejects differing secrets', () => {
    expect(secretsEqual('abc123', 'abc124')).toBe(false)
  })

  it('rejects a prefix rather than throwing on the length mismatch', () => {
    // timingSafeEqual throws on different lengths; this must answer, not raise.
    expect(secretsEqual('abc', 'abcdef')).toBe(false)
    expect(secretsEqual('abcdef', 'abc')).toBe(false)
  })

  it('rejects empty against non-empty', () => {
    expect(secretsEqual('', 'a')).toBe(false)
    expect(secretsEqual('', '')).toBe(true)
  })
})
