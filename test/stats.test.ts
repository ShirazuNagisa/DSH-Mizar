/**
 * Tests for the usage bridge.
 *
 * These figures are what an operator uses to decide whether a run is wasteful,
 * so the cases below concentrate on the two ways they can lie: reporting `0` for
 * a capability that is simply absent, and rounding a cache hit up to a flat
 * `100%`.
 *
 * @module dsh-mizar/test/stats
 */
import { describe, expect, it } from 'vitest'
import {
  buildCacheHit,
  buildContextPressure,
  buildModelSelection,
  buildSessionStatsView,
  buildStatsFrame,
  buildTokenUsage,
  formatCacheHitPercent,
  STATS_KEYS,
} from '../src/bridge/stats.js'

describe('formatCacheHitPercent', () => {
  it('reports nothing when no input was billed', () => {
    expect(formatCacheHitPercent(0, 0)).toBeNull()
    expect(formatCacheHitPercent(5, 0)).toBeNull()
  })

  it('reports zero when nothing came from cache', () => {
    expect(formatCacheHitPercent(0, 1000)).toBe('0')
  })

  it('reports a full hit as 100', () => {
    expect(formatCacheHitPercent(1000, 1000)).toBe('100')
  })

  it('resists a cache read larger than the billed total', () => {
    // Defensive: a projection that has not settled yet must not produce >100.
    expect(formatCacheHitPercent(1200, 1000)).toBe('100')
  })

  it('rounds ordinary partial hits to whole percent', () => {
    expect(formatCacheHitPercent(500, 1000)).toBe('50')
    expect(formatCacheHitPercent(1, 3)).toBe('33')
    expect(formatCacheHitPercent(2, 3)).toBe('67')
  })

  it('never rounds a partial hit up to a flat 100', () => {
    // 999/1000 is 99.9%, which rounds to 100 at whole-percent precision.
    expect(formatCacheHitPercent(999, 1000)).toBe('99.9')
    expect(formatCacheHitPercent(9999, 10_000)).toBe('99.99')
    expect(formatCacheHitPercent(99_999, 100_000)).toBe('99.999')
  })

  it('stays below 100 even when rounding would not reveal it', () => {
    // 999999/1000000 is 99.9999%, which still reads as 100 at four decimals.
    const text = formatCacheHitPercent(999_999, 1_000_000)
    expect(text).not.toBeNull()
    expect(Number(text)).toBeLessThan(100)
  })

  it('always produces a value below 100 for any genuine partial hit', () => {
    for (let total = 2; total <= 500; total += 1) {
      const read = total - 1
      const text = formatCacheHitPercent(read, total)
      expect(text).not.toBeNull()
      expect(Number(text)).toBeLessThan(100)
    }
  })
})

describe('buildTokenUsage', () => {
  it('returns null when the projection is absent', () => {
    // Absent means the token-meter is not composed — not that usage is zero.
    expect(buildTokenUsage(undefined)).toBeNull()
  })

  it('returns null when the required fields are missing', () => {
    expect(buildTokenUsage({})).toBeNull()
    expect(buildTokenUsage({ uncachedInputTokens: 10 })).toBeNull()
  })

  it('rejects non-finite numbers', () => {
    expect(buildTokenUsage({ uncachedInputTokens: Number.NaN, outputTokens: 1 })).toBeNull()
    expect(buildTokenUsage({ uncachedInputTokens: Infinity, outputTokens: 1 })).toBeNull()
    expect(buildTokenUsage({ uncachedInputTokens: '10', outputTokens: 1 })).toBeNull()
  })

  it('defaults the optional cache fields to zero', () => {
    const usage = buildTokenUsage({ uncachedInputTokens: 100, outputTokens: 20 })
    expect(usage).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0, billedInputTokens: 100 })
  })

  it('sums billed input across uncached, cache read and cache write', () => {
    const usage = buildTokenUsage({
      uncachedInputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 800,
      cacheWriteTokens: 100,
    })
    expect(usage?.billedInputTokens).toBe(1000)
  })

  it('reads a real empty-session snapshot', () => {
    // The shape a freshly created, never-prompted session reports.
    const usage = buildTokenUsage({
      uncachedInputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    })
    expect(usage?.billedInputTokens).toBe(0)
    expect(buildCacheHit(usage)?.ratio).toBeNull()
    expect(buildCacheHit(usage)?.displayPercent).toBeNull()
  })
})

