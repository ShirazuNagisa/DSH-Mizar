/**
 * Tests for bind-plan watching.
 *
 * The behaviour under test is timing, which is exactly why the reader is
 * injected: the alternative is a test that depends on how fast a machine
 * happens to bring up a network interface.
 *
 * @module dsh-mizar/test/watch
 */
import { describe, expect, it, vi } from 'vitest'
import type { BindPlan } from '../src/net/interfaces.js'
import { awaitRequestedPlan, bindKey, isRequested, needsRebind } from '../src/net/watch.js'

/** Build a plan. */
function plan(
  addresses: readonly string[],
  options: { mode?: BindPlan['mode']; fellBack?: boolean; reason?: string } = {},
): BindPlan {
  return {
    addresses,
    mode: options.mode ?? 'lan',
    fellBack: options.fellBack ?? false,
    reason: options.reason ?? 'test',
  }
}

const FALLBACK = plan(['127.0.0.1'], { mode: 'loopback', fellBack: true, reason: 'no LAN address' })

describe('bindKey', () => {
  it('is order-insensitive, so a reordered plan is not a change', () => {
    // Otherwise a reorder would trigger a needless rebind and drop every client.
    expect(bindKey(plan(['b', 'a']))).toBe(bindKey(plan(['a', 'b'])))
  })

  it('distinguishes different addresses', () => {
    expect(bindKey(plan(['a']))).not.toBe(bindKey(plan(['b'])))
  })

  it('distinguishes modes with the same addresses', () => {
    expect(bindKey(plan(['127.0.0.1'], { mode: 'loopback' }))).not.toBe(
      bindKey(plan(['127.0.0.1'], { mode: 'lan' })),
    )
  })
})

describe('isRequested', () => {
  it('treats a requested loopback as requested', () => {
    // The distinguishing flag is `fellBack`, not the mode: asking for loopback
    // and getting loopback is a success.
    expect(isRequested(plan(['127.0.0.1'], { mode: 'loopback', fellBack: false }))).toBe(true)
  })

  it('treats a fallback as not requested', () => {
    expect(isRequested(FALLBACK)).toBe(false)
  })
})

describe('awaitRequestedPlan', () => {
  it('returns immediately when the first read is already right', async () => {
    const read = vi.fn(() => plan(['100.64.0.1']))
    const result = await awaitRequestedPlan(read, { waitMs: 60_000, pollMs: 1 })
    expect(result.addresses).toEqual(['100.64.0.1'])
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('returns immediately when no waiting is configured', async () => {
    const read = vi.fn(() => FALLBACK)
    await expect(awaitRequestedPlan(read, { waitMs: 0 })).resolves.toEqual(FALLBACK)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('waits for the address to appear', async () => {
    let reads = 0
    const read = () => {
      reads += 1
      return reads < 3 ? FALLBACK : plan(['100.64.0.1'])
    }
    const result = await awaitRequestedPlan(read, { waitMs: 5000, pollMs: 5 })
    expect(result.addresses).toEqual(['100.64.0.1'])
    expect(reads).toBeGreaterThanOrEqual(3)
  })

  it('gives up after the deadline and reports the fallback it settled on', async () => {
    const onGiveUp = vi.fn()
    const started = Date.now()
    const result = await awaitRequestedPlan(() => FALLBACK, { waitMs: 40, pollMs: 5, onGiveUp })
    const elapsed = Date.now() - started

    expect(result).toEqual(FALLBACK)
    expect(elapsed).toBeGreaterThanOrEqual(30)
    expect(onGiveUp).toHaveBeenCalledTimes(1)
    expect(onGiveUp.mock.calls[0]?.[0]).toEqual(FALLBACK)
  })

  it('still starts a fallback listener rather than failing outright', async () => {
    // A phone that cannot reach loopback is no worse off, and the local Web
    // panel is worth having.
    await expect(awaitRequestedPlan(() => FALLBACK, { waitMs: 20, pollMs: 5 })).resolves.toMatchObject({
      mode: 'loopback',
    })
  })

  it('stops waiting when aborted', async () => {
    const controller = new AbortController()
    const read = vi.fn(() => FALLBACK)
    const started = Date.now()
    const pending = awaitRequestedPlan(read, {
      waitMs: 60_000,
      pollMs: 5,
      signal: controller.signal,
    })
    setTimeout(() => controller.abort(), 10)
    await expect(pending).resolves.toEqual(FALLBACK)
    expect(Date.now() - started).toBeLessThan(1000)
  })
})

describe('needsRebind', () => {
  it('reports no change for an identical plan', () => {
    const current = bindKey(plan(['100.64.0.1']))
    expect(needsRebind(current, plan(['100.64.0.1']))).toBe(false)
  })

  it('reports a change when the address appears', () => {
    // The case this exists for: the network came up after DSH had started.
    const current = bindKey(FALLBACK)
    expect(needsRebind(current, plan(['100.64.0.1']))).toBe(true)
  })

  it('reports a change when the address disappears', () => {
    const current = bindKey(plan(['100.64.0.1']))
    expect(needsRebind(current, FALLBACK)).toBe(true)
  })
})
