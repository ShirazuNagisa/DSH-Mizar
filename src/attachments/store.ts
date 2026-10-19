/** Bounded, private staging for authenticated mobile uploads. No caller path is used. */
import { createHash, randomUUID, type Hash } from 'node:crypto'
import { mkdtemp, open, rm, unlink, type FileHandle } from 'node:fs/promises'
import { makePrivateDirectory } from './private-directory.js'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MethodError, requireObject, requireString } from '../bridge/method-error.js'

export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number]
const MAX_BYTES = 20 * 1024 * 1024
const CHUNK_BYTES = 64 * 1024

export interface AttachmentInfo {
  readonly attachmentId: string
  readonly name: string
  readonly bytes: number
  readonly kind: 'image' | 'file'
  readonly mediaType?: ImageMediaType
}

export interface ReadyAttachment {
  readonly info: AttachmentInfo
  /** Only available while withReady's callback holds the upload's lock. */
  imageData(): Promise<string>
  stream(signal?: AbortSignal): AsyncIterable<Uint8Array>
}

interface Upload {
  readonly uploadId: string
  readonly deviceId: string
  readonly sessionId: string
  readonly path: string
  readonly name: string
  readonly bytes: number
  readonly kind: 'image' | 'file'
  readonly mediaType?: ImageMediaType
  readonly sha256: string
  readonly expiresAt: number
  readonly hash: Hash
  handle: FileHandle
  offset: number
  prefix: Buffer
  last?: { offset: number; bytes: number; digest: string }
  ready?: AttachmentInfo
  retired: boolean
  tail: Promise<unknown>
  queued: number
}

export interface UploadStoreOptions {
  /** Trusted host/test configuration, NEVER taken from an RPC payload. */
  parent?: string
  maxFileBytes?: number
  maxImageBytes?: number
  maxReservedBytes?: number
  maxUploads?: number
  maxDeviceUploads?: number
  ttlMs?: number
  cleanupIntervalMs?: number
  now?: () => number
  log?: (message: string) => void
}

/** Reject path-bearing names, control/bidi characters and Windows special filenames. */
export function displayName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || Buffer.byteLength(value, 'utf8') > 240 ||
      /[\\/<>:"|?*\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/u.test(value) ||
      value === '.' || value === '..' || /[. ]$/.test(value) ||
      /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value)) {
    throw new MethodError('MALFORMED_FRAME', 'attachment name must be a bounded, safe leaf display name')
  }
  return value
}

export function boundedId(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) {
    throw new MethodError('MALFORMED_FRAME', `${label} must be a nonempty string of at most 256 characters`)
  }
  return value
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0 ? Math.min(value, fallback) : fallback
}

function matchesSignature(prefix: Buffer, mediaType: ImageMediaType): boolean {
  switch (mediaType) {
    case 'image/png': return prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    case 'image/jpeg': return prefix.length >= 3 && prefix[0] === 255 && prefix[1] === 216 && prefix[2] === 255
    case 'image/gif': return ['GIF87a', 'GIF89a'].includes(prefix.subarray(0, 6).toString('latin1'))
    case 'image/webp': return prefix.length >= 12 && prefix.toString('latin1', 0, 4) === 'RIFF' && prefix.toString('latin1', 8, 12) === 'WEBP'
  }
}

export class UploadStore {
  readonly #root: string
  readonly #options: Required<Omit<UploadStoreOptions, 'parent'>>
  readonly #uploads = new Map<string, Upload>()
  readonly #attachments = new Map<string, Upload>()
  readonly #controller = new AbortController()
  #reservedBytes = 0
  #beginTail: Promise<unknown> = Promise.resolve()
  #beginQueued = 0
  #timer?: ReturnType<typeof setInterval>
  #cleanup?: Promise<void>
  #dispose?: Promise<void>
  #closed = false