describe('buildCacheHit', () => {
  it('returns null without a usage view', () => {
    expect(buildCacheHit(null)).toBeNull()
  })

  it('computes the ratio over billed input, not raw input', () => {
    const usage = buildTokenUsage({
      uncachedInputTokens: 200,
      outputTokens: 0,
      cacheReadTokens: 800,
    })
    expect(buildCacheHit(usage)?.ratio).toBeCloseTo(0.8)
    expect(buildCacheHit(usage)?.displayPercent).toBe('80')
  })
})

describe('buildContextPressure', () => {
  it('returns null when the projection is absent', () => {
    expect(buildContextPressure(undefined, undefined)).toBeNull()
  })

  it('prefers projectedTokens over pressureTokens', () => {
    // projectedTokens is what the next request would cost, which is the figure
    // a streaming UI wants; pressureTokens holds still during a turn.
    const view = buildContextPressure(
      { contextWindow: 1000, pressureTokens: 100, projectedTokens: 250 },
      undefined,
    )
    expect(view?.percent).toBe(25)
    expect(view?.pressureTokens).toBe(100)
    expect(view?.projectedTokens).toBe(250)
  })

  it('falls back to pressureTokens without a projection', () => {
    expect(buildContextPressure({ contextWindow: 1000, pressureTokens: 400 }, undefined)?.percent).toBe(40)
  })

  it('clamps an overfull context to 100', () => {
    expect(buildContextPressure({ contextWindow: 100, pressureTokens: 250 }, undefined)?.percent).toBe(100)
  })

  it('gives no percentage without a window', () => {
    expect(buildContextPressure({ pressureTokens: 400 }, undefined)?.percent).toBeNull()
  })

  it('gives no percentage without a pressure sample', () => {
    expect(buildContextPressure({ contextWindow: 1000 }, undefined)?.percent).toBeNull()
  })

  it('treats a zero window as unusable rather than dividing by it', () => {
    const view = buildContextPressure({ contextWindow: 0, pressureTokens: 10 }, undefined)
    expect(view?.percent).toBeNull()
  })

  it('reports the breakdown when present and null when absent', () => {
    const withBreakdown = buildContextPressure(
      { contextWindow: 100 },
      { systemTokens: 10, toolsTokens: 20, messageTokens: 30 },
    )
    expect(withBreakdown?.breakdown).toEqual({ systemTokens: 10, toolsTokens: 20, messageTokens: 30 })
    expect(buildContextPressure({ contextWindow: 100 }, undefined)?.breakdown).toBeNull()
  })

  it('defaults missing breakdown fields to zero', () => {
    expect(buildContextPressure({ contextWindow: 100 }, { systemTokens: 5 })?.breakdown).toEqual({
      systemTokens: 5,
      toolsTokens: 0,
      messageTokens: 0,
    })
  })
})

describe('buildSessionStatsView', () => {
  it('returns null when the projection is absent', () => {
    expect(buildSessionStatsView(undefined)).toBeNull()
  })

  it('returns null without the required counters', () => {
    expect(buildSessionStatsView({ turns: 1 })).toBeNull()
    expect(buildSessionStatsView({})).toBeNull()
  })

  it('averages time to first token over the steps that reported one', () => {
    const view = buildSessionStatsView({ turns: 2, steps: 4, ttftMs: 1200, ttftSteps: 4 })
    expect(view?.ttftMs).toBe(300)
  })

  it('gives no ttft without a step count', () => {
    expect(buildSessionStatsView({ turns: 1, steps: 1, ttftMs: 500 })?.ttftMs).toBeNull()
    expect(buildSessionStatsView({ turns: 1, steps: 1, ttftMs: 500, ttftSteps: 0 })?.ttftMs).toBeNull()
  })

  it('derives decode throughput from tokens over decode time', () => {
    const view = buildSessionStatsView({ turns: 1, steps: 1, decodeMs: 2000, decodeTokens: 100 })
    expect(view?.decodeTokensPerSecond).toBe(50)
  })

  it('gives no throughput without decode time', () => {
    expect(buildSessionStatsView({ turns: 1, steps: 1, decodeTokens: 100 })?.decodeTokensPerSecond).toBeNull()
    expect(
      buildSessionStatsView({ turns: 1, steps: 1, decodeMs: 0, decodeTokens: 100 })?.decodeTokensPerSecond,
    ).toBeNull()
  })

  it('defaults the millisecond counters to zero', () => {
    const view = buildSessionStatsView({ turns: 3, steps: 6 })
    expect(view).toMatchObject({ turns: 3, steps: 6, llmMs: 0, toolMs: 0 })
  })
})

