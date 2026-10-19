import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { displayName, UploadStore, type UploadStoreOptions } from '../src/attachments/store.js'

let parent: string
let store: UploadStore
const device = 'device-a'
const sessionId = 'session-a'
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=', 'base64')

beforeEach(async () => {
  parent = await mkdtemp(join(tmpdir(), 'mizar-upload-test-'))
  store = await UploadStore.open({ parent })
})
afterEach(async () => {
  await store?.dispose()
  await rm(parent, { recursive: true, force: true })
})
async function replace(options: UploadStoreOptions) {
  await store.dispose()
  store = await UploadStore.open({ parent, ...options })
}
function metadata(bytes = Buffer.from('hello'), extra: Record<string, unknown> = {}) {
  return { sessionId, name: 'notes.txt', bytes: bytes.length, sha256: hash(bytes), kind: 'file', ...extra }
}
async function upload(bytes = Buffer.from('hello'), extra: Record<string, unknown> = {}) {
  const begun = await store.begin(device, metadata(bytes, extra))
  for (let offset = 0; offset < bytes.length; offset += begun.chunkBytes) {
    await store.chunk(device, { uploadId: begun.uploadId, offset, data: bytes.subarray(offset, offset + begun.chunkBytes).toString('base64') })
  }
  return { ...begun, ready: await store.finish(device, begun) }
}

