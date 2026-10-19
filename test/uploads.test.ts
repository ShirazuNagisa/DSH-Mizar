/**
 * Tests for attachment staging.
 *
 * The upload methods are the one place a phone can put bytes on the desktop, so
 * the tests pin the properties the rest of the feature relies on:
 *
 *   - a chunk is accepted only at the index the store expects, and a retried
 *     chunk is compared rather than trusted;
 *   - everything is bound to the device that opened the socket and the session
 *     it named -- another device cannot finish, abort or attach somebody else's
 *     bytes, and "not yours" is answered exactly like "not there";
 *   - the documented limits are checked at `begin` (before megabytes move) and
 *     again when a prompt names attachments;
 *   - every byte is temporary: after the TTL the record and its directory are
 *     gone, including directories left by a process that is no longer running.
 *
 * Filesystem assertions use a real temporary directory rather than a mock,
 * because "the bytes are on disk where `finish` says they are" is the claim, and
 * a mock would pass a test the real code fails.
 *
 * @module dsh-mizar/test/uploads
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CHUNK_BYTES,
  enforcePromptLimits,
  parseUploadBegin,
  parseUploadChunk,
  UploadStore,
  UPLOAD_LIMITS,
  UPLOAD_TTL_MS,
  type UploadBeginRequest,
  type UploadFinishResult,
} from '../src/bridge/uploads.js'

/** A store and the directories it owns, for one test. */
interface Harness {
  readonly store: UploadStore
  /** `<dir>/uploads`; one directory per upload. */
  readonly root: string
  /** `<dir>/attachments`; fallback copies of files. */
  readonly attachmentsRoot: string
  /** The temporary directory every path is under. */
  readonly dir: string
  /** The store's clock, advanced by tests that need time to pass. */
  readonly clock: { time: number }
}

/** Every harness created, so a failing test cannot leave directories behind. */
const harnesses: Harness[] = []

/**
 * Build a store over a fresh temporary directory.
 * @param options - lifetime and chunk-size overrides.
 * @returns the store and its directories.
 */
async function makeHarness(
  options: { ttlMs?: number; chunkBytes?: number } = {},
): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-uploads-'))
  const root = join(dir, 'uploads')
  const attachmentsRoot = join(dir, 'attachments')
  const clock = { time: Date.now() }
  const store = new UploadStore({
    root,
    attachmentsRoot,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
    ...(options.chunkBytes === undefined ? {} : { chunkBytes: options.chunkBytes }),
    now: () => clock.time,
  })
  const harness = { store, root, attachmentsRoot, dir, clock }
  harnesses.push(harness)
  return harness
}

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => rm(harness.dir, { recursive: true, force: true })))
})

/** The chunk payload for a byte range. */
function chunkOf(bytes: Buffer, offset: number, length: number): string {
  return bytes.subarray(offset, Math.min(offset + length, bytes.length)).toString('base64')
}

/**
 * Upload every byte and finish, asserting the chunk counter along the way.
 *
 * @param store - the store to drive.
 * @param deviceId - the device uploading.
 * @param request - what to upload.
 * @param bytes - the exact bytes.
 * @returns the finished attachment.
 */
async function upload(
  store: UploadStore,
  deviceId: string,
  request: UploadBeginRequest,
  bytes: Buffer,
): Promise<UploadFinishResult> {
  const begun = await store.begin(deviceId, request)
  for (let index = 0, offset = 0; offset < bytes.length; index += 1, offset += begun.chunkBytes) {
    const result = await store.chunk(deviceId, {
      uploadId: begun.uploadId,
      index,
      data: chunkOf(bytes, offset, begun.chunkBytes),
    })
    expect(result.received).toBe(index + 1)
  }
  return store.finish(deviceId, begun.uploadId)
}

/** A request for a small document. */
function fileRequest(byteSize: number, sessionId = 's1'): UploadBeginRequest {
  return { sessionId, kind: 'file', name: 'notes.txt', mediaType: 'text/plain', byteSize }
}