describe('buildModelSelection', () => {
  it('returns null when absent', () => {
    expect(buildModelSelection(undefined)).toBeNull()
    expect(buildModelSelection(null)).toBeNull()
  })

  it('reads the last used route and the pending one', () => {
    const view = buildModelSelection({
      lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'max' },
      next: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    })
    expect(view?.lastUsed).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'max',
    })
    expect(view?.next).toEqual({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
  })

  it('treats an unselected route as null', () => {
    const view = buildModelSelection({ lastUsed: null, next: null })
    expect(view).toEqual({ lastUsed: null, next: null })
  })

  it('rejects a route missing its provider or model', () => {
    expect(buildModelSelection({ lastUsed: { provider: 'x' } })?.lastUsed).toBeNull()
  })
})

describe('buildStatsFrame', () => {
  it('reports every field as null when nothing is composed', () => {
    // The rule that matters: an absent capability must never render as zero.
    expect(buildStatsFrame({})).toEqual({
      tokenUsage: null,
      cacheHit: null,
      context: null,
      stats: null,
      model: null,
      permissionPreset: null,
      title: null,
    })
  })

  it('assembles a full frame from real projection shapes', () => {
    const frame = buildStatsFrame({
      tokenUsage: {
        uncachedInputTokens: 1200,
        outputTokens: 340,
        cacheReadTokens: 8000,
        cacheWriteTokens: 800,
      },
      contextPressure: { contextWindow: 1_000_000, pressureTokens: 9000, projectedTokens: 10_000 },
      contextBreakdown: { systemTokens: 4000, toolsTokens: 3000, messageTokens: 3000 },
      sessionStats: { turns: 4, steps: 9, llmMs: 12_000, toolMs: 3000, ttftMs: 2000, ttftSteps: 4 },
      modelSelection: { lastUsed: { provider: 'deepseek-official', model: 'deepseek-flash' }, next: null },
      permissions: { currentValue: 'workspace-write' },
      title: 'Add the usage panel',
    })

    expect(frame.tokenUsage?.billedInputTokens).toBe(10_000)
    expect(frame.cacheHit?.displayPercent).toBe('80')
    expect(frame.context?.percent).toBe(1)
    expect(frame.context?.breakdown?.systemTokens).toBe(4000)
    expect(frame.stats?.ttftMs).toBe(500)
    expect(frame.model?.lastUsed?.model).toBe('deepseek-flash')
    expect(frame.permissionPreset).toBe('workspace-write')
    expect(frame.title).toBe('Add the usage panel')
  })

  it('treats a null title as absent rather than the string "null"', () => {
    expect(buildStatsFrame({ title: null }).title).toBeNull()
    expect(buildStatsFrame({ title: 42 }).title).toBeNull()
  })

  it('reads a malformed permissions value as absent', () => {
    expect(buildStatsFrame({ permissions: {} }).permissionPreset).toBeNull()
    expect(buildStatsFrame({ permissions: 'workspace-write' }).permissionPreset).toBeNull()
  })

  it('requests exactly the keys the frame needs', () => {
    expect([...STATS_KEYS].sort()).toEqual(
      [
        'contextBreakdown',
        'contextPressure',
        'modelSelection',
        'permissions',
        'sessionStats',
        'title',
        'tokenUsage',
      ].sort(),
    )
  })
})
