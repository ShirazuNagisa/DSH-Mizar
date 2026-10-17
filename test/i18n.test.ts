/**
 * The panel's interface language.
 *
 * The panel is the one screen an operator reads before anything else works, so
 * a string that renders as a raw key or as the wrong language is the first
 * impression of the plugin. These check the table rather than a rendered
 * component: `t` reads whatever `navigator` said when the module loaded, which
 * under vitest is nothing, and the interesting behaviour is the table itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getLocale,
  setLocale,
  subscribe,
  t,
  toggleLocale,
  translate,
  translatedKeys,
} from '../client/src/i18n.js'

describe('panel translation', () => {
  it('renders a known string in Simplified Chinese', () => {
    expect(translate('zh-Hans', 'Host')).toBe('主机')
    expect(translate('zh-Hans', 'Revoke')).toBe('撤销')
    expect(translate('zh-Hans', 'Paired devices')).toBe('已配对设备')
  })

  it('leaves English alone', () => {
    expect(translate('en', 'Host')).toBe('Host')
  })

  it('falls back to the English string rather than a key', () => {
    // The whole reason the table is keyed by English. A string nobody has
    // translated yet has to read as a sentence, not as an identifier.
    expect(translate('zh-Hans', 'Some string added after this table was written')).toBe(
      'Some string added after this table was written',
    )
  })

  it('substitutes every placeholder it is given', () => {
    expect(translate('zh-Hans', ' · last seen {when}', { when: '3 分钟前' })).toBe(' · 最后活跃 3 分钟前')
    expect(translate('zh-Hans', '{seconds}s left', { seconds: 42 })).toBe('剩余 42 秒')
    expect(translate('zh-Hans', '{days}d ago', { days: 2 })).toBe('2 天前')
  })

  it('leaves a placeholder alone when no value was supplied', () => {
    // Better a visible `{when}` than a sentence with a hole in it.
    expect(translate('zh-Hans', ' · last seen {when}')).toBe(' · 最后活跃 {when}')
  })

  it('has no empty translations', () => {
    for (const key of translatedKeys()) {
      expect(translate('zh-Hans', key).length, key).toBeGreaterThan(0)
    }
  })

  it('defaults to English where there is no browser', async () => {
    // Vitest runs in node, so this is also the guard that importing the module
    // outside a browser does not throw.
    //
    // Node 21+ defines a global `navigator` whose `language` is the machine's
    // own locale, so "no browser" has to be arranged rather than assumed:
    // otherwise this assertion is about whoever ran the suite, passing on an
    // English machine and failing on a Chinese one. The locale is read once at
    // import time, hence the fresh module.
    vi.stubGlobal('navigator', undefined)
    try {
      vi.resetModules()
      const fresh = await import('../client/src/i18n.js')
      expect(fresh.getLocale()).toBe('en')
      expect(fresh.t('Host')).toBe('Host')
    } finally {
      vi.unstubAllGlobals()
      vi.resetModules()
    }
  })
})

describe('language toggle', () => {
  // The module keeps the choice and the listeners, so every test has to put it
  // back or the next one starts in whatever language the last one left.
  afterEach(() => {
    setLocale('en')
  })

  it('switches both ways', () => {
    setLocale('en')
    expect(getLocale()).toBe('en')
    toggleLocale()
    expect(getLocale()).toBe('zh-Hans')
    toggleLocale()
    expect(getLocale()).toBe('en')
  })

  it('translates through the toggle, not just the table', () => {
    // `t` reads the live locale; a toggle that changed a value nobody consults
    // would render an unchanged panel.
    setLocale('zh-Hans')
    expect(t('Host')).toBe('主机')
    setLocale('en')
    expect(t('Host')).toBe('Host')
  })

  it('tells its listeners', () => {
    setLocale('en')
    const listener = vi.fn()
    const stop = subscribe(listener)
    toggleLocale()
    expect(listener).toHaveBeenCalledTimes(1)
    stop()
    toggleLocale()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stays quiet when the language did not actually change', () => {
    setLocale('en')
    const listener = vi.fn()
    const stop = subscribe(listener)
    setLocale('en')
    expect(listener).not.toHaveBeenCalled()
    stop()
  })

  it('remembers the choice', () => {
    // A toggle that resets on every page load is one the operator has to press
    // every time, which is the same as not having one.
    //
    // Stubbed rather than assumed: vitest runs in node, where there is no
    // `localStorage` -- and the module has to survive that, which is why the
    // write is wrapped. Stubbing is what lets this test tell "it stored the
    // value" apart from "it silently could not".
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    })
    try {
      setLocale('zh-Hans')
      expect(store.get('dsh-mizar.locale')).toBe('zh-Hans')
      setLocale('en')
      expect(store.get('dsh-mizar.locale')).toBe('en')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('goes back to following the browser when asked to', () => {
    // `null` clears the stored choice. There is no browser here, so following
    // it means English -- but the value is gone, which is the part that matters.
    //
    // `navigator` is stubbed away for the same reason as above: node 21+ has a
    // global one carrying the machine's locale, and `detect()` reads it live.
    const store = new Map<string, string>([['dsh-mizar.locale', 'zh-Hans']])
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    })
    vi.stubGlobal('navigator', undefined)
    try {
      setLocale(null)
      expect(store.has('dsh-mizar.locale')).toBe(false)
      expect(getLocale()).toBe('en')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('names the language it will switch to', () => {
    setLocale('en')
    expect(t('中文')).toBe('中文')
    setLocale('zh-Hans')
    expect(t('English')).toBe('英文')
    expect(t('Switch to {language}', { language: t('English') })).toBe('切换到英文')
  })
})
