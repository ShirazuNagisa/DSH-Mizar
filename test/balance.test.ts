import { describe, expect, it } from 'vitest'
import type { Context } from '../src/dsh.js'
import { accountBalance, isOfficialTopUpURL } from '../src/bridge/balance.js'

const link = 'https://platform.deepseek.com/top_up'
const state = { status: 'credential-stored', links: { topUpUrl: link }, attempt: { authorizeUrl: 'never-export-this' } }
const client = { version: '0.9.5', locale: 'zh-Hans', timezoneOffsetSeconds: 28800 }
const ready = { status: 'ready', value: [{ currency: 'CNY', balance: '12345678901234567890.000001' }, { currency: 'USD', balance: '0' }], bonusWallets: [{ currency: 'CNY', balance: '1e-10' }], token: 'never-export-this' }
function fixture(options: { before?: unknown; after?: unknown; balance?: unknown; missing?: boolean; error?: boolean } = {}) {
  const calls: { namespace: string; method: string; args: unknown }[] = []
  let reads = 0
  const ctx = {
    typert: { local: { list: () => options.missing ? [] : [{ endpoint: 'account/getState' }, { endpoint: 'account/getBalance' }] } },
    typertGateway: { invoke: async (request: { namespace: string; method: string; args: unknown }) => {
      calls.push(request)
      if (request.method === 'getState') return reads++ === 0 ? (options.before ?? state) : (options.after ?? state)
      if (options.error) throw new Error('secret-grant-token user@example.invalid never-export-this')
      return Object.hasOwn(options, 'balance') ? options.balance : ready
    } },
    effect: () => () => {},
  } as unknown as Context
  return { ctx, calls }
}

describe('native official DeepSeek balance boundary', () => {
  it('projects only wallets, preserving precision, exponent strings and genuine zero', async () => {
    const { ctx, calls } = fixture()
    const result = await accountBalance(ctx, { client })
    expect(result).toEqual({ status: 'ready', wallets: ready.value, bonusWallets: ready.bonusWallets, topUpURL: link })
    expect(JSON.stringify(result)).not.toContain('never-export-this')
    expect(calls.map(({ namespace, method, args }) => ({ namespace, method, args }))).toEqual([
      { namespace: 'account', method: 'getState', args: {} },
      { namespace: 'account', method: 'getBalance', args: { client } },
    ])
  })
  it('does not query accounts when endpoints are missing', async () => {
    const { ctx, calls } = fixture({ missing: true })
    expect(await accountBalance(ctx, { client })).toEqual({ status: 'unsupported' })
    expect(calls).toHaveLength(0)
  })
  it.each(['https://not-official.example/top_up', 'https://platform.deepseek.com:443/top_up', 'https://u@platform.deepseek.com/top_up', `${link}?x=1`, `${link}#x`])('rejects noncanonical official link %s', async (url) => {
    expect(isOfficialTopUpURL(url)).toBe(false)
    const { ctx, calls } = fixture({ before: { ...state, links: { topUpUrl: url } } })
    expect(await accountBalance(ctx, { client })).toEqual({ status: 'unsupported' })
    expect(calls).toHaveLength(1)
  })
  it('does not query a signed-out account', async () => {
    const { ctx, calls } = fixture({ before: { ...state, status: 'signed-out' } })
    expect(await accountBalance(ctx, { client })).toEqual({ status: 'signed-out' })
    expect(calls).toHaveLength(1)
  })
  it.each([null, { status: 'failed' }, { ...ready, value: [] }, { ...ready, value: [{ currency: 'EUR', balance: '1' }] }, { ...ready, value: [{ currency: 'CNY', balance: 'NaN' }] }])('never turns failed/invalid results into zero', async (balance) => {
    const { ctx } = fixture({ balance })
    expect(await accountBalance(ctx, { client })).toEqual({ status: 'unavailable' })
  })
  it('rechecks signed-out after a native null rather than guessing', async () => {
    const { ctx } = fixture({ balance: null, after: { ...state, status: 'signed-out' } })
    expect(await accountBalance(ctx, { client })).toEqual({ status: 'signed-out' })
  })
  it('returns native ready synchronously without a second awaited state / A→B race window', async () => {
    // The second state could describe B while the native ready snapshot belongs to A.
    // Do not await that state: it cannot prove identity and widens the stale window.
    const { ctx, calls } = fixture({ after: { ...state, status: 'signed-out' } })
    expect((await accountBalance(ctx, { client })).status).toBe('ready')
    expect(calls.filter((call) => call.method === 'getState')).toHaveLength(1)
  })
  it('sanitizes sensitive gateway failures without fabricating balances or attaching a cause', async () => {
    const { ctx } = fixture({ error: true })
    const error: unknown = await accountBalance(ctx, { client }).catch((failure: unknown) => failure)
    expect(error).toMatchObject({ code: 'REMOTE_ERROR', message: 'DeepSeek balance query failed' })
    expect((error as Error).cause).toBeUndefined()
    expect(String(error)).not.toContain('secret-grant-token')
    expect(String(error)).not.toContain('user@example.invalid')
  })
})
