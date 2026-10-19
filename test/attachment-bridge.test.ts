import { createHash } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Context } from '../src/dsh.js'
import { AttachmentBridge } from '../src/attachments/bridge.js'
import { UploadStore } from '../src/attachments/store.js'
import { createMethodTable } from '../src/bridge/index.js'
import { InteractionBroker } from '../src/bridge/interactions.js'

let parent: string
let uploads: UploadStore
let bridge: AttachmentBridge
let ctx: Context
let calls: any[]
let fileCalls: any[]
let remote: (request: any) => Promise<unknown>
const caller = { deviceId: 'phone', deviceName: 'Phone', remote: '127.0.0.1' }
const facts = { hostId: 'host', hostName: 'Host', home: 'private', protocolVersion: 1 }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64')

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'mizar-bridge-test-'))
  uploads = await UploadStore.open({ parent })
  calls = []
  fileCalls = []
  remote = async () => ({ accepted: true })
  ctx = {
    typertGateway: { invoke: async (request: any) => { calls.push(request); return remote(request) } },
    fileUploads: { uploadStream: async (request: any) => {
      const chunks: Buffer[] = []
      for await (const chunk of request.data) chunks.push(Buffer.from(chunk))
      fileCalls.push({ sessionId: request.sessionId, name: request.name, signal: request.signal, bytes: Buffer.concat(chunks) })
      return { receiptId: `receipt-${fileCalls.length}`, file: { attachmentId: 'durable-dsh-file' } }
    } },
    effect: () => () => {},
  } as unknown as Context
  bridge = new AttachmentBridge(ctx, uploads)
})
afterEach(async () => {
  await bridge?.dispose()
  await rm(parent, { recursive: true, force: true })
})
async function ready(kind = 'file', bytes = Buffer.from('document'), sessionId = 'session', deviceId = 'phone') {
  const begin = await uploads.begin(deviceId, { sessionId, name: kind === 'image' ? 'photo.png' : 'notes.txt', kind,
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), ...(kind === 'image' ? { mediaType: 'image/png' } : {}) })
  await uploads.chunk(deviceId, { ...begin, data: bytes.toString('base64') })
  return uploads.finish(deviceId, begin)
}
function table() { return createMethodTable(ctx, facts, new InteractionBroker(), undefined, undefined, bridge) }
function prompt(ids: string[], extra: Record<string, unknown> = {}) {
  return { sessionId: 'session', requestId: 'request', text: '', attachments: ids, ...extra }
}