/** A request for a small photograph. */
function imageRequest(byteSize: number, sessionId = 's1'): UploadBeginRequest {
  return { sessionId, kind: 'image', name: 'photo.jpg', mediaType: 'image/jpeg', byteSize }
}

describe('the happy path', () => {
  it('begins, takes chunks and finishes with the declared metadata', async () => {
    const { store } = await makeHarness()
    const bytes = Buffer.from('a small document')

    const begun = await store.begin('d1', fileRequest(bytes.length))
    expect(begun.uploadId).toMatch(/^[0-9a-f-]{36}$/)
    expect(begun.chunkBytes).toBe(CHUNK_BYTES)

    const result = await store.chunk('d1', {
      uploadId: begun.uploadId,
      index: 0,
      data: bytes.toString('base64'),
    })
    expect(result).toEqual({ received: 1 })

    const finished = await store.finish('d1', begun.uploadId)
    expect(finished).toEqual({
      attachmentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      kind: 'file',
      name: 'notes.txt',
      mediaType: 'text/plain',
      byteSize: bytes.length,
    })

    const resolved = await store.resolveForPrompt('d1', 's1', [finished.attachmentId])
    expect(resolved).toHaveLength(1)
    expect(resolved[0]?.attachmentId).toBe(finished.attachmentId)
    await expect(readFile(resolved[0]!.path)).resolves.toEqual(bytes)
  })

  it('assembles a multi-chunk upload at the right offsets', async () => {
    // A four-byte chunk size keeps the fixture small while still exercising the
    // offset arithmetic a real 128 KiB upload uses.
    const { store } = await makeHarness({ chunkBytes: 4 })
    const bytes = Buffer.from('0123456789')

    const finished = await upload(store, 'd1', fileRequest(bytes.length), bytes)
    const resolved = await store.resolveForPrompt('d1', 's1', [finished.attachmentId])
    await expect(readFile(resolved[0]!.path)).resolves.toEqual(bytes)
  })

  it('keeps the last chunk short when the file does not divide evenly', async () => {
    const { store } = await makeHarness({ chunkBytes: 4 })
    const bytes = Buffer.from('0123456789')
    const begun = await store.begin('d1', fileRequest(bytes.length))
    await store.chunk('d1', { uploadId: begun.uploadId, index: 0, data: bytes.subarray(0, 4).toString('base64') })
    await store.chunk('d1', { uploadId: begun.uploadId, index: 1, data: bytes.subarray(4, 8).toString('base64') })
    // The final chunk is two bytes, not four: allowed only because it completes
    // the declared size.
    await store.chunk('d1', { uploadId: begun.uploadId, index: 2, data: bytes.subarray(8).toString('base64') })
    await expect(store.finish('d1', begun.uploadId)).resolves.toMatchObject({ byteSize: 10 })
  })
})

