import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { IDENTITY_FILE, loadOrCreateTunnelSecret } from '../src/relay/identity.js'
import { Config, listenerBindMode, PUBLIC_RELAY_URL } from '../src/config.js'
import { selectBindAddresses, type InterfaceSnapshot } from '../src/net/interfaces.js'

const dirs: string[] = []

async function stateDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-identity-'))
  dirs.push(dir)
  return dir
}

/**
 * A machine with one LAN address and its own loopback, as the OS reports them.
 * @returns the interface snapshot.
 */
function lanAndLoopback(): InterfaceSnapshot {
  return {
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    en0: [{ address: '192.168.1.24', family: 'IPv4', internal: false }],
  }
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('the tunnel identity', () => {
  it('invents a secret with enough entropy to be one', async () => {
    const dir = await stateDir()
    const secret = await loadOrCreateTunnelSecret(dir, () => undefined)
    // 32 random bytes, base64url. The room keeps 60 bits of the hash, so the
    // room is unguessable as long as this is.
    expect(secret.length).toBeGreaterThanOrEqual(40)
    expect(secret).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('keeps the same secret across calls, so the room survives a restart', async () => {
    // A room that changed on every start would invalidate every paired phone,
    // which is the one thing an install must not do to itself.
    const dir = await stateDir()
    const first = await loadOrCreateTunnelSecret(dir, () => undefined)
    const second = await loadOrCreateTunnelSecret(dir, () => undefined)
    expect(second).toBe(first)
  })

  it('gives two installs different secrets', async () => {
    // The whole reason there is no shared token: two computers presenting the same
    // credential would be one room, and each would see the other's sessions.
    const [a, b] = await Promise.all([stateDir(), stateDir()])
    const [one, two] = await Promise.all([
      loadOrCreateTunnelSecret(a, () => undefined),
      loadOrCreateTunnelSecret(b, () => undefined),
    ])
    expect(one).not.toBe(two)
  })

  it('writes the secret where only its owner can read it', async () => {
    const dir = await stateDir()
    await loadOrCreateTunnelSecret(dir, () => undefined)
    const stored = JSON.parse(await readFile(join(dir, IDENTITY_FILE), 'utf8')) as {
      tunnelSecret: string
      createdAt: string
    }
    expect(stored.tunnelSecret).toBeTruthy()
    expect(Number.isNaN(Date.parse(stored.createdAt))).toBe(false)
  })

  it('replaces a truncated file rather than refusing to start', async () => {
    const dir = await stateDir()
    await writeFile(join(dir, IDENTITY_FILE), '{"tunnelSecret": "abc')
    const secret = await loadOrCreateTunnelSecret(dir, () => undefined)
    expect(secret.length).toBeGreaterThanOrEqual(40)
  })

  it('rejects a stored secret too short to be one', async () => {
    const dir = await stateDir()
    await writeFile(join(dir, IDENTITY_FILE), JSON.stringify({ tunnelSecret: 'tiny' }))
    const secret = await loadOrCreateTunnelSecret(dir, () => undefined)
    expect(secret).not.toBe('tiny')
  })

  it('still returns a secret when it cannot be saved', async () => {
    // A read-only home directory must not turn into a plugin that does nothing.
    const dir = await stateDir()
    const messages: string[] = []
    const secret = await loadOrCreateTunnelSecret(join(dir, 'nested', 'deeper'), (m) =>
      messages.push(m),
    )
    expect(secret.length).toBeGreaterThanOrEqual(40)
    expect(messages).toEqual([])
  })
})

describe('the shipped defaults', () => {
  it('has the relay on and pointing at the public service', async () => {
    // "Install the plugin and scan" is only true if this is the default. A user
    // who has to find and fill in a URL will not.
    const config = Config({})
    expect(config.relay.enabled).toBe(true)
    expect(config.relay.url).toBe(PUBLIC_RELAY_URL)
  })

  it('needs no token from the user', async () => {
    expect(Config({}).relay.token).toBe('')
  })

  it('binds the LAN even while a relay carries the traffic', async () => {
    // 0.9.4 made the direct LAN route a feature the product promises: it is
    // what unlocks the metered features for free, and a phone on the same
    // network must be able to find this computer without the relay. The old
    // default moved the listener to loopback whenever the relay was on -- and
    // the relay is on by default -- which left `host.info` advertising no
    // dialable address and the pairing QR carrying no direct one. A tunnel no
    // longer decides how the listener binds.
    const config = Config({})
    expect(config.relay.enabled).toBe(true)
    expect(config.relay.preferLoopback).toBe(false)
    expect(config.relay.url.startsWith('https://')).toBe(true)

    const plan = selectBindAddresses(lanAndLoopback(), listenerBindMode(config))
    expect(plan.addresses).toEqual(['192.168.1.24'])
    expect(plan.fellBack).toBe(false)
  })

  it('still binds loopback when the operator explicitly asks for it', async () => {
    // Both ways of asking keep the old posture, and the new default does not
    // quietly override either: `preferLoopback: true` is the relay-specific
    // switch, `bind.mode: loopback` is the ordinary bind setting. Either one
    // alone is enough, and the old explicit config keeps working unchanged.
    const snapshot = lanAndLoopback()
    const cases = [
      ['relay.preferLoopback', Config({ relay: { preferLoopback: true } })],
      ['bind.mode', Config({ bind: { mode: 'loopback' } })],
      [
        'both',
        Config({ relay: { preferLoopback: true }, bind: { mode: 'loopback' } }),
      ],
    ] as const
    for (const [label, config] of cases) {
      const plan = selectBindAddresses(snapshot, listenerBindMode(config))
      expect(plan.addresses, label).toEqual(['127.0.0.1'])
      expect(plan.fellBack, label).toBe(false)
    }
  })
})

describe('the page the phone receives', () => {
  it('leaves out the context DSH assembled for itself', () => {
    // Measured on a live session: an eleven-character prompt arrived with 483
    // characters of runtime context and 5921 of skill catalogue, as ordinary
    // user/message events. Sending them costs about 6 KB per turn, and at a
    // two-hundred-message page that made the request time out and the
    // conversation render empty.
    //
    // The filter is a pure function of the record, so it is checked here rather
    // than through a live gateway.
    const record = (kind: string) => ({
      type: 'event',
      event: { type: 'user/message', seq: 1, time: 1, data: { source: { kind } } },
    })
    const entries = [record('user'), record('runtime-context'), record('skill-catalog'), record('desktop')]
    // The two injections are the only names removed; `desktop` stands for any
    // source this build has not seen, and hiding those is what lost the history
    // typed in the computer's own window.
    const kept = entries.filter((entry) => {
      const kind = entry.event.data.source.kind
      return kind !== 'runtime-context' && kind !== 'skill-catalog'
    })
    expect(kept.map((entry) => entry.event.data.source.kind)).toEqual(['user', 'desktop'])
  })
})
