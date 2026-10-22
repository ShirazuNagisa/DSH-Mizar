/** Display-safe DeepSeek official wallet access. Credentials never cross Mizar. */
import type { Context } from '../dsh.js'
import { localEndpoints } from '../ready.js'
import { invokeRemote } from './invoke.js'
import { requireObject, requireString, MethodError } from './method-error.js'

const TOP_UP = 'https://platform.deepseek.com/top_up'
const DECIMAL = /^-?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:e[+-]?[0-9]+)?$(?![\s\S])/i
interface Wallet { readonly currency: 'CNY' | 'USD'; readonly balance: string }
export type BalanceResult =
  | { readonly status: 'unsupported' | 'signed-out' | 'unavailable' }
  | { readonly status: 'ready'; readonly wallets: readonly Wallet[]; readonly bonusWallets: readonly Wallet[]; readonly topUpURL: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined
}

/** A configurable Platform deployment is not necessarily the official service. */
export function isOfficialTopUpURL(value: unknown): boolean {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    // URL normalizes explicit :443 away; require the canonical authority as well.
    return /^https:\/\/platform\.deepseek\.com\//.test(value)
      && url.protocol === 'https:' && url.hostname === 'platform.deepseek.com'
      && url.port === '' && url.username === '' && url.password === ''
      && url.pathname === '/top_up' && url.search === '' && url.hash === ''
      && value === TOP_UP
  } catch { return false }
}

function wallets(value: unknown, required: boolean): Wallet[] | undefined {
  if (!Array.isArray(value) || (required && value.length === 0)) return undefined
  const result: Wallet[] = []
  for (const item of value) {
    const row = record(item)
    if (row === undefined || (row['currency'] !== 'CNY' && row['currency'] !== 'USD')
      || typeof row['balance'] !== 'string' || row['balance'].length > 256
      || !DECIMAL.test(row['balance']) || result.some((wallet) => wallet.currency === row['currency'])) return undefined
    result.push({ currency: row['currency'], balance: row['balance'] })
  }
  return result
}

/** Query only native account endpoints, never the API-key REST balance endpoint. */
export async function accountBalance(ctx: Context, payload: unknown): Promise<BalanceResult> {
  const endpoints = localEndpoints(ctx)
  if (!endpoints.has('account/getState') || !endpoints.has('account/getBalance')) return { status: 'unsupported' }
  const input = requireObject(payload, 'account.balance')
  const raw = requireObject(input['client'], 'account.balance.client')
  const version = requireString(raw, 'version', 'account.balance.client')
  const locale = requireString(raw, 'locale', 'account.balance.client')
  const offset = raw['timezoneOffsetSeconds']
  if (version.length > 100 || locale.length > 100 || typeof offset !== 'number'
    || !Number.isInteger(offset) || Math.abs(offset) > 86400) {
    throw new MethodError('MALFORMED_FRAME', 'account.balance: invalid client metadata')
  }
  // Account providers are host-only. Never forward native error messages or causes:
  // a future provider could include credentials or identity in diagnostic text.
  const invokeAccount = async (method: string, args: Record<string, unknown>): Promise<unknown> => {
    try {
      return await invokeRemote(ctx, { namespace: 'account', method, args })
    } catch {
      throw new MethodError('REMOTE_ERROR', 'DeepSeek balance query failed')
    }
  }
  const getState = async () => record(await invokeAccount('getState', {}))
  const before = await getState()
  if (!isOfficialTopUpURL(record(before?.['links'])?.['topUpUrl'])) return { status: 'unsupported' }
  if (before?.['status'] === 'signed-out') return { status: 'signed-out' }
  if (before?.['status'] !== 'credential-stored') return { status: 'unavailable' }
  const rawBalance = await invokeAccount('getBalance', {
    client: { version, locale, timezoneOffsetSeconds: offset },
  })
  // Native getBalance captures the grant's lifetime and returns null if it changes.
  // Return ready synchronously: an extra awaited getState would allow an A→B
  // switch after the native lifetime check, without proving whose ready it was.
  const balance = record(rawBalance)
  if (balance?.['status'] !== 'ready') {
    const after = await getState()
    if (!isOfficialTopUpURL(record(after?.['links'])?.['topUpUrl'])) return { status: 'unsupported' }
    return { status: after?.['status'] === 'signed-out' ? 'signed-out' : 'unavailable' }
  }
  const paid = wallets(balance['value'], true)
  const bonus = wallets(balance['bonusWallets'], false)
  if (paid === undefined || bonus === undefined) return { status: 'unavailable' }
  return { status: 'ready', wallets: paid, bonusWallets: bonus, topUpURL: TOP_UP }
}
