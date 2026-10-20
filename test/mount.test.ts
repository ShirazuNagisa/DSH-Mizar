//
//  mount.test.ts
//  dsh-mizar
//
//  The single-instance rule, tested without a plugin host.
//
//  The failure this replaces was visible as three listeners in one process and a
//  pairing address that stopped answering; the fix is an ordering guarantee, and
//  ordering is exactly what can be tested here.
//

import { afterEach, describe, expect, it } from 'vitest'
import { MountRegistry, sharedMountRegistry, type Mounted } from '../src/mount.js'

/** A mount that records what happened to it. */
function mount(name: string, events: string[], delayMs = 0): Mounted {
  return {
    dispose: async () => {
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
      events.push(`dispose:${name}`)
    },
  }
}

describe('MountRegistry', () => {
  afterEach(() => {
    delete (globalThis as unknown as Record<symbol, unknown>)[
      Symbol.for('dsh-mizar.mount-registry')
    ]
  })

  it('hands every module copy in the process the same registry', () => {
    // A module loaded twice gets a second copy of this file but one globalThis;
    // that is the whole mechanism. Without it each copy binds its own listener
    // and the port count climbs (19390, 19391, ... 19397) on every remount.
    const first = sharedMountRegistry()
    expect(sharedMountRegistry()).toBe(first)
    expect(
      (globalThis as unknown as Record<symbol, unknown>)[
        Symbol.for('dsh-mizar.mount-registry')
      ],
    ).toBe(first)
  })

  it('disposes the previous mount before creating the next', async () => {
    const events: string[] = []
    const registry = new MountRegistry()

    await registry.start(async () => {
      events.push('create:first')
      return mount('first', events)
    })
    const second = await registry.start(async () => {
      events.push('create:second')
      return mount('second', events)
    })

    expect(events).toEqual(['create:first', 'dispose:first', 'create:second'])
    expect(registry.active).toBe(second)
  })

  it('serializes a start that arrives while a creation is still running', async () => {
    const events: string[] = []
    const registry = new MountRegistry()

    let releaseFirst: () => void = () => undefined
    const firstCreate = registry.start(async () => {
      events.push('create:first:start')
      await new Promise<void>((resolve) => {
        releaseFirst = resolve
      })
      events.push('create:first:done')
      return mount('first', events)
    })
    const secondCreate = registry.start(async () => {
      events.push('create:second')
      return mount('second', events)
    })

    // The second creation cannot have begun while the first is mid-flight.
    await Promise.resolve()
    expect(events).toEqual(['create:first:start'])

    releaseFirst()
    await firstCreate
    await secondCreate
    expect(events).toEqual([
      'create:first:start',
      'create:first:done',
      'dispose:first',
      'create:second',
    ])
  })

  it('disposes through stop, and a later stop is not a resurrection', async () => {
    const events: string[] = []
    const registry = new MountRegistry()
    const only = await registry.start(async () => mount('only', events))

    await registry.stop(only)
    expect(events).toEqual(['dispose:only'])
    expect(registry.active).toBeNull()

    // Stopping nothing, or the same object again, is not an error: an unload
    // and a competing apply can both ask.
    await registry.stop(only)
    await registry.stop(null)
    expect(events).toEqual(['dispose:only'])
  })

  it('leaves the slot empty when creation fails', async () => {
    const registry = new MountRegistry()
    await expect(
      registry.start(async () => {
        throw new Error('listener failed')
      }),
    ).rejects.toThrow('listener failed')
    expect(registry.active).toBeNull()

    // A failed mount does not poison the queue: the next one still runs.
    const events: string[] = []
    const next = await registry.start(async () => mount('next', events))
    expect(next).not.toBeNull()
    expect(registry.active).toBe(next)
  })

  it('does not dispose a mount a newer start already replaced', async () => {
    const events: string[] = []
    const registry = new MountRegistry()
    const old = await registry.start(async () => mount('old', events))
    const current = await registry.start(async () => mount('current', events))

    // Starting the second one already disposed the first; the old cleanup runs
    // afterwards in an unload race and must not shut anything down twice.
    await registry.stop(old)
    expect(registry.active).toBe(current)
    expect(events).toEqual(['dispose:old'])
  })
})
