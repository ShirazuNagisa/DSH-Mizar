//
//  config.test.ts
//  dsh-mizar
//
//  The relay watchdog's defaults.
//
//  The watchdog is what turns a half-open tunnel into a reconnect instead of a
//  room that is dark until DSH restarts, so its window is a promise about time
//  rather than an implementation detail.
//

import { describe, expect, it } from 'vitest'
import { Config, PUBLIC_RELAY_URL, resolveStunServers, STUN_PORT } from '../src/config.js'

describe('the relay tunnel watchdog', () => {
  it('waits four relay ping intervals by default', () => {
    // The relay pings every tunnelIdleMs / 3 (30 s with its default 90 s idle
    // window) and drops a tunnel it has not heard from in 90 s. 120 s of local
    // silence is four missed pings: no healthy relay goes quiet that long, and
    // the room cannot stay dead for hours either.
    expect(Config({}).relay.watchdogMs).toBe(120_000)
  })

  it('can be tuned, and turned off with zero', () => {
    expect(Config({ relay: { watchdogMs: 45_000 } }).relay.watchdogMs).toBe(45_000)
    expect(Config({ relay: { watchdogMs: 0 } }).relay.watchdogMs).toBe(0)
  })
})

describe('which STUN server the direct path asks', () => {
  it('follows the relay this project ships', () => {
    const config = Config({})
    expect(config.relay.url).toBe(PUBLIC_RELAY_URL)
    // Same host as the relay, on the standard STUN port: the computer that
    // already talks to the relay for its tunnel asks the same machine where it
    // appears from, so no new party learns about the session.
    expect(resolveStunServers(config)).toEqual([`dshmizar.shirazu-nagisa.com:${STUN_PORT}`])
  })

  it('asks nobody when the relay is somebody else\'s', () => {
    // A self-hoster pointing at their own relay must not have their computer
    // announce itself to this project. Nothing is the honest default, and the
    // direct path still works on one LAN.
    const config = Config({ relay: { url: 'https://relay.example.net' } })
    expect(resolveStunServers(config)).toEqual([])
  })

  it('lets an explicit list win, and accepts the empty answer', () => {
    const explicit = Config({ net: { stunServers: ['10.0.0.2:3478', 'stun.example.net:19302'] } })
    expect(resolveStunServers(explicit)).toEqual(['10.0.0.2:3478', 'stun.example.net:19302'])
    // An operator who wants no address discovery says so, on their own relay.
    const none = Config({ relay: { url: PUBLIC_RELAY_URL }, net: { stunServers: [] } })
    expect(resolveStunServers(none)).toEqual([`dshmizar.shirazu-nagisa.com:${STUN_PORT}`])
  })

  it('shrugs at a relay URL that is not a URL', () => {
    expect(resolveStunServers(Config({ relay: { url: 'not a url' } }))).toEqual([])
  })

  it('keeps port mapping off until the rollout says otherwise', () => {
    // Off is the conservative default: it makes the computer dialable, which is
    // worth a lot, but it also announces the plugin on the local network.
    expect(Config({}).net.portMapping).toBe(false)
    expect(Config({ net: { portMapping: true } }).net.portMapping).toBe(true)
  })
})
