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
import { Config } from '../src/config.js'

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
