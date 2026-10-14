/**
 * Tests for listener address selection.
 *
 * This module decides what the Mizar listener is reachable on, so a bug here is
 * an exposure bug rather than a cosmetic one. The cases below pin the two
 * behaviours that matter most: range-based tailnet matching (never interface
 * names), and the rule that a mode which finds nothing falls back to loopback
 * instead of widening.
 *
 * @module dsh-mizar/test/interfaces
 */
import { describe, expect, it } from 'vitest'
import {
  authorityOf,
  isTailnetAddress,
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

describe('isTailnetAddress', () => {
  it('accepts the CGNAT block boundaries', () => {
    expect(isTailnetAddress('100.64.0.1')).toBe(true)
    expect(isTailnetAddress('100.127.255.254')).toBe(true)
    expect(isTailnetAddress('100.100.100.100')).toBe(true)
  })

  it('rejects addresses just outside the CGNAT block', () => {
    expect(isTailnetAddress('100.63.255.255')).toBe(false)
    expect(isTailnetAddress('100.128.0.1')).toBe(false)
    expect(isTailnetAddress('100.0.0.1')).toBe(false)
  })

  it('rejects ordinary private and public addresses', () => {
    expect(isTailnetAddress('192.168.1.10')).toBe(false)
    expect(isTailnetAddress('10.0.0.5')).toBe(false)
    expect(isTailnetAddress('8.8.8.8')).toBe(false)
    expect(isTailnetAddress('127.0.0.1')).toBe(false)
  })

  it('accepts the tailnet IPv6 prefix regardless of case', () => {
    expect(isTailnetAddress('fd7a:115c:a1e0::1')).toBe(true)
    expect(isTailnetAddress('FD7A:115C:A1E0:0000::42')).toBe(true)
    expect(isTailnetAddress('fd7a:115c:a1e1::1')).toBe(false)
  })

  it('ignores an IPv6 zone index', () => {
    expect(isTailnetAddress('fd7a:115c:a1e0::1%utun3')).toBe(true)
  })
})

describe('selectBindAddresses', () => {
  it('binds tailnet addresses and ignores unrelated tunnels', () => {
    const snapshot = snapshotOf([
      ['lo0', '127.0.0.1', 'IPv4', true],
      ['en0', '192.168.1.24', 'IPv4'],
      // Nine unrelated utun interfaces is the real shape of the dev machine;
      // name-based matching would bind the wrong thing here.
      ['utun0', '10.8.0.2', 'IPv4'],
      ['utun1', '172.16.5.9', 'IPv4'],
      ['utun2', 'fe80::1%utun2', 'IPv6'],
      ['utun3', 'fd7a:115c:a1e0::1', 'IPv6'],
      ['en0', '100.101.102.103', 'IPv4'],
    ])

    const plan = selectBindAddresses(snapshot, 'tailscale')
    expect(plan.fellBack).toBe(false)
    expect(plan.mode).toBe('tailscale')
    expect([...plan.addresses].sort()).toEqual(['100.101.102.103', 'fd7a:115c:a1e0::1'])
  })

  it('falls back to loopback when no tailnet address exists', () => {
    const snapshot = snapshotOf([
      ['lo0', '127.0.0.1', 'IPv4', true],
      ['en0', '192.168.1.24', 'IPv4'],
      ['utun0', '10.8.0.2', 'IPv4'],
    ])

    const plan = selectBindAddresses(snapshot, 'tailscale')
    expect(plan.fellBack).toBe(true)
    expect(plan.mode).toBe('loopback')
    // The important assertion: the LAN address must NOT be picked up.
    expect(plan.addresses).toEqual([LOOPBACK])
    expect(plan.reason).toContain('Tailscale')
  })

  it('never widens from tailscale to a LAN address', () => {
    const snapshot = snapshotOf([['en0', '192.168.1.24', 'IPv4']])
    const plan = selectBindAddresses(snapshot, 'tailscale')
    expect(plan.addresses).not.toContain('192.168.1.24')
  })

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

  it('skips internal addresses even when they look tailnet-shaped', () => {
    const plan = selectBindAddresses(
      snapshotOf([['lo0', '100.64.0.1', 'IPv4', true]]),
      'tailscale',
    )
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
