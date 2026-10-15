/**
 * The panel's stylesheet has to survive both themes.
 *
 * It did not. The first version wrote `color: var(--dsw-color-text, #1c1c1e)`,
 * intending the fallback as a graceful default, and got black-on-black in the
 * shell's dark theme -- because an undefined `var()` fallback does not inherit,
 * it *sets* a value and overrides the colour the shell had already chosen.
 *
 * These assertions are about that failure specifically: the panel must not name
 * an absolute colour for anything that is supposed to be neutral, so there is no
 * value left that can be wrong for one of the two themes.
 *
 * @module dsh-mizar/test/panel-css
 */
import { describe, expect, it } from 'vitest'
import { PANEL_CSS } from '../client/src/styles.js'

/** The sheet with its comments removed, so prose cannot satisfy or fail an assertion. */
const DECLARATIONS = PANEL_CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** Every declaration in the sheet, as `selector { body }` chunks. */
function rules(css: string): readonly { selector: string; body: string }[] {
  const out: { selector: string; body: string }[] = []
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    out.push({ selector: (match[1] ?? '').trim(), body: match[2] ?? '' })
  }
  return out
}

describe('panel stylesheet', () => {
  it('inherits its text colour rather than naming one', () => {
    const panel = rules(PANEL_CSS).find((rule) => rule.selector === '.mizar-panel')
    expect(panel?.body).toContain('color: inherit')
    // The bug: a fallback here *overrides* the shell instead of deferring to it.
    expect(panel?.body).not.toMatch(/color:\s*var\(/)
    expect(panel?.body).not.toMatch(/color:\s*#/)
  })

  it('derives every neutral from currentColor', () => {
    // `rgba(0, 0, 0, …)` is a light-theme neutral. On a dark panel it is either
    // invisible or a black smear, and there is no way to write it that is right
    // in both.
    expect(DECLARATIONS).not.toMatch(/rgba\(0,\s*0,\s*0/)
    expect(DECLARATIONS).not.toMatch(/rgba\(255,\s*255,\s*255/)
  })

  it('uses color-mix for borders and fills', () => {
    const mixed = DECLARATIONS.match(/color-mix\(in srgb, currentColor/g) ?? []
    // Borders, fills, hover, badges, dividers -- several surfaces, not one.
    expect(mixed.length).toBeGreaterThanOrEqual(4)
  })

  it('keeps the QR colours absolute, because scanning depends on them', () => {
    const qr = rules(PANEL_CSS).find((rule) => rule.selector.includes('.mizar-qr svg'))
    expect(qr?.body).toContain('background: #fff')
  })

  it('names no colour that only works on a light background', () => {
    // #c0392b was the danger colour and vanished into a dark panel.
    expect(DECLARATIONS).not.toContain('#c0392b')
    expect(DECLARATIONS).not.toContain('#1c1c1e')
  })
})
