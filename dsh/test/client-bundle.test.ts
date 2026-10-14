/**
 * Conformance test for the hand-rolled client bundle envelope.
 *
 * `client/build.mjs` reproduces a build contract DSH does not publish a
 * toolchain for, so the artifact is exactly the kind of thing that breaks
 * silently: the shell would report the failure in a browser console nobody is
 * watching. This test materializes the built bundle the way the shell's module
 * loader does and asserts the three properties that actually matter:
 *
 *   1. the envelope registers the package id the boot graph addresses;
 *   2. the factory body requires **only** baseline modules — anything else
 *      would need a `dsh.client.external` declaration or a second implementation
 *      of React in the page;
 *   3. `apply` registers the panel and its sidebar entry into declared slots.
 *
 * @module dsh-mizar/test/client-bundle
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import * as React from 'react'
import * as ReactJSXRuntime from 'react/jsx-runtime'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(here, '..')
const bundlePath = resolve(packageRoot, 'lib/client.js')
const manifest = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8')) as {
  name: string
}

/** The nine modules the shell's frozen platform table owns. */
const BASELINE_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** A `<style>` element stub, enough for `installStyles`. */
function stubStyleElement() {
  const attributes = new Map<string, string>()
  return {
    textContent: '',
    setAttribute: (name: string, value: string) => {
      attributes.set(name, value)
    },
    getAttribute: (name: string) => attributes.get(name) ?? null,
  }
}

/**
 * Load the built bundle into a sandbox and hand back what the loader would see.
 * @returns the registration the envelope made and the required specifiers.
 */
function materialize() {
  const registered: { id?: string; factory?: (require: (spec: string) => unknown) => unknown } = {}
  const required = new Set<string>()
  const styles: ReturnType<typeof stubStyleElement>[] = []

  const documentStub = {
    querySelector: () => null,
    createElement: () => {
      const element = stubStyleElement()
      styles.push(element)
      return element
    },
    head: { append: () => {} },
  }

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (registration: typeof registered) => {
          registered.id = registration.id
          registered.factory = registration.factory
        },
      },
    },
    document: documentStub,
    console,
  }

  runInContext(readFileSync(bundlePath, 'utf8'), createContext(sandbox))

  const requireStub = (specifier: string) => {
    required.add(specifier)
    if (specifier === 'react') return React
    if (specifier === 'react/jsx-runtime') return ReactJSXRuntime
    throw new Error(`client bundle required a non-baseline module: ${specifier}`)
  }

  const exports = registered.factory?.(requireStub) as
    | { apply?: unknown; inject?: unknown }
    | undefined

  return { registered, required, exports, styles }
}

describe('client bundle envelope', () => {
  it('registers the package id the boot graph addresses', () => {
    const { registered } = materialize()
    expect(registered.id).toBe(manifest.name)
    expect(typeof registered.factory).toBe('function')
  })

  it('requires only baseline modules', () => {
    const { required } = materialize()
    expect(required.size).toBeGreaterThan(0)
    for (const specifier of required) {
      expect(
        BASELINE_MODULES.has(specifier),
        `${specifier} is not in the shell baseline table; it needs a dsh.client.external entry`,
      ).toBe(true)
    }
  })

  it('exports apply and inject for the client Cordis loader', () => {
    const { exports } = materialize()
    expect(typeof exports?.apply).toBe('function')
    expect(exports?.inject).toEqual(['slots'])
  })

  it('injects the panel stylesheet once, under the plugin css marker', () => {
    const { styles } = materialize()
    expect(styles).toHaveLength(1)
    expect(styles[0]?.getAttribute('data-plugin-css')).toBe('mizar')
    expect(styles[0]?.textContent).toContain('.mizar-panel')
  })

  it('registers the panel and its sidebar entry into the declared slots', () => {
    const { exports } = materialize()
    const contributions = new Map<string, Array<Record<string, unknown>>>()

    const ctx = {
      slots: {
        inject(owner: string, contribute: () => unknown) {
          expect(typeof contribute).toBe('function')
          contribute()
          expect(owner).toMatch(/^(main|sidebar\.panellist)$/)
        },
        register(options: Record<string, unknown>) {
          const name = options['name'] as string
          const list = contributions.get(name) ?? []
          list.push(options)
          contributions.set(name, list)
          return { dispose: () => {} }
        },
      },
    }

    ;(exports?.apply as (ctx: unknown) => void)(ctx)

    expect(contributions.get('main')).toEqual([{ name: 'main', key: 'mizar' }])
    expect(contributions.get('sidebar.panellist')).toEqual([
      expect.objectContaining({ name: 'sidebar.panellist', id: 'mizar' }),
    ])
  })
})
