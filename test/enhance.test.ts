/**
 * The `mizarEnhance` service.
 *
 * One model call, no session, and one failure code. The fake `llm` here is a
 * bare async iterable: that is the entire interface `rewriteWithLlm` depends on,
 * which is what keeps this testable without a composed DSH profile.
 *
 * @module dsh-mizar/test/enhance
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_TOKENS,
  MAX_MAX_TOKENS,
  MIN_MAX_TOKENS,
  clampMaxTokens,
  createEnhanceService,
  rewriteWithLlm,
  type EnhanceChunk,
  type EnhanceLlm,
  type EnhanceStreamOptions,
} from '../src/bridge/enhance.js'
import type { LinkError } from '../src/bridge/errors.js'

/** A model that yields the given chunks and records the request it was sent. */
function fakeLlm(chunks: readonly EnhanceChunk[]): EnhanceLlm & {
  readonly calls: EnhanceStreamOptions[]
} {
  const calls: EnhanceStreamOptions[] = []
  return {
    calls,
    async *stream(options: EnhanceStreamOptions): AsyncIterable<EnhanceChunk> {
      calls.push(options)
      for (const chunk of chunks) yield chunk
    },
  }
}

/** The chunks of one successful answer, in the 0.2.1-rc.2 nested shape. */
function answer(text: string): EnhanceChunk[] {
  return [
    { type: 'block-start' },
    { type: 'text-delta', text },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** The failure a rewrite throws; a resolved promise fails the test. */
async function failureOf(promise: Promise<unknown>): Promise<LinkError> {
  try {
    await promise
  } catch (error) {
    return error as LinkError
  }
  throw new Error('expected the rewrite to fail, but it resolved')
}

const args = { provider: 'test-provider', model: 'test-model', user: 'make it shorter' }

describe('rewriteWithLlm', () => {
  it('collects text deltas and trims the result', async () => {
    const llm = fakeLlm([
      { type: 'text-delta', text: '  Rewritten' },
      { type: 'text-delta', text: ' draft.  \n' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await expect(rewriteWithLlm(llm, args)).resolves.toBe('Rewritten draft.')
  })

  it('sends one request-only user message and the system prompt', async () => {
    const llm = fakeLlm(answer('ok'))
    await rewriteWithLlm(llm, { ...args, system: 'You are an editor.' })
    expect(llm.calls[0]).toMatchObject({
      provider: 'test-provider',
      model: 'test-model',
      system: 'You are an editor.',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'make it shorter' }] }],
    })
  })

  it('omits system and signal when the caller has neither', async () => {
    const llm = fakeLlm(answer('ok'))
    await rewriteWithLlm(llm, args)
    expect(llm.calls[0]).not.toHaveProperty('system')
    expect(llm.calls[0]).not.toHaveProperty('signal')
  })

  it('passes the caller signal through', async () => {
    const llm = fakeLlm(answer('ok'))
    const controller = new AbortController()
    await rewriteWithLlm(llm, { ...args, signal: controller.signal })
    expect(llm.calls[0]?.signal).toBe(controller.signal)
  })

  it('defaults maxTokens when the caller sent none', async () => {
    const llm = fakeLlm(answer('ok'))
    await rewriteWithLlm(llm, args)
    expect(llm.calls[0]?.maxTokens).toBe(DEFAULT_MAX_TOKENS)
  })

  it('clamps maxTokens into range', async () => {
    const tiny = fakeLlm(answer('ok'))
    await rewriteWithLlm(tiny, { ...args, maxTokens: 1 })
    expect(tiny.calls[0]?.maxTokens).toBe(MIN_MAX_TOKENS)

    const huge = fakeLlm(answer('ok'))
    await rewriteWithLlm(huge, { ...args, maxTokens: 99_999 })
    expect(huge.calls[0]?.maxTokens).toBe(MAX_MAX_TOKENS)

    const inRange = fakeLlm(answer('ok'))
    await rewriteWithLlm(inRange, { ...args, maxTokens: 500 })
    expect(inRange.calls[0]?.maxTokens).toBe(500)
  })

  it('throws ENHANCE_FAILED on an error finish, naming the failure code', async () => {
    const llm = fakeLlm([
      { type: 'text-delta', text: 'half a thought' },
      {
        type: 'finish',
        reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'no adapter' } },
      },
    ])
    const failure = await failureOf(rewriteWithLlm(llm, args))
    expect(failure.code).toBe('ENHANCE_FAILED')
    expect(failure.message).toMatch(/NO_ADAPTER/)
  })

  it('throws ENHANCE_FAILED on an aborted finish', async () => {
    const llm = fakeLlm([{ type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED' } } }])
    const failure = await failureOf(rewriteWithLlm(llm, args))
    expect(failure.code).toBe('ENHANCE_FAILED')
    expect(failure.message).toMatch(/aborted/)
  })

  it('treats a non-stop finish as a failure, not a truncated answer', async () => {
    const llm = fakeLlm([
      { type: 'text-delta', text: 'cut off' },
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ])
    await expect(rewriteWithLlm(llm, args)).rejects.toMatchObject({ code: 'ENHANCE_FAILED' })
  })

  it('throws ENHANCE_FAILED when the model returns only whitespace', async () => {
    const llm = fakeLlm([{ type: 'text-delta', text: '   \n' }, { type: 'finish', reason: { kind: 'stop' } }])
    const failure = await failureOf(rewriteWithLlm(llm, args))
    expect(failure.code).toBe('ENHANCE_FAILED')
    expect(failure.message).toMatch(/no text/)
  })

  it('ignores reasoning deltas', async () => {
    const llm = fakeLlm([
      { type: 'reasoning-delta', text: 'thinking about it' },
      { type: 'text-delta', text: 'the answer' },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    await expect(rewriteWithLlm(llm, args)).resolves.toBe('the answer')
  })

  it('reads a flat finish reason too', async () => {
    const llm = fakeLlm([{ type: 'finish', kind: 'error', failure: { code: 'AUTH' } }])
    const failure = await failureOf(rewriteWithLlm(llm, args))
    expect(failure.code).toBe('ENHANCE_FAILED')
    expect(failure.message).toMatch(/AUTH/)
  })
})

describe('clampMaxTokens', () => {
  it('keeps a value already in range', () => {
    expect(clampMaxTokens(500)).toBe(500)
  })

  it('defaults when the caller sent nothing or something unreadable', () => {
    expect(clampMaxTokens(undefined)).toBe(DEFAULT_MAX_TOKENS)
    expect(clampMaxTokens(Number.NaN)).toBe(DEFAULT_MAX_TOKENS)
  })

  it('rounds down to whole tokens', () => {
    expect(clampMaxTokens(500.9)).toBe(500)
  })
})

describe('createEnhanceService', () => {
  it('answers with a JSON string', async () => {
    const service = createEnhanceService(() => fakeLlm(answer('  shorter  ')))
    await expect(service.rewrite('p', 'm', null, 'make it shorter')).resolves.toBe(
      JSON.stringify({ text: 'shorter' }),
    )
  })

  it('omits an empty system prompt and forwards an explicit cap', async () => {
    const llm = fakeLlm(answer('ok'))
    const service = createEnhanceService(() => llm)
    await service.rewrite('p', 'm', '', 'draft', 200)
    expect(llm.calls[0]).not.toHaveProperty('system')
    expect(llm.calls[0]?.maxTokens).toBe(200)
  })

  it('fails with ENHANCE_FAILED when the profile has no model service', async () => {
    const service = createEnhanceService(() => null)
    const failure = await failureOf(service.rewrite('p', 'm', null, 'draft'))
    expect(failure.code).toBe('ENHANCE_FAILED')
    expect(failure.message).toMatch(/no model service/)
  })

  it('refuses a call without a provider or model', async () => {
    const service = createEnhanceService(() => fakeLlm(answer('ok')))
    // The session id is transport metadata for routes that route by Session
    // (OpenCode needs `x-opencode-session`); it must reach the model call.
    const withSession = fakeLlm(answer('done'))
    const sessionService = createEnhanceService(() => withSession)
    await sessionService.rewrite('p', 'm', 'system', 'draft', 100, 'session-1')
    expect(withSession.calls[0]?.sessionId).toBe('session-1')
    await sessionService.rewrite('p', 'm', 'system', 'draft', 100, null)
    expect(withSession.calls[1]?.sessionId).toBeUndefined()

    await expect(service.rewrite('', 'm', null, 'draft')).rejects.toMatchObject({ code: 'LINK_REFUSED' })
    await expect(service.rewrite('p', '', null, 'draft')).rejects.toMatchObject({ code: 'LINK_REFUSED' })
  })
})
