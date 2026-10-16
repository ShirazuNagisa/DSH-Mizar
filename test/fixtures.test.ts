/**
 * Golden frames, validated from the TypeScript side.
 *
 * `iOS/MizarKit/Tests/MizarKitTests/FixtureTests.swift` decodes the same files.
 * Two decoders reading one artifact is what makes the contract testable: a
 * change to what the host sends fails whichever side was not updated, and
 * neither language can drift away from the other without a red test.
 *
 * The files are captured from a live host, not written by hand:
 *
 *     MIZAR_WRITE_FIXTURES=1 scripts/dev.sh smoke
 *
 * @module dsh-mizar/test/fixtures
 */
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ERROR_CODES, PROTOCOL_VERSION } from '../src/protocol/frames.js'

const FIXTURE_DIR = fileURLToPath(new URL('../protocol/fixtures/', import.meta.url))

/** Every fixture, keyed by name. */
function loadFixtures(): Map<string, Record<string, unknown>> {
  const files = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.json'))
  return new Map(
    files.map((name) => [
      name.replace(/\.json$/, ''),
      JSON.parse(readFileSync(`${FIXTURE_DIR}${name}`, 'utf8')) as Record<string, unknown>,
    ]),
  )
}

const fixtures = loadFixtures()

/** Read one fixture, failing loudly when it is missing. */
function fixture(name: string): Record<string, unknown> {
  const value = fixtures.get(name)
  if (value === undefined) throw new Error(`fixture "${name}" is missing from ${FIXTURE_DIR}`)
  return value
}

describe('fixture set', () => {
  it('covers every frame the app decodes', () => {
    // A missing directory would make every assertion below vacuously pass.
    expect([...fixtures.keys()].sort()).toEqual(
      [
        'error-frame',
        'host-info',
        'interactions-pending',
        'model-catalog',
        'permissions-catalog',
        'session-list',
        'session-messages',
        'session-stats',
        'welcome',
      ].sort(),
    )
  })

  it('carries no credential', () => {
    // These files are committed. A device token reaching one would be a
    // credential in version control.
    for (const [name, frame] of fixtures) {
      const text = JSON.stringify(frame)
      expect(text, `${name} contains a token`).not.toMatch(/mz_[A-Z0-9]{10,}/)
      expect(text, `${name} contains a token hash`).not.toContain('tokenHash')
    }
  })
})

describe('envelopes', () => {
  it('carries the protocol version on every frame', () => {
    for (const [name, frame] of fixtures) {
      expect(frame['v'], `${name} has no protocol version`).toBe(PROTOCOL_VERSION)
      expect(typeof frame['type'], `${name} has no type`).toBe('string')
    }
  })

  it('uses a frame type the parser knows', () => {
    const known = new Set(['welcome', 'ok', 'error', 'event'])
    for (const [name, frame] of fixtures) {
      expect(known.has(frame['type'] as string), `${name} has type ${String(frame['type'])}`).toBe(true)
    }
  })

  it('reports an error code the client can branch on', () => {
    const frame = fixture('error-frame')
    expect(frame['type']).toBe('error')
    expect(ERROR_CODES).toContain(frame['code'])
    expect(typeof frame['message']).toBe('string')
  })
})

describe('welcome', () => {
  it('identifies the host and the device', () => {
    const frame = fixture('welcome')
    expect(typeof frame['hostId']).toBe('string')
    expect(typeof frame['hostName']).toBe('string')
    expect(frame['protocolVersion']).toBe(PROTOCOL_VERSION)
    expect(typeof frame['deviceId']).toBe('string')
  })
})

describe('session list', () => {
  it('returns rows carrying the fields the list renders', () => {
    const items = (fixture('session-list')['result'] as { items?: unknown[] }).items ?? []
    expect(items.length).toBeGreaterThan(0)
    for (const item of items as Record<string, unknown>[]) {
      expect(typeof item['sessionId']).toBe('string')
      expect(typeof item['updatedAt']).toBe('number')
      expect(typeof item['running']).toBe('boolean')
      expect(typeof item['blank']).toBe('boolean')
    }
  })
})

