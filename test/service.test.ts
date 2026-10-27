/**
 * The `service` channel.
 *
 * The allowlist is the security boundary of this channel: `ctx.get(name)` will
 * hand back anything the composition registered, including services that destroy
 * things. These tests pin the four refusals and the one success.
 *
 * @module dsh-mizar/test/service
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '../src/dsh.js'
import { callService, serviceOf } from '../src/bridge/service.js'

/** A context whose `get` answers from a fixed table. */
function contextWith(services: Record<string, unknown>): Context {
  return {
    get: (name: string) => services[name],
  } as unknown as Context
}

/** A service shaped like the workspace registry: a method that reads `this`. */
function makeRegistry(): Record<string, unknown> {
  let reads = 0
  return {
    list(): string[] {
      reads += 1
      return ['workspace-a']
    },
    get reads(): number {
      return reads
    },
    async archiveSession(id: string): Promise<{ archived: boolean; id: string }> {
      return { archived: true, id }
    },
    _secret(): string {
      return 'nope'
    },
  }
}

const registry = makeRegistry()

describe('serviceOf', () => {
  it('returns an allowed, registered service', () => {
    const ctx = contextWith({ workspaceRegistry: registry })
    expect(serviceOf(ctx, 'workspaceRegistry', ['workspaceRegistry'])).toBe(registry)
  })

  it('refuses a service that is not in the allowlist', () => {
    const ctx = contextWith({ workspaceRegistry: registry })
    expect(serviceOf(ctx, 'workspaceRegistry', ['sessions'])).toBeNull()
  })

  it('returns null when the composition has no such service', () => {
    expect(serviceOf(contextWith({}), 'workspaceRegistry', ['workspaceRegistry'])).toBeNull()
  })
})

describe('callService', () => {
  it('calls a method with the service as this', async () => {
    const ctx = contextWith({ workspaceRegistry: registry })
    await expect(callService(ctx, 'workspaceRegistry', 'list', [], ['workspaceRegistry'])).resolves.toEqual([
      'workspace-a',
    ])
  })

  it('awaits an async method', async () => {
    const ctx = contextWith({ workspaceRegistry: registry })
    await expect(
      callService(ctx, 'workspaceRegistry', 'archiveSession', ['session-1'], ['workspaceRegistry']),
    ).resolves.toEqual({ archived: true, id: 'session-1' })
  })

  it('refuses a service outside the allowlist with a code', async () => {
    const ctx = contextWith({ workspaceRegistry: registry })
    await expect(callService(ctx, 'workspaceRegistry', 'list', [], [])).rejects.toMatchObject({
      code: 'LINK_REFUSED',
    })
  })

  it('refuses a private member', async () => {
    const ctx = contextWith({ workspaceRegistry: registry })
    await expect(
      callService(ctx, 'workspaceRegistry', '_secret', [], ['workspaceRegistry']),
    ).rejects.toThrow(/private/)
  })

  it('refuses a name that is not a function', async () => {
    const ctx = contextWith({ workspaceRegistry: registry })
    await expect(
      callService(ctx, 'workspaceRegistry', 'reads', [], ['workspaceRegistry']),
    ).rejects.toThrow(/no method/)
  })

  it('says which of the two reasons it refused', async () => {
    const ctx = contextWith({ workspaceRegistry: registry })
    await expect(callService(ctx, 'other', 'list', [], [])).rejects.toThrow(/not in the configured allowlist/)
    await expect(callService(ctx, 'sessions', 'list', [], ['sessions'])).rejects.toThrow(/not composed/)
  })
})
