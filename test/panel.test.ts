/**
 * Tests for the pairing URI and the panel's status view.
 *
 * Both are contracts rather than logic: the URI is shared with the app and must
 * round-trip, and the status view is what the operator reads to decide whether a
 * device still has access. The cases below pin the properties that would be
 * silently wrong — a spent code shown as live, a revoked device sorted as if it
 * were active, a URI that loses its host on the way through a camera.
 *
 * @module dsh-mizar/test/panel
 */
import { describe, expect, it } from 'vitest'
import { buildPairingUri, parsePairingUri, PAIRING_SCHEME } from '../src/protocol/pairing-uri.js'
import { buildPanelStatus, type PanelStatusInput } from '../src/panel/status.js'
import { createDeviceRecord, issueToken, revokeDevice } from '../src/auth/devices.js'
import type { BindPlan } from '../src/net/interfaces.js'

const PLAN: BindPlan = {
  addresses: ['100.64.0.1'],
  mode: 'lan',
  fellBack: false,
  reason: 'LAN address detected',
}

const T0 = 1_700_000_000_000

/** Build a status input with sensible defaults. */
function statusInput(overrides: Partial<PanelStatusInput> = {}): PanelStatusInput {
  return {
    hostId: 'host-1',
    hostName: 'shirazu-mac',
    protocolVersion: 1,
    authorities: ['100.64.0.1:19390'],
    plan: PLAN,
    pairing: null,
    devices: [],
    clients: 0,
    relay: null,
    now: T0,
    deriveCode: () => 'AB2CD3EF',
    ...overrides,
  }
}

describe('pairing URI', () => {
  it('uses the mizar scheme', () => {
    expect(PAIRING_SCHEME).toBe('mizar')
  })

  it('round-trips every field', () => {
    const uri = buildPairingUri('100.64.0.1:19390', 'AB2C-D3EF', 'shirazu-mac', 1)
    expect(uri).not.toBeNull()
    expect(parsePairingUri(uri ?? '')).toEqual({
      authority: '100.64.0.1:19390',
      baseURL: null,
      code: 'AB2C-D3EF',
      hostName: 'shirazu-mac',
      protocolVersion: 1,
    })
  })

  it('survives an IPv6 authority', () => {
    const uri = buildPairingUri('[fd7a:115c:a1e0::1]:19390', 'AB2C-D3EF', 'mac', 1)
    expect(parsePairingUri(uri)?.authority).toBe('[fd7a:115c:a1e0::1]:19390')
  })

  it('survives a host name needing escaping', () => {
    const uri = buildPairingUri('10.0.0.1:19390', 'AB2C-D3EF', "Shirazu's MacBook Pro", 1)
    expect(parsePairingUri(uri)?.hostName).toBe("Shirazu's MacBook Pro")
  })

  it('tolerates surrounding whitespace from a scanner', () => {
    const uri = buildPairingUri('10.0.0.1:19390', 'AB2C-D3EF', 'mac', 1)
    expect(parsePairingUri(`  ${uri}\n`)?.authority).toBe('10.0.0.1:19390')
  })

  it('rejects anything that is not a pairing URI', () => {
    // A camera pointed at the wrong QR is a normal event, not an error.
    expect(parsePairingUri('https://example.com')).toBeNull()
    expect(parsePairingUri('mizar://other?h=x&c=y')).toBeNull()
    expect(parsePairingUri('')).toBeNull()
  })

  it('rejects a URI missing the host or the code', () => {
    expect(parsePairingUri('mizar://pair?c=AB2C')).toBeNull()
    expect(parsePairingUri('mizar://pair?h=10.0.0.1:19390')).toBeNull()
  })

  it('reports a missing or unparsable version as null rather than a guess', () => {
    expect(parsePairingUri('mizar://pair?h=h&c=c')?.protocolVersion).toBeNull()
    expect(parsePairingUri('mizar://pair?h=h&c=c&v=two')?.protocolVersion).toBeNull()
  })
})

