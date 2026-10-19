/** Exercise the actual Cordis 4 dependency resolver, not just plain context doubles. */
import { Context, Inject } from '@deepseek-ai/cordis'
import { expect, it } from 'vitest'
import { inject } from '../src/index.js'
import { optionalService } from '../src/attachments/services.js'

it('declares only actual required services and starts without optional attachment services', async () => {
  expect(Object.keys(Inject.resolve(inject)).sort()).toEqual(['sessionProjections', 'sessions', 'typert', 'typertGateway'])
  const root = new Context()
  const providers = inject.map((name) => root.provide(name, {}))
  let mounted = false
  const fiber = root.plugin({ inject, apply(ctx) {
    mounted = true
    expect(optionalService(ctx, 'fileUploads')).toBeUndefined()
    expect(optionalService(ctx, 'attachments')).toBeUndefined()
  } })
  try {
    await fiber
    expect(mounted).toBe(true)
    expect(fiber.state).toBe(2) // Cordis const enum FiberState.ACTIVE (erased at runtime)
  } finally {
    await fiber.dispose()
    for (const dispose of providers) await dispose()
    await root.fiber.dispose()
  }
})
it('reads optional services via Cordis get without a direct undeclared service access', async () => {
  const root = new Context()
  const providers = inject.map((name) => root.provide(name, {}))
  const uploadStream = async () => ({ receiptId: 'test', file: {} })
  const fileProvider = root.provide('fileUploads', { uploadStream })
  const attachmentProvider = root.provide('attachments', { imageLimits: { maxImageBytes: 1234 } })
  let mounted = false
  const fiber = root.plugin({ inject, apply(ctx) {
    mounted = true
    expect(optionalService(ctx, 'fileUploads')?.uploadStream).toBeTypeOf('function')
    expect(optionalService(ctx, 'attachments')?.imageLimits.maxImageBytes).toBe(1234)
  } })
  try {
    await fiber
    expect(mounted).toBe(true)
    expect(fiber.state).toBe(2) // Cordis const enum FiberState.ACTIVE (erased at runtime)
  } finally {
    await fiber.dispose()
    await fileProvider(); await attachmentProvider()
    for (const dispose of providers) await dispose()
    await root.fiber.dispose()
  }
})
