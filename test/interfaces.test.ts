/**
 * Tests for listener address selection.
 *
 * This module decides what the Mizar listener is reachable on, so a bug here is
 * an exposure bug rather than a cosmetic one. The cases below pin the two
 * behaviours that matter most: address selection and its fallbacks, which are
 * names), and the rule that a mode which finds nothing falls back to loopback
 * instead of widening.
 *
 * @module dsh-mizar/test/interfaces
 */
import { describe, expect, it } from 'vitest'
import {
  authorityOf,
  LOOPBACK,
  selectBindAddresses,
  type InterfaceSnapshot,
} from '../src/net/interfaces.js'

/** Build a snapshot from `[name, address, family, internal?]` rows. */
function snapshotOf(
  rows: readonly (readonly [string, string, string, boolean?])[],
): InterfaceSnapshot {
  const snapshot: Record<string, { address: string; family: string; internal: boolean }[]> = {}
  for (const [name, address, family, internal = false] of rows) {
    const list = snapshot[name] ?? []
    list.push({ address, family, internal })
    snapshot[name] = list
  }
  return snapshot
}

describe('selectBindAddresses', () => {

  it('binds every non-internal IPv4 address in lan mode', () => {
    const snapshot = snapshotOf([
      ['lo0', '127.0.0.1', 'IPv4', true],
      ['en0', '192.168.1.24', 'IPv4'],
      ['en1', '10.0.0.7', 'IPv4'],
      ['en0', 'fe80::abc', 'IPv6'],
    ])

    const plan = selectBindAddresses(snapshot, 'lan')
    expect([...plan.addresses].sort()).toEqual(['10.0.0.7', '192.168.1.24'])
    expect(plan.fellBack).toBe(false)
  })

  it('falls back when lan mode finds only internal addresses', () => {
    const plan = selectBindAddresses(snapshotOf([['lo0', '127.0.0.1', 'IPv4', true]]), 'lan')
    expect(plan.fellBack).toBe(true)
    expect(plan.addresses).toEqual([LOOPBACK])
  })

  it('binds loopback when asked', () => {
    const plan = selectBindAddresses(snapshotOf([['en0', '192.168.1.24', 'IPv4']]), 'loopback')
    expect(plan.addresses).toEqual([LOOPBACK])
    expect(plan.fellBack).toBe(false)
  })

  it('binds explicit addresses, normalising and deduplicating them', () => {
    const plan = selectBindAddresses(snapshotOf([]), 'addresses', [
      'FD7A:115C:A1E0::1',
      'fd7a:115c:a1e0::1',
      '100.64.0.9',
      '',
    ])
    expect(plan.addresses).toEqual(['fd7a:115c:a1e0::1', '100.64.0.9'])
    expect(plan.fellBack).toBe(false)
  })

  it('falls back when explicit mode is given nothing', () => {
    const plan = selectBindAddresses(snapshotOf([]), 'addresses', [])
    expect(plan.fellBack).toBe(true)
    expect(plan.addresses).toEqual([LOOPBACK])
  })

})

describe('authorityOf', () => {
  it('formats IPv4 plainly', () => {
    expect(authorityOf('100.64.0.9', 19390)).toBe('100.64.0.9:19390')
  })

  it('brackets IPv6 literals', () => {
    expect(authorityOf('fd7a:115c:a1e0::1', 19390)).toBe('[fd7a:115c:a1e0::1]:19390')
  })
})