describe('buildPanelStatus', () => {
  it('reports a live pairing code with its QR payload', () => {
    const status = buildPanelStatus(
      statusInput({ pairing: { epoch: 3, expiresAt: T0 + 60_000 } }),
    )
    expect(status.pairing?.display).toBe('AB2C-D3EF')
    expect(status.pairing?.expiresAt).toBe(T0 + 60_000)
    expect(parsePairingUri(status.pairing?.uri ?? '')).toEqual({
      authority: '100.64.0.1:19390',
      baseURL: null,
      code: 'AB2C-D3EF',
      hostName: 'shirazu-mac',
      protocolVersion: 1,
    })
  })

  it('hides a spent code', () => {
    // A redeemed slot keeps `expiresAt: 0`. Showing it would invite an operator
    // to read out something that can never work.
    expect(buildPanelStatus(statusInput({ pairing: { epoch: 4, expiresAt: 0 } })).pairing).toBeNull()
  })

  it('hides an expired code', () => {
    expect(buildPanelStatus(statusInput({ pairing: { epoch: 3, expiresAt: T0 - 1 } })).pairing).toBeNull()
  })

  it('treats the deadline as exclusive', () => {
    expect(buildPanelStatus(statusInput({ pairing: { epoch: 3, expiresAt: T0 } })).pairing).toBeNull()
  })

  it('reports no code when the derivation yields nothing', () => {
    // Better to show no code than a blank one that looks scannable.
    const status = buildPanelStatus(
      statusInput({ pairing: { epoch: 3, expiresAt: T0 + 1000 }, deriveCode: () => '' }),
    )
    expect(status.pairing).toBeNull()
  })

  it('surfaces the bind fallback so the operator knows why nothing connects', () => {
    const status = buildPanelStatus(
      statusInput({
        plan: {
          addresses: ['127.0.0.1'],
          mode: 'loopback',
          fellBack: true,
          reason: 'no LAN address found — binding loopback only',
        },
        authorities: ['127.0.0.1:19390'],
      }),
    )
    // The reason is what the operator reads to find out why nothing connects,
    // so it has to survive to the panel rather than being flattened to a code.
    expect(status.bind.fellBack).toBe(true)
    expect(status.bind.reason).toContain('loopback')
    expect(status.listening).toBe(true)
  })

  it('reports not listening when no address was bound', () => {
    expect(buildPanelStatus(statusInput({ authorities: [] })).listening).toBe(false)
  })

  it('sorts live devices before revoked ones, newest first within each group', () => {
    const older = createDeviceRecord(issueToken(), { name: 'older' }, T0)
    const newer = createDeviceRecord(issueToken(), { name: 'newer' }, T0 + 5000)
    const doomed = createDeviceRecord(issueToken(), { name: 'dead' }, T0 + 9000)
    // Revoke by the real id: a wrong id leaves the device live and the ordering
    // assertion would pass for the wrong reason.
    const dead = revokeDevice([doomed], doomed.deviceId, T0)

    const status = buildPanelStatus(statusInput({ devices: [older, dead[0] as never, newer] }))
    expect(status.devices.map((device) => device.name)).toEqual(['newer', 'older', 'dead'])
    expect(status.devices.at(-1)?.revoked).toBe(true)
  })

  it('carries the non-secret identity an operator can quote in a support request', () => {
    const device = createDeviceRecord(issueToken(), { name: 'iPhone', model: 'iPhone 18 Pro' }, T0)
    const status = buildPanelStatus(statusInput({ devices: [device] }))
    expect(status.devices[0]).toMatchObject({
      name: 'iPhone',
      model: 'iPhone 18 Pro',
      tokenPrefix: device.tokenPrefix,
      revoked: false,
    })
    // The token itself must never reach the panel.
    expect(JSON.stringify(status)).not.toContain(device.tokenHash)
  })

  it('reports a missing model as null rather than an empty string', () => {
    const device = createDeviceRecord(issueToken(), { name: 'iPhone' }, T0)
    expect(buildPanelStatus(statusInput({ devices: [device] })).devices[0]?.model).toBeNull()
  })

  it('passes through the connected client count', () => {
    expect(buildPanelStatus(statusInput({ clients: 3 })).clients).toBe(3)
  })
})

