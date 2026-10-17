/**
 * Render tests for the Mizar panel.
 *
 * The panel is the one part of this plugin that cannot be verified over the
 * wire — the smoke test proves the host serves the right data, but nothing there
 * proves the component renders it. Without these, a broken import or a hook used
 * outside a component would only surface in a browser console nobody is
 * watching.
 *
 * Vitest's default `node` environment has no `document`, which is exactly the
 * point: `renderToStaticMarkup` runs the first render only, so the component has
 * to survive being rendered where no DOM exists. The polling effect does not
 * run, so this is the loading state — but it is the state every operator sees
 * first, and it exercises the whole component tree.
 *
 * @module dsh-mizar/test/panel-render
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { MizarPanel, MizarPanelIcon, PANEL_ID } from '../client/src/panel.js'
import { setLocale } from '../client/src/i18n.js'
import { PANEL_ROUTES } from '../src/panel/api.js'

describe('panel routes', () => {
  it('carries the /api prefix in the path itself', () => {
    // Regression guard. The interface doc calls `path` an "absolute path below
    // /api", but the shipped registrations pass `/api/file`; omitting the prefix
    // produces a silent 404 with no registration error, which cost a full
    // debugging round.
    for (const path of Object.values(PANEL_ROUTES)) {
      expect(path.startsWith('/api/')).toBe(true)
    }
  })

  it('names a distinct route per action', () => {
    const paths = Object.values(PANEL_ROUTES)
    expect(new Set(paths).size).toBe(paths.length)
  })
})

describe('MizarPanel', () => {
  // The panel renders in whatever language the i18n module resolved at import
  // time, and node 21+ gives it a `navigator` whose language is the machine's
  // own locale -- so these assertions would be about the developer's machine
  // rather than about the panel. Pinned here; locale *detection* is
  // test/i18n.test.ts's subject, not this file's.
  beforeEach(() => {
    setLocale('en')
  })

  it('renders without a DOM', () => {
    expect(() => renderToStaticMarkup(<MizarPanel />)).not.toThrow()
  })

  it('identifies itself and shows a loading state before the first fetch resolves', () => {
    const html = renderToStaticMarkup(<MizarPanel />)
    expect(html).toContain('DSH-Mizar')
    expect(html).toContain('Loading')
    expect(html).toContain('mizar-panel')
  })

  it('does not claim the host is unreachable before anything has been asked', () => {
    // The first render happens before any request, so an error message here
    // would be a lie the operator sees on every page load.
    const html = renderToStaticMarkup(<MizarPanel />)
    expect(html).not.toContain('Cannot reach')
  })

  it('offers a language switch', () => {
    // Rendered, not merely exported: the whole point of the button is that it
    // is on screen before anything else has loaded, since a reader who cannot
    // read the panel needs it first.
    const html = renderToStaticMarkup(<MizarPanel />)
    expect(html).toContain('mizar-lang')
    // Named after the language it switches to. The panel is pinned to English
    // above, so the button offers Chinese.
    expect(html).toContain('中文')
  })
})

describe('MizarPanelIcon', () => {
  it('renders an inline svg', () => {
    const html = renderToStaticMarkup(<MizarPanelIcon />)
    expect(html).toContain('<svg')
    expect(html).toContain('aria-hidden')
  })
})

describe('panel identity', () => {
  it('uses one key for both the sidebar entry and the main panel', () => {
    // The sidebar entry selects the panel registered under the same key, so a
    // mismatch would show an icon that opens nothing.
    expect(PANEL_ID).toBe('mizar')
  })
})