it('streams files through uploadStream and sends only the returned receipt to session/prompt', async () => {
  const file = await ready()
  const reply = await table()['session.prompt']!(prompt([file.attachmentId]), caller)
  expect(reply).toEqual({ accepted: true, requestId: 'request' })
  expect(fileCalls).toEqual([{ sessionId: 'session', name: 'notes.txt', signal: expect.any(AbortSignal), bytes: Buffer.from('document') }])
  expect(calls[0]).toMatchObject({ namespace: 'session', method: 'prompt', args: { request: {
    requestId: 'request', sessionId: 'session', mode: 'queue', content: [{ type: 'file', receiptId: 'receipt-1' }],
  } } })
  expect(JSON.stringify(reply)).not.toContain('receipt')
})
it('sends image bytes and display name to DSH normalization/model admission with mixed ordered parts', async () => {
  const image = await ready('image', png), file = await ready()
  await table()['session.prompt']!(prompt([image.attachmentId, file.attachmentId], { text: 'inspect', mode: 'steer', clientTimeZone: 'Asia/Shanghai' }), caller)
  expect(calls[0].args.request).toEqual({ sessionId: 'session', requestId: 'request', mode: 'steer', clientTimeZone: 'Asia/Shanghai', content: [
    { type: 'text', text: 'inspect' }, { type: 'image', mediaType: 'image/png', data: png.toString('base64'), name: 'photo.png' },
    { type: 'file', receiptId: 'receipt-1' },
  ] })
  expect(fileCalls).toHaveLength(1)
})
it('keeps the old text-only wire shape and host-minted request IDs', async () => {
  const response = await table()['session.prompt']!({ sessionId: 'session', text: 'original text' }, caller)
  expect(response).toMatchObject({ accepted: true, requestId: expect.any(String) })
  expect(calls[0].args.request).toMatchObject({ mode: 'queue', content: [{ type: 'text', text: 'original text' }] })
  expect(fileCalls).toEqual([])
})
it('does not silently drop attachments when extension is absent', async () => {
  const old = createMethodTable(ctx, facts, new InteractionBroker())
  await expect(old['attachment.capabilities']!({}, caller)).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
  await expect(old['session.prompt']!(prompt(['anything'], { text: 'hello' }), caller)).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
  expect(calls).toEqual([])
})
it('requires stable request identity and validates IDs/text/mode before any DSH side effect', async () => {
  const file = await ready()
  for (const extra of [ { requestId: undefined }, { requestId: '' }, { text: null }, { requestId: 7 } ]) {
    await expect(table()['session.prompt']!(prompt([file.attachmentId], extra), caller)).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
  }
  for (const ids of [[file.attachmentId, file.attachmentId], ['bad'], ['receipt-1'], ['C:/secret'], Array(6).fill('x'), [1], 'bad', null]) {
    await expect(table()['session.prompt']!(prompt([], { attachments: ids }), caller)).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
  }
  await expect(table()['session.prompt']!(prompt([file.attachmentId], { mode: 'anything' }), caller)).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
  await expect(table()['session.prompt']!(prompt([]), caller)).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
  expect(fileCalls).toEqual([])
  expect(calls).toEqual([])
})
it('refuses foreign session/device ownership before streaming any file', async () => {
  const foreign = await ready('file', Buffer.from('secret'), 'other-session')
  await expect(bridge.prompt('phone', prompt([foreign.attachmentId]), 'queue')).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
  const another = await ready('file', Buffer.from('secret'), 'session', 'another-phone')
  await expect(bridge.prompt('phone', prompt([another.attachmentId], { requestId: 'two' }), 'queue')).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
  expect(fileCalls).toEqual([])
})
it('coalesces simultaneous retries and returns cached acceptance after lost replies', async () => {
  const file = await ready()
  let release!: () => void
  let entered!: () => void
  const arrived = new Promise<void>((resolve) => { entered = resolve })
  remote = async () => { entered(); await new Promise<void>((resolve) => { release = resolve }); return { accepted: true } }
  const first = bridge.prompt('phone', prompt([file.attachmentId]), 'queue')
  const second = bridge.prompt('phone', prompt([file.attachmentId]), 'queue')
  await arrived
  release()
  expect(await Promise.all([first, second])).toEqual([{ accepted: true, requestId: 'request' }, { accepted: true, requestId: 'request' }])
  expect(await bridge.prompt('phone', prompt([file.attachmentId]), 'queue')).toEqual({ accepted: true, requestId: 'request' })
  expect(fileCalls).toHaveLength(1)
  expect(calls).toHaveLength(1)
})
it('retries rejected or uncertain DSH prompts with exactly the same receipt and requestId', async () => {
  const file = await ready()
  remote = async () => { throw new Error('response lost') }
  await expect(bridge.prompt('phone', prompt([file.attachmentId]), 'queue')).rejects.toThrow('response lost')
  remote = async () => ({ accepted: true })
  await bridge.prompt('phone', prompt([file.attachmentId]), 'queue')
  expect(fileCalls).toHaveLength(1)
  expect(calls).toHaveLength(2)
  expect(calls[0].args).toEqual(calls[1].args)
})
it('rejects changed text, attachments, mode, timezone, and device under one requestId', async () => {
  const file = await ready(), other = await ready()
  await bridge.prompt('phone', prompt([file.attachmentId]), 'queue')
  for (const [device, value, mode] of [
    ['phone', prompt([file.attachmentId], { text: 'changed' }), 'queue'],
    ['phone', prompt([other.attachmentId]), 'queue'],
    ['phone', prompt([file.attachmentId]), 'steer'],
    ['phone', prompt([file.attachmentId], { clientTimeZone: 'UTC' }), 'queue'],
    ['foreign', prompt([file.attachmentId]), 'queue'],
    ['phone', prompt([], { text: 'silently removed attachment' }), 'queue'],
  ] as const) {
    await expect(bridge.prompt(device, value, mode)).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
  }
  expect(calls).toHaveLength(1)
})
it('keeps verified uploads after model rejection and maps DSH attachment errors', async () => {
  const image = await ready('image', png)
  remote = async () => { throw { code: 'session/attachment-invalid', message: 'Model does not support image input' } }
  await expect(table()['session.prompt']!(prompt([image.attachmentId]), caller)).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
  remote = async () => ({ accepted: true })
  await expect(table()['session.prompt']!(prompt([image.attachmentId]), caller)).resolves.toEqual({ accepted: true, requestId: 'request' })
})
it('retains partial file admission so failed multi-file preparation does not re-upload successful files', async () => {
  const first = await ready(), second = await ready()
  const original = ctx.fileUploads.uploadStream.bind(ctx.fileUploads)
  let fail = true
  ctx.fileUploads.uploadStream = async (request) => {
    if (fileCalls.length === 1 && fail) { fail = false; throw new Error('storage unavailable') }
    return original(request)
  }
  await expect(bridge.prompt('phone', prompt([first.attachmentId, second.attachmentId]), 'queue')).rejects.toThrow('storage unavailable')
  expect(calls).toHaveLength(0)
  await bridge.prompt('phone', prompt([first.attachmentId, second.attachmentId]), 'queue')
  expect(fileCalls).toHaveLength(2)
  expect(calls[0].args.request.content).toEqual([{ type: 'file', receiptId: 'receipt-1' }, { type: 'file', receiptId: 'receipt-2' }])
})
it('refuses attached prompts when file service is unavailable but keeps old text working', async () => {
  ;(ctx as any).fileUploads = undefined
  expect(() => bridge.capabilities()).toThrow()
  await expect(bridge.begin('phone', {})).rejects.toMatchObject({ code: 'NOT_IMPLEMENTED' })
  await expect(bridge.prompt('phone', { sessionId: 'session', text: 'old client' }, 'queue')).resolves.toHaveProperty('accepted', true)
})
it('bounds concurrent admissions and leaves retry identity intact', async () => {
  const file = await ready(), other = await ready()
  let release!: () => void, entered!: () => void
  const arrived = new Promise<void>((resolve) => { entered = resolve })
  remote = async () => { entered(); await new Promise<void>((resolve) => { release = resolve }); return { accepted: true } }
  const first = bridge.prompt('phone', prompt([file.attachmentId]), 'queue')
  await arrived
  await expect(bridge.prompt('phone', prompt([other.attachmentId], { requestId: 'second' }), 'queue')).rejects.toMatchObject({ code: 'UPLOAD_LIMIT_REACHED' })
  release()
  await first
  remote = async () => ({ accepted: true })
  await expect(bridge.prompt('phone', prompt([other.attachmentId], { requestId: 'second' }), 'queue')).resolves.toHaveProperty('accepted', true)
})
it('reclaims successfully admitted staging so repeated five-file sends never fill the ten-upload device quota', async () => {
  for (let index = 0; index < 3; index++) {
    const ids: string[] = []
    for (let item = 0; item < 5; item++) ids.push((await ready()).attachmentId)
    const value = prompt(ids, { requestId: `batch-${index}` })
    await bridge.prompt('phone', value, 'queue')
    await expect(uploads.withReady('phone', 'session', ids, async () => true)).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
    await expect(bridge.prompt('phone', value, 'queue')).resolves.toEqual({ accepted: true, requestId: `batch-${index}` })
  }
  expect(fileCalls).toHaveLength(15)
  expect(calls).toHaveLength(3)
})
it('keeps more than 100 keyed text-only prompts compatible with the original client', async () => {
  for (let index = 0; index < 120; index++) {
    await expect(bridge.prompt('phone', { sessionId: 'session', text: `text ${index}`, requestId: `text-${index}` }, 'queue')).resolves.toHaveProperty('accepted', true)
  }
  expect(calls).toHaveLength(120)
  expect(fileCalls).toHaveLength(0)
})
it('preserves legacy optional empty/wrong-type requestId and timezone handling for text-only prompts', async () => {
  await bridge.prompt('phone', { sessionId: 'session', text: 'old text', requestId: '', clientTimeZone: null }, 'queue')
  expect(calls[0].args.request.requestId).toEqual(expect.any(String))
  expect(calls[0].args.request.requestId).not.toBe('')
  expect(calls[0].args.request.clientTimeZone).toBeUndefined()
})