describe('pairing URI with a relay', () => {
  it('round-trips a base URL alongside a direct authority', () => {
    const uri = buildPairingUri(
      '100.64.0.1:19390',
      'AB2C-D3EF',
      'shirazu-mac',
      1,
      'https://relay.example.com/r/WBKW0NZVT5QZ',
    )
    expect(parsePairingUri(uri ?? '')).toEqual({
      authority: '100.64.0.1:19390',
      baseURL: 'https://relay.example.com/r/WBKW0NZVT5QZ',
      code: 'AB2C-D3EF',
      hostName: 'shirazu-mac',
      protocolVersion: 1,
    })
  })

  it('carries a relay with no direct authority at all', () => {
    const uri = buildPairingUri('', 'AB2C-D3EF', 'shirazu-mac', 1, 'https://relay.example.com/r/R')
    expect(parsePairingUri(uri ?? '')).toMatchObject({
      authority: null,
      baseURL: 'https://relay.example.com/r/R',
    })
  })

  it('refuses to build a URI with no address to dial', () => {
    // A QR that scans and then fails, with nothing useful to say about why, is
    // worse than no QR.
    expect(buildPairingUri('', 'AB2C-D3EF', 'shirazu-mac', 1, null)).toBeNull()
    expect(buildPairingUri('', 'AB2C-D3EF', 'shirazu-mac', 1, '')).toBeNull()
  })

  it('still builds the old shape when there is no relay', () => {
    // Backward compatibility: a stored pairing from before this change must
    // still parse, and a new URI with no relay must look exactly as it did.
    const uri = buildPairingUri('100.64.0.1:19390', 'AB2C-D3EF', 'shirazu-mac', 1)
    expect(uri).not.toContain('u=')
    expect(parsePairingUri(uri ?? '')?.baseURL).toBeNull()
  })

  it('parses an old URI that has no u parameter', () => {
    const target = parsePairingUri('mizar://pair?h=100.64.0.1:19390&c=AB2C-D3EF&n=mac&v=1')
    expect(target).toMatchObject({ authority: '100.64.0.1:19390', baseURL: null })
  })

  it('refuses a relay URL whose scheme the client cannot dial', () => {
    // A scanned code is untrusted input and this URL decides where a device
    // token gets sent.
    expect(parsePairingUri('mizar://pair?u=file:///etc/passwd&c=AB2C-D3EF&v=1')).toBeNull()
    expect(parsePairingUri('mizar://pair?u=javascript:alert(1)&c=AB2C-D3EF&v=1')).toBeNull()
    expect(parsePairingUri('mizar://pair?u=rdp://host/x&c=AB2C-D3EF&v=1')).toBeNull()
  })

  it('accepts a plain http relay, for a LAN or a test', () => {
    expect(parsePairingUri('mizar://pair?u=http://127.0.0.1:8787/r/R&c=AB2C-D3EF&v=1')).toMatchObject(
      { baseURL: 'http://127.0.0.1:8787/r/R' },
    )
  })

  it('refuses a URI with a code but no address at all', () => {
    expect(parsePairingUri('mizar://pair?c=AB2C-D3EF&n=mac&v=1')).toBeNull()
  })
})

describe('buildPanelStatus with a relay', () => {
  it('points the QR at the relay and leaves out a loopback authority', () => {
    // A phone cannot reach 127.0.0.1 on the computer. Offering it would make every
    // scan spend its direct-connection timeout before trying the relay that
    // actually works.
    const status = buildPanelStatus(
      statusInput({
        authorities: ['127.0.0.1:19390'],
        pairing: { epoch: 3, expiresAt: T0 + 60_000 },
        relay: {
          connected: true,
          room: 'WBKW0NZVT5QZ',
          pairBaseURL: 'https://relay.example.com/r/WBKW0NZVT5QZ',
          lastError: null,
        },
      }),
    )
    expect(parsePairingUri(status.pairing?.uri ?? '')).toMatchObject({
      authority: null,
      baseURL: 'https://relay.example.com/r/WBKW0NZVT5QZ',
    })
  })

  it('offers both when a LAN address is also bound', () => {
    const status = buildPanelStatus(
      statusInput({
        authorities: ['127.0.0.1:19390', '192.168.1.5:19390'],
        pairing: { epoch: 3, expiresAt: T0 + 60_000 },
        relay: {
          connected: true,
          room: 'ROOM',
          pairBaseURL: 'https://relay.example.com/r/ROOM',
          lastError: null,
        },
      }),
    )
    expect(parsePairingUri(status.pairing?.uri ?? '')).toMatchObject({
      authority: '192.168.1.5:19390',
      baseURL: 'https://relay.example.com/r/ROOM',
    })
  })

  it('reports the relay state so an operator can tell unreachable from unconfigured', () => {
    const status = buildPanelStatus(
      statusInput({
        relay: {
          connected: false,
          room: 'ROOM',
          pairBaseURL: 'https://relay.example.com/r/ROOM',
          lastError: 'the relay connection closed',
        },
      }),
    )
    expect(status.relay).toEqual({
      enabled: true,
      connected: false,
      room: 'ROOM',
      pairBaseURL: 'https://relay.example.com/r/ROOM',
      lastError: 'the relay connection closed',
    })
  })

  it('reports no relay block when none is configured', () => {
    expect(buildPanelStatus(statusInput()).relay).toBeNull()
  })

  it('renders no QR when there is neither a relay nor a reachable address', () => {
    const status = buildPanelStatus(
      statusInput({
        authorities: ['127.0.0.1:19390'],
        pairing: { epoch: 3, expiresAt: T0 + 60_000 },
      }),
    )
    // The code is still reported -- an operator can read it out -- but with no
    // address there is no QR that could work.
    expect(status.pairing).toBeNull()
  })
})