it('advertises bounded v1 limits and uses 64KiB chunks', () => {
  expect(store.capabilities).toEqual({ version: 1, maxFileBytes: 20971520, maxImageBytes: 20971520, maxAttachments: 5,
    chunkBytes: 65536, expiresSeconds: 1800, imageMediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] })
})
it('lowers image limit when DSH advertises a smaller bound', async () => {
  await replace({ maxImageBytes: 32 })
  expect(store.capabilities.maxImageBytes).toBe(32)
  await expect(store.begin(device, metadata(png, { kind: 'image', mediaType: 'image/png' }))).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE' })
})
it('stages private server-named files and streams their exact bytes', async () => {
  const bytes = Buffer.alloc(65536 * 2 + 9, 42)
  const result = await upload(bytes)
  const [root] = await readdir(parent)
  const [filename] = await readdir(join(parent, root!))
  expect(filename).not.toBe('notes.txt')
  expect(filename).not.toBe(result.uploadId)
  expect(await readFile(join(parent, root!, filename!))).toEqual(bytes)
  if (process.platform !== 'win32') {
    expect((await stat(join(parent, root!))).mode & 0o777).toBe(0o700)
    expect((await stat(join(parent, root!, filename!))).mode & 0o777).toBe(0o600)
  }
  const seen = await store.withReady(device, sessionId, [result.ready.attachmentId], async ([item]) => {
    const chunks: Buffer[] = []
    for await (const chunk of item!.stream()) { expect(chunk.byteLength).toBeLessThanOrEqual(65536); chunks.push(Buffer.from(chunk)) }
    return Buffer.concat(chunks)
  })
  expect(seen).toEqual(bytes)
  expect(JSON.stringify(result)).not.toContain(parent)
})
it.each(['../file', '..\\file', 'C:\\secret', '/etc/passwd', 'x:y', '\u0000bad', 'a\nb', '.', '..', 'CON', 'nul.txt', 'foo.', 'foo ', '\u202esecret', 'x'.repeat(241), ''])('rejects unsafe display name %j', (name) => {
  expect(() => displayName(name)).toThrow()
})
it.each([
  { bytes: 0 }, { bytes: -1 }, { bytes: 1.5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 }, { bytes: '5' },
  { sha256: 'A'.repeat(64) }, { sha256: '../x' }, { kind: 'script' }, { sessionId: '' }, { sessionId: null },
])('rejects malformed begin metadata %j', async (extra) => {
  await expect(store.begin(device, metadata(undefined, extra))).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
  expect(await readdir(parent)).toHaveLength(1)
})
it('rejects SVG, fake MIME, file MIME and oversized reservations', async () => {
  await expect(store.begin(device, metadata(png, { kind: 'image', mediaType: 'image/svg+xml' }))).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
  await expect(store.begin(device, metadata(png, { kind: 'image' }))).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
  await expect(store.begin(device, metadata(undefined, { mediaType: 'text/plain' }))).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
  await expect(store.begin(device, metadata(undefined, { bytes: 20971521 }))).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE' })
})
it.each(['aA', 'aA=','aA===', 'a A==', 'aA==\n', 'a_==', 'a-==', 'aB==', '', '===='])('rejects noncanonical base64 %j', async (data) => {
  const begun = await store.begin(device, metadata())
  await expect(store.chunk(device, { ...begun, offset: 0, data })).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
})
it('bounds chunk size before decoding and enforces actual reserved bytes', async () => {
  const begun = await store.begin(device, metadata())
  await expect(store.chunk(device, { ...begun, offset: 0, data: Buffer.alloc(65537).toString('base64') })).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
  await expect(store.chunk(device, { ...begun, offset: 0, data: Buffer.from('too-long').toString('base64') })).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE' })
})
it('permits only exact most-recent chunk retries, including concurrent retries', async () => {
  const begun = await store.begin(device, metadata(Buffer.from('abcdef')))
  const first = { ...begun, offset: 0, data: Buffer.from('abc').toString('base64') }
  expect(await Promise.all([store.chunk(device, first), store.chunk(device, first)])).toEqual([{ offset: 3 }, { offset: 3 }])
  await expect(store.chunk(device, { ...first, data: Buffer.from('xyz').toString('base64') })).rejects.toMatchObject({ code: 'UPLOAD_OFFSET_MISMATCH' })
  await expect(store.chunk(device, { ...first, offset: 4 })).rejects.toMatchObject({ code: 'UPLOAD_OFFSET_MISMATCH' })
  expect(await store.chunk(device, { ...first, offset: 3, data: Buffer.from('def').toString('base64') })).toEqual({ offset: 6 })
  await expect(store.chunk(device, first)).rejects.toMatchObject({ code: 'UPLOAD_OFFSET_MISMATCH' })
})
it('finish is retryable while incomplete, then immutable and idempotent', async () => {
  const begun = await store.begin(device, metadata())
  await expect(store.finish(device, begun)).rejects.toMatchObject({ code: 'UPLOAD_INTEGRITY' })
  await store.chunk(device, { ...begun, data: Buffer.from('hello').toString('base64') })
  const [a, b] = await Promise.all([store.finish(device, begun), store.finish(device, begun)])
  expect(a).toEqual(b)
  expect(a).toEqual({ attachmentId: expect.any(String), name: 'notes.txt', bytes: 5, kind: 'file' })
  ;(a as { name: string }).name = 'changed' // the returned object is a copy, never mutable store state
  expect((await store.finish(device, begun)).name).toBe('notes.txt')
})
it('destroys bad hashes and releases their reservations', async () => {
  await replace({ maxReservedBytes: 5 })
  const begun = await store.begin(device, metadata(undefined, { sha256: '0'.repeat(64) }))
  await store.chunk(device, { ...begun, data: Buffer.from('hello').toString('base64') })
  await expect(store.finish(device, begun)).rejects.toMatchObject({ code: 'UPLOAD_INTEGRITY' })
  await expect(store.finish(device, begun)).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' })
  await expect(store.begin(device, metadata())).resolves.toHaveProperty('uploadId')
})
it.each([
  ['image/png', png], ['image/jpeg', Buffer.from([255, 216, 255, 0])],
  ['image/gif', Buffer.from('GIF89a1234')], ['image/webp', Buffer.from('RIFF1234WEBP1234')],
])('verifies %s signatures, leaving full image decoding to DSH', async (mediaType, bytes) => {
  const { ready } = await upload(bytes, { kind: 'image', mediaType, name: 'photo.bin' })
  expect(ready.mediaType).toBe(mediaType)
  await store.withReady(device, sessionId, [ready.attachmentId], async ([item]) => {
    expect(await item!.imageData()).toBe(bytes.toString('base64'))
  })
})
it('rejects MIME spoofing and never marks it ready', async () => {
  const begun = await store.begin(device, metadata(Buffer.from('<script>'), { kind: 'image', mediaType: 'image/png' }))
  await store.chunk(device, { ...begun, data: Buffer.from('<script>').toString('base64') })
  await expect(store.finish(device, begun)).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
})
it('prevents foreign device chunks, finish and abort; binds ready objects to session and device', async () => {
  const result = await upload()
  for (const action of [() => store.chunk('foreign', { ...result, data: 'aA==' }), () => store.finish('foreign', result), () => store.abort('foreign', result)]) {
    await expect(action()).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' })
  }
  for (const [owner, target, ids] of [
    ['foreign', sessionId, [result.ready.attachmentId]], [device, 'different', [result.ready.attachmentId]],
    [device, sessionId, [result.uploadId]], [device, sessionId, [result.ready.attachmentId, result.ready.attachmentId]],
  ] as const) {
    await expect(store.withReady(owner, target, ids, async () => true)).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
  }
  expect(await store.finish(device, result)).toEqual(result.ready)
})
it('enforces per-device, global-count and aggregate-byte limits under concurrent begins', async () => {
  await replace({ maxDeviceUploads: 2, maxUploads: 3, maxReservedBytes: 15 })
  const results = await Promise.allSettled(Array.from({ length: 5 }, () => store.begin(device, metadata())))
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(2)
  await store.begin('other', metadata())
  await expect(store.begin('third', metadata())).rejects.toMatchObject({ code: 'UPLOAD_LIMIT_REACHED' })
  const first = results.find((result) => result.status === 'fulfilled') as PromiseFulfilledResult<{ uploadId: string }>
  await store.abort(device, first.value)
  await expect(store.begin('third', metadata())).resolves.toHaveProperty('uploadId')
})
it('enforces reserved bytes even with spare upload slots', async () => {
  await replace({ maxReservedBytes: 9 })
  await store.begin(device, metadata())
  await expect(store.begin('other', metadata())).rejects.toMatchObject({ code: 'UPLOAD_LIMIT_REACHED' })
})
it('abort is idempotent for unknown uploads and removes ready files', async () => {
  const result = await upload()
  expect(await store.abort(device, result)).toEqual({ aborted: true })
  expect(await store.abort(device, result)).toEqual({ aborted: true })
  await expect(store.withReady(device, sessionId, [result.ready.attachmentId], async () => true)).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
  const [root] = await readdir(parent)
  expect(await readdir(join(parent, root!))).toEqual([])
})
it('expires incomplete and ready uploads, without extending TTL on retries', async () => {
  let now = 10
  await replace({ now: () => now, ttlMs: 1000 })
  const incomplete = await store.begin(device, metadata())
  const ready = await upload()
  now += 1001
  await expect(store.finish(device, ready)).rejects.toMatchObject({ code: 'UPLOAD_EXPIRED' })
  await store.cleanup()
  await expect(store.finish(device, incomplete)).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' })
  const [root] = await readdir(parent)
  expect(await readdir(join(parent, root!))).toEqual([])
})
it('serializes abort against streaming admission and does not deadlock opposite ID orders', async () => {
  const a = await upload(), b = await upload()
  let release!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  let entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const read = store.withReady(device, sessionId, [a.ready.attachmentId, b.ready.attachmentId], async () => { entered(); await held; return 1 })
  await started
  const reversed = store.withReady(device, sessionId, [b.ready.attachmentId, a.ready.attachmentId], async () => 2)
  const abort = store.abort(device, a)
  release()
  expect(await read).toBe(1)
  // Abort may win one lock before the second prompt; either result is safe.
  const result = await Promise.allSettled([reversed, abort])
  expect(result[1]!.status).toBe('fulfilled')
})
it('shutdown cancels readers, closes files, removes its own root and rejects further use', async () => {
  const result = await upload()
  await writeFile(join(parent, 'unrelated.txt'), 'keep')
  await store.dispose()
  await store.dispose()
  expect(store.signal.aborted).toBe(true)
  expect(await readdir(parent)).toEqual(['unrelated.txt'])
  await expect(store.begin(device, metadata())).rejects.toMatchObject({ code: 'REMOTE_ERROR' })
  await expect(store.finish(device, result)).rejects.toMatchObject({ code: 'REMOTE_ERROR' })
})
it('detects same-length filesystem tampering at finish and again before DSH consumes ready bytes', async () => {
  const begun = await store.begin(device, metadata())
  await store.chunk(device, { ...begun, data: Buffer.from('hello').toString('base64') })
  const [root] = await readdir(parent)
  let names = await readdir(join(parent, root!))
  await writeFile(join(parent, root!, names[0]!), 'evil!')
  await expect(store.finish(device, begun)).rejects.toMatchObject({ code: 'UPLOAD_INTEGRITY' })
  const next = await upload()
  names = await readdir(join(parent, root!))
  await writeFile(join(parent, root!, names[0]!), 'evil!')
  await expect(store.withReady(device, sessionId, [next.ready.attachmentId], async ([item]) => {
    for await (const _ of item!.stream()) { /* DSH stream must reject rather than commit */ }
  })).rejects.toMatchObject({ code: 'UPLOAD_INTEGRITY' })
})
it('does not mistake high-bit bytes for ASCII image signatures', async () => {
  const bytes = Buffer.from('GIF89a').map((value) => value | 0x80)
  const begun = await store.begin(device, metadata(bytes, { kind: 'image', mediaType: 'image/gif' }))
  await store.chunk(device, { ...begun, data: bytes.toString('base64') })
  await expect(store.finish(device, begun)).rejects.toMatchObject({ code: 'ATTACHMENT_INVALID' })
})
it('runs regular cleanup, then stops its timer on disposal', async () => {
  await store.dispose()
  vi.useFakeTimers()
  try {
    store = await UploadStore.open({ parent, ttlMs: 1000, cleanupIntervalMs: 100 })
    const cleanup = vi.spyOn(store, 'cleanup')
    const begun = await store.begin(device, metadata())
    await vi.advanceTimersByTimeAsync(1100)
    await store.cleanup()
    expect(cleanup).toHaveBeenCalled()
    await expect(store.finish(device, begun)).rejects.toMatchObject({ code: 'UPLOAD_NOT_FOUND' })
    await store.dispose()
    const count = cleanup.mock.calls.length
    await vi.advanceTimersByTimeAsync(10000)
    expect(cleanup).toHaveBeenCalledTimes(count)
  } finally { vi.useRealTimers() }
})
it('caps per-upload queued operations while an admission pins the file', async () => {
  const result = await upload()
  let release!: () => void, entered!: () => void
  const started = new Promise<void>((resolve) => { entered = resolve })
  const held = new Promise<void>((resolve) => { release = resolve })
  const use = store.withReady(device, sessionId, [result.ready.attachmentId], async () => { entered(); await held })
  await started
  const pending = Array.from({ length: 12 }, () => store.finish(device, result))
  const all = Promise.allSettled(pending)
  release()
  await use
  const statuses = await all
  expect(statuses.some((item) => item.status === 'rejected' && item.reason.code === 'UPLOAD_LIMIT_REACHED')).toBe(true)
})
it('cancels a streamed read with the supplied signal', async () => {
  const result = await upload()
  await expect(store.withReady(device, sessionId, [result.ready.attachmentId], async ([item]) => {
    for await (const _ of item!.stream(AbortSignal.abort())) { /* cannot reach */ }
  })).rejects.toThrow()
})