describe('device and session binding', () => {
  it('does not let another device touch an upload it did not begin', async () => {
    const { store } = await makeHarness()
    const bytes = Buffer.from('abc')
    const begun = await store.begin('d1', fileRequest(bytes.length))
    await store.chunk('d1', {
      uploadId: begun.uploadId,
      index: 0,
      data: bytes.toString('base64'),
    })

    // The device id comes from the authenticated socket, so a different device
    // reaching the id is either a bug or an attack -- both get one answer.
    await expect(
      store.chunk('d2', { uploadId: begun.uploadId, index: 0, data: bytes.toString('base64') }),
    ).rejects.toMatchObject({ code: 'UPLOAD_UNKNOWN' })
    await expect(store.finish('d2', begun.uploadId)).rejects.toMatchObject({ code: 'UPLOAD_UNKNOWN' })
    await expect(store.abort('d2', begun.uploadId)).rejects.toMatchObject({ code: 'UPLOAD_UNKNOWN' })

    // ...and none of those attempts disturbed the real owner's upload.
    await expect(store.finish('d1', begun.uploadId)).resolves.toMatchObject({ byteSize: bytes.length })
  })

  it('does not let another device or session use a finished attachment', async () => {
    const { store } = await makeHarness()
    const bytes = Buffer.from('report')
    const finished = await upload(store, 'd1', fileRequest(bytes.length, 's1'), bytes)

    await expect(
      store.resolveForPrompt('d2', 's1', [finished.attachmentId]),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_UNKNOWN' })
    await expect(
      store.resolveForPrompt('d1', 's2', [finished.attachmentId]),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_UNKNOWN' })
    await expect(
      store.resolveForPrompt('d1', 's1', [finished.attachmentId]),
    ).resolves.toHaveLength(1)
  })

  it('answers an id that never existed the same way as a foreign one', async () => {
    const { store } = await makeHarness()
    await expect(store.finish('d1', 'no-such-upload')).rejects.toMatchObject({ code: 'UPLOAD_UNKNOWN' })
    await expect(store.abort('d1', 'no-such-upload')).rejects.toMatchObject({ code: 'UPLOAD_UNKNOWN' })
    await expect(
      store.resolveForPrompt('d1', 's1', ['no-such-attachment']),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_UNKNOWN' })
  })
})

describe('chunk ordering and duplicates', () => {
  it('refuses a chunk that arrives before its index', async () => {
    const { store } = await makeHarness({ chunkBytes: 4 })
    const begun = await store.begin('d1', fileRequest(8))
    await expect(
      store.chunk('d1', { uploadId: begun.uploadId, index: 1, data: Buffer.from('4567').toString('base64') }),
    ).rejects.toMatchObject({ code: 'UPLOAD_BAD_CHUNK' })
    // Nothing was stored: the first chunk still starts at byte zero.
    await expect(
      store.chunk('d1', { uploadId: begun.uploadId, index: 0, data: Buffer.from('0123').toString('base64') }),
    ).resolves.toEqual({ received: 1 })
  })

  it('treats the same index with the same bytes as an idempotent retry', async () => {
    const { store } = await makeHarness({ chunkBytes: 4 })
    const begun = await store.begin('d1', fileRequest(8))
    const first = Buffer.from('0123').toString('base64')

    await expect(
      store.chunk('d1', { uploadId: begun.uploadId, index: 0, data: first }),
    ).resolves.toEqual({ received: 1 })
    // A retry after a dropped acknowledgement must not append the chunk twice,
    // and must answer the same `received` it answered the first time.
    await expect(
      store.chunk('d1', { uploadId: begun.uploadId, index: 0, data: first }),
    ).resolves.toEqual({ received: 1 })
    await expect(
      store.chunk('d1', { uploadId: begun.uploadId, index: 1, data: Buffer.from('4567').toString('base64') }),
    ).resolves.toEqual({ received: 2 })
    await expect(store.finish('d1', begun.uploadId)).resolves.toMatchObject({ byteSize: 8 })
  })

  it('refuses the same index with different bytes rather than overwriting', async () => {
    const { store } = await makeHarness({ chunkBytes: 4 })
    const begun = await store.begin('d1', fileRequest(8))
    await store.chunk('d1', {
      uploadId: begun.uploadId,
      index: 0,
      data: Buffer.from('0123').toString('base64'),
    })
    await expect(
      store.chunk('d1', {
        uploadId: begun.uploadId,
        index: 0,
        data: Buffer.from('abcd').toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_BAD_CHUNK' })
  })

  it('refuses a short chunk that is not the last one', async () => {
    // A short middle chunk would make the next index ambiguous and could leave a
    // hole that `finish` would count as received bytes.
    const { store } = await makeHarness({ chunkBytes: 4 })
    const begun = await store.begin('d1', fileRequest(8))
    await expect(
      store.chunk('d1', {
        uploadId: begun.uploadId,
        index: 0,
        data: Buffer.from('01').toString('base64'),
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_BAD_CHUNK' })
  })

  it('refuses base64 that is not canonical', async () => {
    const { store } = await makeHarness()
    const begun = await store.begin('d1', fileRequest(4))
    for (const data of ['', 'AA', 'not base64!', 'AAAA\n', 'AAA=', '====']) {
      await expect(
        store.chunk('d1', { uploadId: begun.uploadId, index: 0, data }),
        `data ${JSON.stringify(data)} was accepted`,
      ).rejects.toMatchObject({ code: 'UPLOAD_BAD_CHUNK' })
    }
  })
})

describe('limits', () => {
  it('refuses an image over 10 MiB before any bytes move', async () => {
    const { store } = await makeHarness()
    await expect(
      store.begin('d1', imageRequest(UPLOAD_LIMITS.imageBytes + 1)),
    ).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE' })
    await expect(store.begin('d1', imageRequest(UPLOAD_LIMITS.imageBytes))).resolves.toMatchObject({
      chunkBytes: CHUNK_BYTES,
    })
  })

  it('refuses a file over 32 MiB before any bytes move', async () => {
    const { store } = await makeHarness()
    await expect(
      store.begin('d1', fileRequest(UPLOAD_LIMITS.fileBytes + 1)),
    ).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE' })
  })

  it('refuses bytes beyond the declared size', async () => {
    const { store } = await makeHarness({ chunkBytes: 4 })
    const begun = await store.begin('d1', fileRequest(5))
    await store.chunk('d1', { uploadId: begun.uploadId, index: 0, data: Buffer.from('0123').toString('base64') })
    // Four more bytes would make nine, but the client declared five.
    await expect(
      store.chunk('d1', { uploadId: begun.uploadId, index: 1, data: Buffer.from('4567').toString('base64') }),
    ).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE' })
  })

  it('refuses a chunk larger than the chunk size', async () => {
    const { store } = await makeHarness({ chunkBytes: 4 })
    const begun = await store.begin('d1', fileRequest(8))
    await expect(
      store.chunk('d1', { uploadId: begun.uploadId, index: 0, data: Buffer.from('012345').toString('base64') }),
    ).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE' })
  })

  it('refuses unsupported media types with a specific code', async () => {
    const { store } = await makeHarness()
    await expect(
      store.begin('d1', { ...imageRequest(4), mediaType: 'image/tiff' }),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_UNSUPPORTED' })
    await expect(
      store.begin('d1', { ...fileRequest(4), mediaType: 'not-a-mime-type' }),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_UNSUPPORTED' })
  })

  it('refuses a finish before every declared byte arrived', async () => {
    const { store } = await makeHarness({ chunkBytes: 4 })
    const begun = await store.begin('d1', fileRequest(8))
    await store.chunk('d1', { uploadId: begun.uploadId, index: 0, data: Buffer.from('0123').toString('base64') })
    await expect(store.finish('d1', begun.uploadId)).rejects.toMatchObject({ code: 'UPLOAD_INCOMPLETE' })
  })

  it('refuses more than eight attachments in one prompt', async () => {
    const { store } = await makeHarness()
    const ids: string[] = []
    for (let index = 0; index < UPLOAD_LIMITS.attachments + 1; index += 1) {
      const bytes = Buffer.from([index])
      const finished = await upload(store, 'd1', fileRequest(1), bytes)
      ids.push(finished.attachmentId)
    }
    await expect(store.resolveForPrompt('d1', 's1', ids)).rejects.toMatchObject({
      code: 'ATTACHMENT_TOO_LARGE',
    })
  })

  it('refuses more than four images in one prompt', async () => {
    const { store } = await makeHarness()
    const ids: string[] = []
    for (let index = 0; index < UPLOAD_LIMITS.images + 1; index += 1) {
      const finished = await upload(store, 'd1', imageRequest(1), Buffer.from([index]))
      ids.push(finished.attachmentId)
    }
    await expect(store.resolveForPrompt('d1', 's1', ids)).rejects.toMatchObject({
      code: 'ATTACHMENT_TOO_LARGE',
    })
  })

  it('enforces the prompt totals the protocol documents', () => {
    const MiB = 1024 * 1024
    // Eight files of 8 MiB is exactly the 64 MiB prompt limit: allowed.
    expect(() =>
      enforcePromptLimits(
        Array.from({ length: 8 }, () => ({ kind: 'file' as const, byteSize: 8 * MiB, name: 'f' })),
      ),
    ).not.toThrow()
    // One byte more is not.
    expect(() =>
      enforcePromptLimits([
        { kind: 'file' as const, byteSize: 32 * MiB, name: 'a' },
        { kind: 'file' as const, byteSize: 32 * MiB + 1, name: 'b' },
      ]),
    ).toThrow(expect.objectContaining({ code: 'ATTACHMENT_TOO_LARGE' }))
    // And the per-kind maximum is checked even when the total would fit.
    expect(() =>
      enforcePromptLimits([{ kind: 'image' as const, byteSize: 10 * MiB + 1, name: 'p' }]),
    ).toThrow(expect.objectContaining({ code: 'ATTACHMENT_TOO_LARGE' }))
  })

  it('refuses duplicate ids in one prompt', async () => {
    const { store } = await makeHarness()
    const finished = await upload(store, 'd1', fileRequest(1), Buffer.from('x'))
    await expect(
      store.resolveForPrompt('d1', 's1', [finished.attachmentId, finished.attachmentId]),
    ).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
  })
})

describe('abort, expiry and cleanup', () => {
  it('abort discards the bytes and the record', async () => {
    const { store, root } = await makeHarness()
    const begun = await store.begin('d1', fileRequest(4))
    const directory = join(root, begun.uploadId)
    await expect(stat(directory)).resolves.toBeTruthy()

    await expect(store.abort('d1', begun.uploadId)).resolves.toEqual({ aborted: true })
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(
      store.chunk('d1', { uploadId: begun.uploadId, index: 0, data: Buffer.from('abcd').toString('base64') }),
    ).rejects.toMatchObject({ code: 'UPLOAD_UNKNOWN' })
  })

  it('expires an unfinished upload after the TTL', async () => {
    const { store, root, clock } = await makeHarness()
    const begun = await store.begin('d1', fileRequest(4))
    clock.time += UPLOAD_TTL_MS + 1
    // The sweep judges a directory no live record points at by its payload's
    // **real** mtime, and the fake clock above cannot move that. Backdating the
    // file keeps the test about the store's expiry rule rather than about how
    // fast this machine creates a file: the one-millisecond margin used to pass
    // or fail depending on load, because creating the payload in the same
    // millisecond as the harness clock was a coin toss.
    const old = new Date(clock.time - UPLOAD_TTL_MS - 60_000)
    await utimes(join(root, begun.uploadId, 'payload'), old, old)

    await expect(
      store.chunk('d1', { uploadId: begun.uploadId, index: 0, data: Buffer.from('abcd').toString('base64') }),
    ).rejects.toMatchObject({ code: 'UPLOAD_UNKNOWN' })

    // The next begin sweeps directories the process no longer tracks, so the
    // expired bytes are gone even though the failing lookup could not wait for
    // the unlink.
    await store.begin('d1', fileRequest(4))
    expect(await readdir(root)).not.toContain(begun.uploadId)
  })

  it('expires a finished attachment after the TTL', async () => {
    const { store, root, clock } = await makeHarness()
    const finished = await upload(store, 'd1', fileRequest(1), Buffer.from('x'))
    clock.time += UPLOAD_TTL_MS + 1

    await expect(
      store.resolveForPrompt('d1', 's1', [finished.attachmentId]),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_UNKNOWN' })
    expect(await readdir(root)).toHaveLength(0)
  })

  it('sweeps a directory left behind by an earlier process', async () => {
    const { store, root } = await makeHarness()
    const orphan = join(root, 'leftover-upload')
    await mkdir(orphan, { recursive: true })
    const payload = join(orphan, 'payload')
    await writeFile(payload, 'stale bytes')
    const old = new Date(Date.now() - UPLOAD_TTL_MS - 60_000)
    await utimes(payload, old, old)

    await store.begin('d1', fileRequest(4))
    await expect(stat(orphan)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the fallback copy outside the staging area the sweep deletes', async () => {
    const { store, attachmentsRoot } = await makeHarness()
    const bytes = Buffer.from('the file a prompt points at')
    const finished = await upload(store, 'd1', fileRequest(bytes.length), bytes)
    const [resolved] = await store.resolveForPrompt('d1', 's1', [finished.attachmentId])

    const saved = await resolved!.saveFallback()
    expect(saved.startsWith(attachmentsRoot + sep)).toBe(true)
    await expect(readFile(saved)).resolves.toEqual(bytes)
  })

  it('sanitizes a hostile file name instead of following it out of the directory', async () => {
    const { store, attachmentsRoot } = await makeHarness()
    const bytes = Buffer.from('payload')
    const finished = await upload(
      store,
      'd1',
      { sessionId: 's1', kind: 'file', name: '../../escape.txt', mediaType: 'text/plain', byteSize: bytes.length },
      bytes,
    )
    const [resolved] = await store.resolveForPrompt('d1', 's1', [finished.attachmentId])
    const saved = await resolved!.saveFallback()
    // Under the attachment's own directory, never at the traversal target.
    expect(saved).toContain(join(attachmentsRoot, finished.attachmentId))
    expect(saved).not.toContain('..')
    await expect(readFile(saved)).resolves.toEqual(bytes)
  })
})

describe('payload parsing', () => {
  it('reads a begin payload and rejects unusable fields', () => {
    expect(
      parseUploadBegin({
        sessionId: 's1',
        kind: 'file',
        name: 'a.txt',
        mediaType: 'text/plain',
        byteSize: 3,
      }),
    ).toEqual({ sessionId: 's1', kind: 'file', name: 'a.txt', mediaType: 'text/plain', byteSize: 3 })

    const base = { sessionId: 's1', kind: 'file', name: 'a.txt', mediaType: 'text/plain', byteSize: 3 }
    expect(() => parseUploadBegin('nope')).toThrow(expect.objectContaining({ code: 'MALFORMED_FRAME' }))
    expect(() => parseUploadBegin({ ...base, kind: 'video' })).toThrow(
      expect.objectContaining({ code: 'MALFORMED_FRAME' }),
    )
    for (const byteSize of [0, -1, 1.5, '3', undefined]) {
      expect(() => parseUploadBegin({ ...base, byteSize }), `byteSize ${String(byteSize)}`).toThrow(
        expect.objectContaining({ code: 'MALFORMED_FRAME' }),
      )
    }
    expect(() => parseUploadBegin({ ...base, name: 'a\u0000b' })).toThrow(
      expect.objectContaining({ code: 'MALFORMED_FRAME' }),
    )
  })

  it('reads a chunk payload and rejects a bad index or data', () => {
    expect(parseUploadChunk({ uploadId: 'u1', index: 0, data: 'AAAA' })).toEqual({
      uploadId: 'u1',
      index: 0,
      data: 'AAAA',
    })
    for (const index of [-1, 1.5, '0', undefined]) {
      expect(() => parseUploadChunk({ uploadId: 'u1', index, data: 'AAAA' }), `index ${String(index)}`).toThrow(
        expect.objectContaining({ code: 'MALFORMED_FRAME' }),
      )
    }
    expect(() => parseUploadChunk({ uploadId: 'u1', index: 0, data: 42 })).toThrow(
      expect.objectContaining({ code: 'MALFORMED_FRAME' }),
    )
  })
})
