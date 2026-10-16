/**
 * The panel's interface language.
 *
 * The plugin has no locale of its own to ask: it is a browser module rendered
 * inside DSH's own web UI, and DSH does not hand a plugin the interface
 * language. `navigator.language` is the one thing the browser always knows, and
 * it is the same value the shell's own copy is written for, so reading it here
 * keeps the panel in step with the app around it.
 *
 * Deliberately not a framework. The panel has about thirty strings, all of them
 * in one file, and a dependency that resolves, loads and falls back is more
 * machinery than the problem has.
 *
 * @module dsh-mizar/client/i18n
 */

/** The languages the panel is written in. */
export type Locale = 'en' | 'zh-Hans'

/** Where an explicit choice is remembered. */
const STORAGE_KEY = 'dsh-mizar.locale'

/**
 * The operator's own choice, when they have made one.
 *
 * `localStorage` can throw: Safari in private mode and a sandboxed iframe both
 * refuse it, and a panel that crashes on load because it could not remember a
 * preference is worse than one that forgets it.
 *
 * @returns the stored locale, or `null`.
 */
function stored(): Locale | null {
  try {
    const value = globalThis.localStorage?.getItem(STORAGE_KEY)
    return value === 'en' || value === 'zh-Hans' ? value : null
  } catch {
    return null
  }
}

/** Remember an explicit choice, or forget it when passed `null`. */
function remember(next: Locale | null): void {
  try {
    if (next === null) globalThis.localStorage?.removeItem(STORAGE_KEY)
    else globalThis.localStorage?.setItem(STORAGE_KEY, next)
  } catch {
    // A preference nobody can store is still a preference for this session.
  }
}

/** Pick the locale from the browser, defaulting to English. */
function detect(): Locale {
  if (typeof navigator === 'undefined') return 'en'
  // `zh`, `zh-CN`, `zh-Hans-CN` and `zh-SG` are all Simplified; `zh-TW`,
  // `zh-HK` and `zh-Hant` are not, and serving them Simplified would be worse
  // than serving them English.
  const tags = [navigator.language, ...(navigator.languages ?? [])]
  for (const tag of tags) {
    const value = String(tag ?? '').toLowerCase()
    if (value.startsWith('zh')) {
      return /hant|tw|hk|mo/.test(value) ? 'en' : 'zh-Hans'
    }
  }
  return 'en'
}

/**
 * Simplified Chinese, keyed by the English string.
 *
 * Keyed by English rather than by an invented identifier on purpose: an
 * untranslated string then falls back to readable English instead of showing a
 * key, and a reader comparing the two files sees the pairing directly.
 */
const zhHans: Record<string, string> = {
  'Loading…': '加载中…',
  'Cannot reach the Mizar host: {detail}': '无法连接 Mizar 主机：{detail}',
  'Monitor and guide this DSH agent from your phone. Pair a device below, then open the DSH-Mizar app and scan the code.':
    '在手机上监控并引导这个 DSH 智能体。在下方配对一台设备，然后打开 DSH-Mizar 应用扫描二维码。',
  'Not reachable from your phone yet.': '手机暂时还连不上。',
  'Install and sign in to a relay, or bind an address the phone can reach, then restart DSH.':
    '请安装并登录一个中继，或绑定一个手机能访问的地址，然后重启 DSH。',
  Host: '主机',
  'Listening on': '监听地址',
  'not listening': '未监听',
  'Bind mode': '绑定模式',
  '(fell back to loopback)': '（已回退到本机回环）',
  'Connected clients': '在线客户端',
  Protocol: '协议',
  'Pair a device': '配对设备',
  'No pairing code is outstanding.': '当前没有有效的配对码。',
  'Generate pairing code': '生成配对码',
  'Or enter this code': '或手动输入此配对码',
  'New code': '新配对码',
  'A code works once and expires. Generating a new one invalidates this one.':
    '配对码一次性有效且会过期。生成新码会使当前这个失效。',
  'Paired devices': '已配对设备',
  'None yet.': '还没有。',
  Revoked: '已撤销',
  'Revoking a device takes effect immediately and disconnects it. The host identity is {hostId}.':
    '撤销后立即生效并断开该设备。主机身份为 {hostId}。',
  'Pairing QR code': '配对二维码',
  'just now': '刚刚',
  '{minutes}m ago': '{minutes} 分钟前',
  '{hours}h ago': '{hours} 小时前',
  '{days}d ago': '{days} 天前',
  expired: '已过期',
  '{seconds}s left': '剩余 {seconds} 秒',
  '{minutes}m left': '剩余 {minutes} 分钟',
  ' · revoked': ' · 已撤销',
  ' · last seen {when}': ' · 最后活跃 {when}',
  Revoke: '撤销',
  'Switch to {language}': '切换到{language}',
  English: '英文',
  中文: '中文',
  'request failed: {status}': '请求失败：{status}',
  'status request failed: {status}': '状态请求失败：{status}',
}

const tables: Record<Locale, Record<string, string>> = {
  en: {},
  'zh-Hans': zhHans,
}

let current: Locale = stored() ?? detect()

/** Everyone waiting to hear that the language changed. */
const listeners = new Set<() => void>()

/**
 * The language the panel is rendering in.
 * @returns the current locale.
 */
export function getLocale(): Locale {
  return current
}

/**
 * Switch languages.
 *
 * The choice is written down and kept: a toggle that resets on every reload is
 * a toggle the operator has to use every time, which is the same as not having
 * one.
 *
 * @param next - the language to render in, or `null` to go back to following
 *   the browser.
 */
export function setLocale(next: Locale | null): void {
  const resolved = next ?? detect()
  remember(next)
  if (resolved === current) return
  current = resolved
  for (const listener of listeners) listener()
}

/** Flip to the other language, which is what the panel's button does. */
export function toggleLocale(): void {
  setLocale(current === 'zh-Hans' ? 'en' : 'zh-Hans')
}

/**
 * Hear about language changes.
 *
 * Shaped for `useSyncExternalStore`, which is what the panel uses to re-render
 * on a switch.
 *
 * @param listener - called after the language changes.
 * @returns a function that stops listening.
 */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Translate one string, substituting `{name}` placeholders.
 *
 * @param key - the English string, or a template using `{name}` placeholders.
 * @param values - what to substitute.
 * @returns the translated string, or the key with substitutions when there is
 *   no translation.
 */
export function t(key: string, values: Record<string, string | number> = {}): string {
  return translate(current, key, values)
}

/**
 * Translate one string in a named locale.
 *
 * Separate from `t` so the table can be exercised without a browser: the
 * exported `t` reads whatever `navigator` said at import time, which in a test
 * runner is nothing.
 *
 * @param target - which language to render in.
 * @param key - the English string, or a template using `{name}` placeholders.
 * @param values - what to substitute.
 * @returns the translated string, falling back to the key.
 */
export function translate(
  target: Locale,
  key: string,
  values: Record<string, string | number> = {},
): string {
  const template = tables[target][key] ?? key
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = values[name]
    return value === undefined ? whole : String(value)
  })
}

/** Every English key the panel knows a Chinese rendering for. */
export function translatedKeys(): string[] {
  return Object.keys(zhHans)
}

/** The locale the panel is rendering in, for tests and diagnostics. */
export const locale: Locale = current