  private constructor(root: string, options: UploadStoreOptions) {
    this.#root = root
    this.#options = {
      maxFileBytes: positiveLimit(options.maxFileBytes, MAX_BYTES),
      maxImageBytes: positiveLimit(options.maxImageBytes, MAX_BYTES),
      maxReservedBytes: positiveLimit(options.maxReservedBytes, 200 * 1024 * 1024),
      maxUploads: positiveLimit(options.maxUploads, 100),
      maxDeviceUploads: positiveLimit(options.maxDeviceUploads, 10),
      ttlMs: positiveLimit(options.ttlMs, 30 * 60 * 1000),
      cleanupIntervalMs: positiveLimit(options.cleanupIntervalMs, 60_000),
      now: options.now ?? Date.now,
      log: options.log ?? (() => {}),
    }
    this.#timer = setInterval(() => { void this.cleanup().catch(() => this.#options.log('attachment cleanup failed')) }, this.#options.cleanupIntervalMs)
    this.#timer.unref?.()
  }

  static async open(options: UploadStoreOptions = {}): Promise<UploadStore> {
    const root = await mkdtemp(join(options.parent ?? tmpdir(), 'mizar-attachments-'))
    try {
      // POSIX 0700; Windows removes inheritance and grants only the current SID.
      // No uploaded bytes are created before this succeeds; fail closed otherwise.
      await makePrivateDirectory(root)
      return new UploadStore(root, options)
    } catch (error) {
      await rm(root, { recursive: true, force: true })
      throw error
    }
  }

  get signal(): AbortSignal { return this.#controller.signal }
  get capabilities() {
    return {
      version: 1, maxFileBytes: this.#options.maxFileBytes, maxImageBytes: this.#options.maxImageBytes,
      maxAttachments: 5, chunkBytes: CHUNK_BYTES, expiresSeconds: Math.floor(this.#options.ttlMs / 1000),
      imageMediaTypes: [...IMAGE_MEDIA_TYPES],
    }
  }

  async begin(deviceId: string, payload: unknown): Promise<{ uploadId: string; chunkBytes: number; offset: 0 }> {
    const record = requireObject(payload, 'attachment.begin')
    const sessionId = boundedId(record['sessionId'], 'sessionId')
    const name = displayName(record['name'])
    const bytes = record['bytes']
    const sha256 = record['sha256']
    const kind = record['kind']
    const mediaType = record['mediaType']
    if (typeof bytes !== 'number' || !Number.isSafeInteger(bytes) || bytes <= 0 ||
        typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256) ||
        (kind !== 'image' && kind !== 'file')) {
      throw new MethodError('MALFORMED_FRAME', 'attachment.begin requires positive integral bytes, lowercase SHA-256 and image/file kind')
    }
    if (kind === 'image' && !(IMAGE_MEDIA_TYPES as readonly unknown[]).includes(mediaType)) {
      throw new MethodError('ATTACHMENT_INVALID', 'unsupported image media type')
    }
    if (kind === 'file' && mediaType !== undefined) {
      throw new MethodError('MALFORMED_FRAME', 'file uploads do not accept mediaType')
    }
    if (bytes > (kind === 'image' ? this.#options.maxImageBytes : this.#options.maxFileBytes)) {
      throw new MethodError('UPLOAD_TOO_LARGE', 'attachment exceeds the advertised byte limit')
    }
    if (this.#beginQueued >= 16) throw new MethodError('UPLOAD_LIMIT_REACHED', 'too many pending uploads')
    this.#beginQueued++
    const work = this.#beginTail.then(async () => {
      this.#assertOpen()
      if (this.#uploads.size >= this.#options.maxUploads ||
          [...this.#uploads.values()].filter((upload) => upload.deviceId === deviceId).length >= this.#options.maxDeviceUploads ||
          this.#reservedBytes + bytes > this.#options.maxReservedBytes) {
        throw new MethodError('UPLOAD_LIMIT_REACHED', 'upload count or reserved byte limit reached; remove drafts or wait for expiry')
      }
      const uploadId = randomUUID()
      // Both directory and filename are host generated; display names are never paths.
      const path = join(this.#root, randomUUID())
      let handle: FileHandle
      try { handle = await open(path, 'wx+', 0o600) } catch (cause) {
        throw new MethodError('REMOTE_ERROR', 'cannot create private attachment staging file', cause)
      }
      this.#uploads.set(uploadId, {
        uploadId, deviceId, sessionId, path, handle, name, bytes, sha256, kind,
        ...(kind === 'image' ? { mediaType: mediaType as ImageMediaType } : {}),
        expiresAt: this.#options.now() + this.#options.ttlMs,
        hash: createHash('sha256'), offset: 0, prefix: Buffer.alloc(0), retired: false,
        tail: Promise.resolve(), queued: 0,
      })
      this.#reservedBytes += bytes
      return { uploadId, chunkBytes: CHUNK_BYTES, offset: 0 as const }
    })
    this.#beginTail = work.catch(() => {})
    try { return await work } finally { this.#beginQueued-- }
  }

  async chunk(deviceId: string, payload: unknown): Promise<{ offset: number }> {
    const record = requireObject(payload, 'attachment.chunk')
    const upload = this.#owned(deviceId, requireString(record, 'uploadId', 'attachment.chunk'))
    const offset = record['offset']
    const data = record['data']
    // Bound encoded input BEFORE decoding, and reject Buffer's permissive base64 variants.
    if (typeof data !== 'string' || data.length === 0 || data.length > Math.ceil(CHUNK_BYTES / 3) * 4 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) ||
        typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
      throw new MethodError('MALFORMED_FRAME', 'chunk requires a valid offset and bounded canonical base64')
    }
    return this.#locked(upload, async () => {
      await this.#live(upload)
      const buffer = Buffer.from(data, 'base64')
      if (buffer.length > CHUNK_BYTES || buffer.toString('base64') !== data) {
        throw new MethodError('MALFORMED_FRAME', 'chunk is not canonical base64 or exceeds chunkBytes')
      }
      const digest = createHash('sha256').update(buffer).digest('hex')
      if (upload.last?.offset === offset && upload.last.bytes === buffer.length && upload.last.digest === digest) {
        return { offset: upload.offset }
      }
      if (upload.ready || offset !== upload.offset) throw new MethodError('UPLOAD_OFFSET_MISMATCH', 'chunk is not the next expected offset')
      if (offset + buffer.length > upload.bytes) throw new MethodError('UPLOAD_TOO_LARGE', 'chunk exceeds the declared upload size')
      try {
        let written = 0
        while (written < buffer.length) {
          const result = await upload.handle.write(buffer, written, buffer.length - written, offset + written)
          if (!result.bytesWritten) throw new Error('short write')
          written += result.bytesWritten
        }
      } catch (cause) {
        await this.#retire(upload)
        throw new MethodError('REMOTE_ERROR', 'attachment staging write failed; start a new upload', cause)
      }
      upload.hash.update(buffer)
      if (upload.prefix.length < 16) upload.prefix = Buffer.concat([upload.prefix, buffer.subarray(0, 16 - upload.prefix.length)])
      upload.last = { offset, bytes: buffer.length, digest }
      upload.offset += buffer.length
      return { offset: upload.offset }
    })
  }

  async finish(deviceId: string, payload: unknown): Promise<AttachmentInfo> {
    const upload = this.#owned(deviceId, requireString(payload, 'uploadId', 'attachment.finish'))
    return this.#locked(upload, async () => {
      await this.#live(upload)
      if (upload.ready) return { ...upload.ready }
      if (upload.offset !== upload.bytes) throw new MethodError('UPLOAD_INTEGRITY', 'upload is incomplete')
      if ((await upload.handle.stat()).size !== upload.bytes || upload.hash.copy().digest('hex') !== upload.sha256) {
        await this.#retire(upload)
        throw new MethodError('UPLOAD_INTEGRITY', 'attachment length or SHA-256 verification failed; start a new upload')
      }
      // Re-read the actual stored bytes too, rather than trusting only the hash
      // accumulated before filesystem writes. Reads remain bounded to chunkBytes.
      try {
        for await (const _ of this.#read(upload)) { /* verifies bytes on disk */ }
      } catch (cause) {
        await this.#retire(upload)
        throw new MethodError('UPLOAD_INTEGRITY', 'stored attachment failed integrity verification', cause)
      }
      if (upload.kind === 'image' && !matchesSignature(upload.prefix, upload.mediaType!)) {
        await this.#retire(upload)
        throw new MethodError('ATTACHMENT_INVALID', 'image bytes do not match the declared media type')
      }
      upload.ready = {
        attachmentId: randomUUID(), name: upload.name, bytes: upload.bytes, kind: upload.kind,
        ...(upload.mediaType ? { mediaType: upload.mediaType } : {}),
      }
      this.#attachments.set(upload.ready.attachmentId, upload)
      return { ...upload.ready }
    })
  }

  async abort(deviceId: string, payload: unknown): Promise<{ aborted: true }> {
    this.#assertOpen()
    const id = requireString(payload, 'uploadId', 'attachment.abort')
    const upload = this.#uploads.get(id)
    if (!upload) return { aborted: true }
    if (upload.deviceId !== deviceId) throw new MethodError('UPLOAD_NOT_FOUND', 'upload not found')
    await this.#locked(upload, () => this.#retire(upload))
    return { aborted: true }
  }

  /** Once DSH has durably accepted a prompt, its staging copy is no longer needed.
   * Keep failed admissions intact; successful replay is owned by the bridge ledger. */
  async releaseAccepted(deviceId: string, sessionId: string, ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const upload = this.#attachments.get(id)
      if (upload?.deviceId === deviceId && upload.sessionId === sessionId) {
        await this.#locked(upload, () => this.#retire(upload), true)
      }
    }
  }

  /** Pin all referenced files until DSH admission finishes; sorted lock order prevents deadlock. */
  async withReady<T>(deviceId: string, sessionId: string, ids: readonly string[], use: (items: ReadyAttachment[]) => Promise<T>): Promise<T> {
    this.#assertOpen()
    if (ids.length === 0 || ids.length > 5 || new Set(ids).size !== ids.length) {
      throw new MethodError('ATTACHMENT_INVALID', 'prompt requires 1-5 distinct attachment IDs')
    }
    const uploads = ids.map((id) => {
      const upload = this.#attachments.get(id)
      if (!upload || upload.deviceId !== deviceId || upload.sessionId !== sessionId || upload.retired) {
        throw new MethodError('ATTACHMENT_INVALID', 'attachment is not ready or does not belong to this device and session')
      }
      return upload
    })
    const sorted = [...uploads].sort((a, b) => a.uploadId.localeCompare(b.uploadId))
    const lock = (index: number): Promise<T> => {
      const upload = sorted[index]
      if (!upload) return use(uploads.map((item) => this.#reader(item)))
      return this.#locked(upload, async () => { await this.#live(upload); return lock(index + 1) })
    }
    return lock(0)
  }

  #reader(upload: Upload): ReadyAttachment {
    const store = this
    return {
      info: { ...upload.ready! },
      async imageData() {
        if (upload.kind !== 'image') throw new MethodError('ATTACHMENT_INVALID', 'not an image')
        const parts: Buffer[] = []
        for await (const chunk of store.#read(upload, store.signal)) parts.push(chunk)
        return Buffer.concat(parts, upload.bytes).toString('base64')
      },
      stream(signal) { return store.#read(upload, signal) },
    }
  }

  async *#read(upload: Upload, signal?: AbortSignal): AsyncIterable<Buffer> {
    if ((await upload.handle.stat()).size !== upload.bytes) throw new MethodError('UPLOAD_INTEGRITY', 'staged attachment length changed')
    const digest = createHash('sha256')
    let offset = 0
    while (offset < upload.bytes) {
      this.signal.throwIfAborted()
      signal?.throwIfAborted()
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, upload.bytes - offset))
      const { bytesRead } = await upload.handle.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) throw new MethodError('UPLOAD_INTEGRITY', 'staged attachment was truncated')
      offset += bytesRead
      digest.update(buffer.subarray(0, bytesRead))
      yield buffer.subarray(0, bytesRead)
    }
    if (digest.digest('hex') !== upload.sha256) throw new MethodError('UPLOAD_INTEGRITY', 'staged attachment SHA-256 changed')
  }

  #assertOpen(): void {
    if (this.#closed) throw new MethodError('REMOTE_ERROR', 'attachment service is stopping')
  }

  #owned(deviceId: string, id: string): Upload {
    this.#assertOpen()
    const upload = this.#uploads.get(id)
    if (!upload || upload.deviceId !== deviceId || upload.retired) throw new MethodError('UPLOAD_NOT_FOUND', 'upload not found')
    return upload
  }

  async #live(upload: Upload): Promise<void> {
    this.#assertOpen()
    if (upload.retired) throw new MethodError('UPLOAD_NOT_FOUND', 'upload not found')
    if (upload.expiresAt <= this.#options.now()) {
      await this.#retire(upload)
      throw new MethodError('UPLOAD_EXPIRED', 'attachment expired; select or upload it again')
    }
  }

  #locked<T>(upload: Upload, work: () => Promise<T>, maintenance = false): Promise<T> {
    if (!maintenance && upload.queued >= 8) return Promise.reject(new MethodError('UPLOAD_LIMIT_REACHED', 'too many pending operations for this upload'))
    upload.queued++
    const next = upload.tail.then(work)
    upload.tail = next.catch(() => {})
    return next.finally(() => { upload.queued-- })
  }

  async #retire(upload: Upload): Promise<void> {
    upload.retired = true
    if (upload.ready) this.#attachments.delete(upload.ready.attachmentId)
    try {
      await upload.handle.close()
      await unlink(upload.path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      if (this.#uploads.delete(upload.uploadId)) this.#reservedBytes -= upload.bytes
    } catch {
      // Keep the reservation until cleanup can really remove the file; disk errors
      // must not turn repeated abort/begin into unbounded leaked disk usage.
      this.#options.log('attachment file cleanup failed; will retry')
    }
  }

  cleanup(): Promise<void> {
    if (this.#cleanup) return this.#cleanup
    this.#cleanup = (async () => {
      for (const upload of this.#uploads.values()) {
        if (upload.retired || upload.expiresAt <= this.#options.now()) {
          await this.#locked(upload, () => this.#retire(upload), true)
        }
      }
    })().finally(() => { this.#cleanup = undefined })
    return this.#cleanup
  }

  dispose(): Promise<void> {
    if (this.#dispose) return this.#dispose
    this.#closed = true
    this.#controller.abort()
    clearInterval(this.#timer)
    this.#dispose = (async () => {
      await this.#beginTail
      await this.#cleanup
      for (const upload of this.#uploads.values()) await this.#locked(upload, () => this.#retire(upload), true)
      // This exact random root was created by us, never received from a client.
      await rm(this.#root, { recursive: true, force: true })
      this.#uploads.clear()
      this.#attachments.clear()
      this.#reservedBytes = 0
    })()
    return this.#dispose
  }
}