describe('session messages', () => {
  it('carries a page in the order the log had, bounded by its own cut', () => {
    // The shape that was never captured. Both languages read this frame's
    // ordering and `hasMore` semantics out of the bridge's source, which is
    // exactly how they drifted: the summary filter decides what travels, and
    // nothing said whether the surviving records keep log order. They do.
    const result = fixture('session-messages')['result'] as Record<string, unknown>
    expect(typeof result['sessionId']).toBe('string')
    expect(typeof result['asOfSeq']).toBe('number')
    expect(typeof result['hasMore']).toBe('boolean')
    const records = result['records'] as Record<string, unknown>[]
    expect(Array.isArray(records)).toBe(true)
    expect(records.length).toBeGreaterThan(0)

    let previous = -1
    for (const record of records) {
      // The envelope the app decodes: `{type: 'event', event: {type, seq, …}}`.
      expect(record['type']).toBe('event')
      const event = record['event'] as Record<string, unknown>
      expect(typeof event['type']).toBe('string')
      expect(typeof event['seq']).toBe('number')
      expect(typeof event['time']).toBe('number')
      // Oldest first, and never past the page's own cut.
      expect(event['seq'] as number).toBeGreaterThan(previous)
      expect(event['seq'] as number).toBeLessThanOrEqual(result['asOfSeq'] as number)
      previous = event['seq'] as number
    }
  })

  it('carries only the record types a conversation screen draws', () => {
    // `summaryRecords` is an allowlist, and this is the assertion that a host
    // which starts emitting something new does not silently add its weight to
    // every page: the fixture is captured, so a new event type in it fails here
    // and the new shape gets looked at.
    const result = fixture('session-messages')['result'] as Record<string, unknown>
    const kept = new Set(['turn/start', 'turn/end', 'step/start', 'user/message', 'assistant/message'])
    for (const record of result['records'] as Record<string, unknown>[]) {
      const event = record['event'] as Record<string, unknown>
      expect(kept.has(event['type'] as string), `unexpected record ${String(event['type'])}`).toBe(true)
      // DSH's own injected context is 6 KB per turn and nobody wrote it.
      const source = (event['data'] as { source?: { kind?: unknown } } | undefined)?.source
      expect(source?.kind).not.toBe('runtime-context')
      expect(source?.kind).not.toBe('skill-catalog')
    }
  })
})

describe('session stats', () => {
  it('carries the four counters the cache-hit formula needs', () => {
    const result = fixture('session-stats')['result'] as Record<string, unknown>
    const usage = (result['stats'] as Record<string, unknown>)['tokenUsage'] as Record<string, unknown>
    for (const key of [
      'uncachedInputTokens',
      'outputTokens',
      'cacheReadTokens',
      'cacheWriteTokens',
      'billedInputTokens',
    ]) {
      expect(typeof usage[key], `tokenUsage.${key}`).toBe('number')
    }
    expect(usage['billedInputTokens']).toBe(
      (usage['uncachedInputTokens'] as number) +
        (usage['cacheReadTokens'] as number) +
        (usage['cacheWriteTokens'] as number),
    )
  })
})

describe('model catalog', () => {
  it('lists providers with per-model reasoning efforts', () => {
    const result = fixture('model-catalog')['result'] as Record<string, unknown>
    const providers = result['providers'] as Record<string, unknown>[]
    expect(providers.length).toBeGreaterThan(0)
    for (const provider of providers) {
      expect(typeof provider['id']).toBe('string')
      for (const model of (provider['models'] ?? []) as Record<string, unknown>[]) {
        expect(typeof model['id']).toBe('string')
        // Empty means "no reasoning levels"; never absent, because the picker
        // branches on emptiness.
        expect(Array.isArray(model['efforts']), `efforts on ${String(model['id'])}`).toBe(true)
      }
    }
  })

  it('does not advertise a context window, which only the session knows', () => {
    // The client-facing catalog carries no contextWindow: capacity comes from
    // the per-session contextPressure projection instead. If that ever changes,
    // the app's usage screen should be revisited.
    expect(JSON.stringify(fixture('model-catalog'))).not.toContain('contextWindow')
  })
})

describe('permission catalog', () => {
  it('lists selectable presets and never offers `custom`', () => {
    const result = fixture('permissions-catalog')['result'] as Record<string, unknown>
    const options = result['options'] as Record<string, unknown>[]
    expect(options.length).toBeGreaterThan(0)
    for (const option of options) {
      expect(typeof option['value']).toBe('string')
      expect(typeof option['name']).toBe('string')
    }
    // `custom` is derived-only: it can be the current value but is never a
    // selectable row.
    expect(options.map((option) => option['value'])).not.toContain('custom')
  })
})

describe('pending interactions', () => {
  it('carries both lists, even when empty', () => {
    const result = fixture('interactions-pending')['result'] as Record<string, unknown>
    expect(Array.isArray(result['approvals'])).toBe(true)
    expect(Array.isArray(result['questions'])).toBe(true)
  })
})
