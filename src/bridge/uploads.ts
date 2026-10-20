/**
 * Attachment staging.
 *
 * The phone cannot send a photo or a document in one frame: iOS's websocket
 * refuses a message over a mebibyte and *closes the connection* when one
 * arrives, and a 10 MiB photo is four times that before base64 makes it larger
 * still. So an attachment is uploaded in 128 KiB chunks, assembled here, and
 * referred to afterwards by an opaque id.
 *
 * Four deliberate choices:
 *
 *   - **Everything is bound to the connection's device and the session it named.**
 *     The device id comes from the authenticated socket, never from the payload;
 *     an upload begun by one phone cannot be finished, aborted or attached to a
 *     prompt by another, and an attachment finished for one conversation cannot
 *     be used in a different one. A wrong device or session is answered exactly
 *     like an unknown id, because "that upload exists but is not yours" is not
 *     something a client can act on.
 *   - **Chunks are written at their index, not appended.** That is what makes a
 *     retried chunk idempotent: the bytes land where they already are, and a
 *     chunk whose index was already accepted is compared against what is on
 *     disk rather than appended again. A different payload for the same index
 *     is a bad chunk, not a quiet overwrite.
 *   - **Canonical base64 only.** Node's decoder silently skips characters, so
 *     `Buffer.from(x, 'base64')` accepts text that is not base64 at all. Every
 *     chunk is decoded and re-encoded, and anything that does not round-trip
 *     byte for byte is refused -- otherwise a client encoding bug becomes a
 *     truncated file with nothing in the log to say why.
 *   - **Everything expires.** The bytes are temporary: an upload dies 30
 *     minutes after it began and a finished attachment 30 minutes after it was
 *     finished, and retries do not extend either. A phone that uploads and then
 *     loses its connection must not leave a 32 MiB file on the desktop forever,
 *     and a prompt that refers to an expired attachment is told so rather than
 *     silently sending nothing.
 *   - **The staging area is private and bounded.** The roots are secured for
 *     the current user only before the first byte lands (fail-closed), the
 *     bytes declared at `upload.begin` reserve a global budget, and the count
 *     of live uploads is capped globally and per device — one runaway phone
 *     cannot starve the desktop or its peers.
 *   - **What arrives is what was declared.** When the client declares a
 *     SHA-256 at `upload.begin`, `finish` verifies it against a full re-read
 *     of the stored bytes, and an image is checked against its declared media
 *     type's signature — a mislabeled or corrupted file is refused here
 *     instead of by the model minutes later.
 *
 * Only files stage here. Images are assembled by the session bridge into inline
 * base64 prompt parts (see `bridge/sessions.ts`), so a photograph never needs a
 * receipt; documents go through the host's `fileUploads` service when the
 * composition has one, and are saved under `<stateDir>/attachments` otherwise.
 *
 * @module dsh-mizar/bridge/uploads
 */
import { createHash, randomUUID } from 'node:crypto'
import {
  copyFile,
  mkdir,
  open,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { basename, join } from 'node:path'
import { MethodError, requireObject, requireString } from './method-error.js'
import { makePrivateDirectory } from './private-directory.js'

/** Bytes per upload chunk. The app sends exactly this except for the last one. */
export const CHUNK_BYTES = 128 * 1024

/** How long an upload or a finished attachment is kept, in milliseconds. */
export const UPLOAD_TTL_MS = 30 * 60 * 1000

/** The size and count limits the protocol documents. */
export const UPLOAD_LIMITS = {
  /** Largest image, in bytes. */
  imageBytes: 10 * 1024 * 1024,
  /** Largest file, in bytes. */
  fileBytes: 32 * 1024 * 1024,
  /** Largest total of all attachments in one prompt, in bytes. */
  promptBytes: 64 * 1024 * 1024,
  /** Most attachments one prompt may carry. */
  attachments: 8,
  /** Most images one prompt may carry. */
  images: 4,
} as const

/**
 * Resource quotas the staging area enforces on top of the documented limits.
 *
 * The per-prompt limits bound one message; these bound the desktop. Ported
 * from XEPX2's PR #2. `reservedBytes` is the sum of what live uploads have
 * declared; the reservation ends when the upload completes (its bytes then
 * become an attachment, bounded at prompt time) or expires.
 */
export const UPLOAD_QUOTAS = {
  /** Largest total of declared-but-unreceived bytes across all live uploads. */
  reservedBytes: 200 * 1024 * 1024,
  /** Most uploads in flight, across every device. */
  active: 100,
  /** Most uploads in flight for one device. */
  perDevice: 10,
} as const

/**
 * Media types DSH accepts as image content.
 *
 * The durable prompt format is a raster image block, so anything else is not an
 * image as far as the model is concerned. Refusing at `upload.begin` costs the
 * phone one clear error; accepting and then failing at prompt time would cost it
 * an upload of up to 10 MiB first.
 */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const

/** Whether an upload is a photograph or a document. */
export type UploadKind = 'image' | 'file'

/** Longest accepted display name, matching common filesystem limits. */
const MAX_NAME_CHARS = 255

/** `upload.begin` arguments after validation. */
export interface UploadBeginRequest {
  readonly sessionId: string
  readonly kind: UploadKind
  readonly name: string
  readonly mediaType: string
  readonly byteSize: number
  /** Lowercase hex SHA-256 of the full payload, when the client declares it. */
  readonly sha256?: string
}

/** `upload.chunk` arguments after validation. */
export interface UploadChunkRequest {
  readonly uploadId: string
  readonly index: number
  /** Canonical base64. */
  readonly data: string
}

/** What `upload.begin` answers. */
export interface UploadBeginResult {
  readonly uploadId: string
  readonly chunkBytes: number
}

/** What `upload.finish` answers. */
export interface UploadFinishResult {
  readonly attachmentId: string
  readonly kind: UploadKind
  readonly name: string
  readonly mediaType: string
  readonly byteSize: number
}

/** What `upload.capabilities` answers. */
export interface UploadCapabilities {
  readonly chunkBytes: number
  readonly imageBytes: number
  readonly fileBytes: number
  readonly promptBytes: number
  readonly attachments: number
  readonly images: number
  readonly expiresSeconds: number
  readonly imageMediaTypes: readonly string[]
  /** Whether the host verifies a client-declared SHA-256. */
  readonly sha256: boolean
}

/**
 * One finished upload, as the session bridge consumes it.
 *
 * `path` is where the staged bytes are; it disappears with the TTL, so a caller
 * that needs the file to outlive the staging area (the no-`fileUploads`
 * fallback) must call {@link saveFallback} instead of keeping the path.
 */
export interface PromptAttachment {
  readonly attachmentId: string
  readonly kind: UploadKind
  readonly name: string
  readonly mediaType: string
  readonly byteSize: number
  /** Absolute path to the staged bytes. */
  readonly path: string
  /**
   * Copy the bytes under `<stateDir>/attachments` and return the durable path.
   *
   * Used only when the host has no `fileUploads` service: the prompt then names
   * the saved file instead of a receipt, and the path must not be deleted when
   * the staging area is cleaned up.
   */
  saveFallback(): Promise<string>
}

/** What the store needs to know about where to put things. */
export interface UploadStoreOptions {
  /** `<stateDir>/uploads`; one directory per upload beneath it. */
  readonly root: string
  /** `<stateDir>/attachments`; where fallback copies go. */
  readonly attachmentsRoot: string
  /** Overridable for tests and for a deployment that wants a shorter TTL. */
  readonly ttlMs?: number
  /** Chunk size override, used by tests to keep fixtures small. */
  readonly chunkBytes?: number
  /** Clock override, used by tests to age an upload without sleeping. */
  readonly now?: () => number
  /** Largest total of declared bytes across live uploads (tests shrink this). */
  readonly maxReservedBytes?: number
  /** Most uploads in flight across every device (tests shrink this). */
  readonly maxActiveUploads?: number
  /** Most uploads in flight for one device (tests shrink this). */
  readonly maxDeviceUploads?: number
  /**
   * Whether `begin` secures the staging roots before writing (tests pass
   * `false` so a hundred cases do not each spawn the ACL tooling; the real
   * behavior has its own test).
   */
  readonly secureRoots?: boolean
}

/** One chunked upload being assembled. */
interface UploadRecord {
  readonly uploadId: string
  readonly deviceId: string
  readonly sessionId: string
  readonly kind: UploadKind
  readonly name: string
  readonly mediaType: string
  readonly byteSize: number
  /** The digest the client declared at `begin`, when it declared one. */
  readonly sha256?: string
  readonly dir: string
  /** Bytes written so far; equal to `byteSize` at completion. */
  receivedBytes: number
  /** Chunks accepted so far, which is the index of the next expected chunk. */
  receivedChunks: number
  /** When the upload dies, epoch milliseconds; retries do not extend it. */
  expiresAt: number
}

/** One finished upload that a prompt may refer to. */
interface AttachmentRecord {
  readonly attachmentId: string
  readonly uploadId: string
  readonly deviceId: string
  readonly sessionId: string
  readonly kind: UploadKind
  readonly name: string
  readonly mediaType: string
  readonly byteSize: number
  readonly dir: string
  readonly expiresAt: number
}

/**
 * The canonical base64 of a chunk, or a `UPLOAD_BAD_CHUNK` refusal.
 *
 * Both halves matter: the alphabet check rejects text that is not base64, and
 * the round-trip rejects base64 Node can decode but that is not the canonical
 * spelling of those bytes (`AAA` without padding, or an embedded newline).
 *
 * @param data - the chunk payload as sent.
 * @returns the decoded bytes.
 * @throws MethodError when the string is not canonical base64.
 */
function decodeChunk(data: string): Buffer {
  const reject = (reason: string): never => {
    throw new MethodError('UPLOAD_BAD_CHUNK', `upload.chunk: payload."data" ${reason}`)
  }
  if (data === '') reject('must not be empty')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data)) reject('must be base64 without whitespace or padding other than "="')
  const bytes = Buffer.from(data, 'base64')
  if (bytes.toString('base64') !== data) reject('must be canonical base64 (padding and alphabet exact)')
  return bytes
}

/**
 * Whether a buffer's leading bytes carry the file signature of a media type.
 *
 * Only image media types have signatures here, and only the four the protocol
 * documents. Each type needs its own minimum to be recognisable at all — a
 * file too short to carry its declared signature is refused, not waved through.
 *
 * @param prefix - up to the first 16 bytes of the payload.
 * @param filled - how many bytes of `prefix` were actually read.
 * @param mediaType - the declared image media type.
 * @returns whether the bytes match the declared type.
 */
function signatureMatches(prefix: Buffer, filled: number, mediaType: string): boolean {
  switch (mediaType) {
    case 'image/png':
      return filled >= 8 && prefix.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    case 'image/jpeg':
      return filled >= 3 && prefix[0] === 0xff && prefix[1] === 0xd8 && prefix[2] === 0xff
    case 'image/gif':
      return filled >= 6 && (prefix.subarray(0, 6).toString('latin1') === 'GIF87a' || prefix.subarray(0, 6).toString('latin1') === 'GIF89a')
    case 'image/webp':
      return filled >= 12 && prefix.subarray(0, 4).toString('latin1') === 'RIFF' && prefix.subarray(8, 12).toString('latin1') === 'WEBP'
    default:
      return true
  }
}

/**
 * Read `upload.begin`'s payload.
 *
 * The bytes are not validated here (only the shape is): whether the length is
 * allowed depends on the kind, which is `UploadStore.begin`'s answer to give so
 * that the code is `UPLOAD_TOO_LARGE` rather than a generic malformed frame.
 *
 * @param payload - the request payload.
 * @returns the parsed arguments.
 * @throws MethodError when the payload is not an object or a field is unusable.
 */
export function parseUploadBegin(payload: unknown): UploadBeginRequest {
  const record = requireObject(payload, 'upload.begin')
  const sessionId = requireString(payload, 'sessionId', 'upload.begin')
  const kind = record['kind']
  if (kind !== 'image' && kind !== 'file') {
    throw new MethodError(
      'MALFORMED_FRAME',
      'upload.begin: payload."kind" must be "image" or "file"',
    )
  }
  const name = requireString(payload, 'name', 'upload.begin')
  if (name.length > MAX_NAME_CHARS) {
    throw new MethodError(
      'MALFORMED_FRAME',
      `upload.begin: payload."name" must be at most ${MAX_NAME_CHARS} characters`,
    )
  }
  if (/[\u0000-\u001f\u007f]/.test(name)) {
    throw new MethodError('MALFORMED_FRAME', 'upload.begin: payload."name" contains a control character')
  }
  // Direction overrides and isolates are never legitimate in a file name: they
  // exist to make "evil.pdf" render as "fdp.live". Refused here so every
  // client sees the same rule; the fallback saver strips them regardless.
  if (/[\u061c\u202a-\u202e\u2066-\u2069]/.test(name)) {
    throw new MethodError(
      'MALFORMED_FRAME',
      'upload.begin: payload."name" contains a bidirectional formatting character',
    )
  }
  const mediaType = requireString(payload, 'mediaType', 'upload.begin')
  if (mediaType.length > MAX_NAME_CHARS) {
    throw new MethodError(
      'MALFORMED_FRAME',
      `upload.begin: payload."mediaType" must be at most ${MAX_NAME_CHARS} characters`,
    )
  }
  const byteSize = record['byteSize']
  if (typeof byteSize !== 'number' || !Number.isInteger(byteSize) || byteSize <= 0) {
    throw new MethodError(
      'MALFORMED_FRAME',
      'upload.begin: payload."byteSize" must be a positive integer',
    )
  }
  const sha256 = record['sha256']
  if (sha256 !== undefined && (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256))) {
    throw new MethodError(
      'MALFORMED_FRAME',
      'upload.begin: payload."sha256" must be the lowercase hex SHA-256 of the payload',
    )
  }
  return { sessionId, kind, name, mediaType, byteSize, ...(sha256 === undefined ? {} : { sha256 }) }
}

/**
 * Read `upload.chunk`'s payload.
 *
 * `data` is checked for *type* here and for canonical base64 in the store, so a
 * client bug reports `UPLOAD_BAD_CHUNK` with the chunk's own vocabulary.
 *
 * @param payload - the request payload.
 * @returns the parsed arguments.
 * @throws MethodError when the payload is not an object or a field is unusable.
 */
export function parseUploadChunk(payload: unknown): UploadChunkRequest {
  const record = requireObject(payload, 'upload.chunk')
  const uploadId = requireString(payload, 'uploadId', 'upload.chunk')
  const index = record['index']
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
    throw new MethodError(
      'MALFORMED_FRAME',
      'upload.chunk: payload."index" must be a non-negative integer',
    )
  }
  const data = record['data']
  if (typeof data !== 'string') {
    throw new MethodError('MALFORMED_FRAME', 'upload.chunk: payload."data" must be a base64 string')
  }
  return { uploadId, index, data }
}

/**
 * Enforce the per-prompt size and count limits.
 *
 * A separate function because three places need the same answer: the store when
 * a prompt names attachments, the bridge before it builds content parts, and the
 * tests that pin the numbers. It is about the *declared* metadata only -- the
 * bytes themselves were already bounded at `upload.begin`.
 *
 * @param attachments - what the prompt would carry.
 * @throws MethodError with `ATTACHMENT_TOO_LARGE` when any limit is exceeded.
 */
export function enforcePromptLimits(
  attachments: readonly {
    readonly kind: UploadKind
    readonly byteSize: number
    readonly name?: string
  }[],
): void {
  if (attachments.length > UPLOAD_LIMITS.attachments) {
    throw new MethodError(
      'ATTACHMENT_TOO_LARGE',
      `session.prompt: ${attachments.length} attachments, at most ${UPLOAD_LIMITS.attachments} are allowed`,
    )
  }
  let images = 0
  let total = 0
  for (const attachment of attachments) {
    total += attachment.byteSize
    if (attachment.kind === 'image') {
      images += 1
      if (attachment.byteSize > UPLOAD_LIMITS.imageBytes) {
        throw new MethodError(
          'ATTACHMENT_TOO_LARGE',
          `session.prompt: image "${attachment.name ?? ''}" is ${attachment.byteSize} bytes, ` +
            `the limit is ${UPLOAD_LIMITS.imageBytes}`,
        )
      }
    } else if (attachment.byteSize > UPLOAD_LIMITS.fileBytes) {
      throw new MethodError(
        'ATTACHMENT_TOO_LARGE',
        `session.prompt: file is ${attachment.byteSize} bytes, the limit is ${UPLOAD_LIMITS.fileBytes}`,
      )
    }
  }
  if (images > UPLOAD_LIMITS.images) {
    throw new MethodError(
      'ATTACHMENT_TOO_LARGE',
      `session.prompt: ${images} images, at most ${UPLOAD_LIMITS.images} are allowed`,
    )
  }
  if (total > UPLOAD_LIMITS.promptBytes) {
    throw new MethodError(
      'ATTACHMENT_TOO_LARGE',
      `session.prompt: ${total} bytes of attachments, the limit is ${UPLOAD_LIMITS.promptBytes}`,
    )
  }
}

/**
 * The display name of a content part's file, when it carries one.
 *
 * Durable user messages name the file on `attachment.name`; the request-shaped
 * block the client sent names it on `name`. Both are read so the summary
 * placeholder says `[File: report.pdf]` rather than `[File]` on either shape.
 *
 * @param part - one content part.
 * @returns the name, or `null` when the part carries none.
 */
export function filePartName(part: unknown): string | null {
  if (typeof part !== 'object' || part === null) return null
  const record = part as { name?: unknown; attachment?: { name?: unknown } }
  const attachmentName = record.attachment?.name
  if (typeof attachmentName === 'string' && attachmentName !== '') return attachmentName
  if (typeof record.name === 'string' && record.name !== '') return record.name
  return null
}

/**
 * Whether one upload is expired.
 * @param record - the record to test.
 * @param now - the current time.
 * @param ttlMs - the configured lifetime.
 * @returns whether the record is past its lifetime.
 */
function isExpired(record: { readonly expiresAt: number }, now: number): boolean {
  return record.expiresAt <= now
}

/**
 * A file name that is safe to create under a directory we own.
 *
 * The name came from the phone, so it is untrusted input for a path: a sender
 * that calls its file `../../state.json` must not be able to write outside the
 * directory. The leaf is taken, everything but letters, digits, dots, spaces,
 * underscores and dashes is replaced, leading dots are removed, and the result
 * is bounded. An empty result falls back to a constant.
 *
 * @param name - the display name the client sent.
 * @returns a safe file name, never empty.
 */
function safeFileName(name: string): string {
  const leaf = basename(name)
    .replace(/[^\p{L}\p{N}._ -]/gu, '_')
    .replace(/^\.+/, '')
    .trim()
  const bounded = leaf.length > 120 ? leaf.slice(-120) : leaf
  if (bounded === '') return 'attachment'
  // Windows refuses device names even as file leaves, including with digit
  // variants ("COM¹"); a leading underscore defuses them without changing
  // anything an ordinary name would notice.
  if (/^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\.|$)/i.test(bounded)) {
    return `_${bounded}`
  }
  return bounded
}

/** Render an unknown thrown value as one line. */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Assemble and remember the attachments one phone is uploading.
 *
 * The store is process-lifetime state: an upload is a conversation between one
 * socket and this process, and a restart is exactly the event that should throw
 * away the half-written bytes. The durable output of a finished attachment is
 * its receipt (or, without `fileUploads`, the fallback copy), never this map.
 *
 * Operations are serialized through one promise chain. The listener dispatches
 * each frame independently, so two chunks for one upload may be in flight at the
 * same time; serializing is what keeps the expected index, the byte count and
 * the bytes on disk in agreement.
 */
export class UploadStore {
  readonly #root: string
  readonly #attachmentsRoot: string
  readonly #ttlMs: number
  readonly #chunkBytes: number
  readonly #now: () => number
  readonly #maxReservedBytes: number
  readonly #maxActiveUploads: number
  readonly #maxDeviceUploads: number
  readonly #secureRoots: boolean
  readonly #uploads = new Map<string, UploadRecord>()
  readonly #attachments = new Map<string, AttachmentRecord>()
  #queue: Promise<unknown> = Promise.resolve()
  /** Memoized securing of the staging roots; see the #ensureSecured method. */
  #secured?: Promise<void>

  /**
   * @param options - where uploads live and how long they last.
   */
  constructor(options: UploadStoreOptions) {
    this.#root = options.root
    this.#attachmentsRoot = options.attachmentsRoot
    this.#ttlMs = options.ttlMs ?? UPLOAD_TTL_MS
    this.#chunkBytes = options.chunkBytes ?? CHUNK_BYTES
    this.#now = options.now ?? Date.now
    this.#maxReservedBytes = options.maxReservedBytes ?? UPLOAD_QUOTAS.reservedBytes
    this.#maxActiveUploads = options.maxActiveUploads ?? UPLOAD_QUOTAS.active
    this.#maxDeviceUploads = options.maxDeviceUploads ?? UPLOAD_QUOTAS.perDevice
    this.#secureRoots = options.secureRoots ?? true
  }

  /**
   * Run one operation after every operation already queued.
   * @param work - the operation.
   * @returns its result.
   */
  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(work)
    // Keep the chain alive when one operation rejects; the next caller must not
    // inherit a rejected predecessor.
    this.#queue = run.catch(() => {})
    return run
  }

  /**
   * Secure the staging roots for the current user before any byte lands.
   *
   * Ported from XEPX2's PR #2: on Windows, `mode: 0o700` cannot remove the
   * inherited grants a directory under the user profile carries, so the
   * OS-supplied PowerShell resets each root's ACL to exactly one rule for the
   * current SID and verifies the result; on POSIX a `chmod 0700` is enough.
   * The roots are plugin state under the state home, never TEMP itself, and
   * the parent is left untouched.
   *
   * Memoized and fail-closed: a failed attempt resets the memo so the next
   * operation retries, and no staging byte is created until this succeeds.
   */
  #ensureSecured(): Promise<void> {
    if (!this.#secureRoots) return Promise.resolve()
    this.#secured ??= (async () => {
      await makePrivateDirectory(this.#root)
      await makePrivateDirectory(this.#attachmentsRoot)
    })()
    const attempt = this.#secured
    void attempt.catch(() => {
      if (this.#secured === attempt) this.#secured = undefined
    })
    return attempt
  }

  /**
   * The declared-but-unreceived bytes across every live upload.
   * @returns the sum, in bytes.
   */
  #reservedBytes(): number {
    let total = 0
    for (const upload of this.#uploads.values()) total += upload.byteSize
    return total
  }

  /**
   * The limits a client should obey, as this store enforces them.
   * @returns the capability record `upload.capabilities` answers with.
   */
  capabilities(): UploadCapabilities {
    return {
      chunkBytes: this.#chunkBytes,
      imageBytes: UPLOAD_LIMITS.imageBytes,
      fileBytes: UPLOAD_LIMITS.fileBytes,
      promptBytes: UPLOAD_LIMITS.promptBytes,
      attachments: UPLOAD_LIMITS.attachments,
      images: UPLOAD_LIMITS.images,
      expiresSeconds: Math.floor(this.#ttlMs / 1000),
      imageMediaTypes: [...IMAGE_MEDIA_TYPES],
      sha256: true,
    }
  }

  /**
   * Begin one upload.
   *
   * The size is checked against the kind's limit here rather than at finish:
   * a phone that picked a 40 MiB video as a "file" learns that before sending
   * forty megabytes, and the answer names the same limit the protocol documents.
   *
   * @param deviceId - the authenticated device starting the upload.
   * @param request - the validated `upload.begin` arguments.
   * @returns the upload id and the exact chunk size to send.
   * @throws MethodError `UPLOAD_TOO_LARGE`, `ATTACHMENT_UNSUPPORTED` or `ATTACHMENT_FAILED`.
   */
  begin(deviceId: string, request: UploadBeginRequest): Promise<UploadBeginResult> {
    return this.#serialize(() => this.#begin(deviceId, request))
  }

  async #begin(deviceId: string, request: UploadBeginRequest): Promise<UploadBeginResult> {
    // Everything below writes bytes or reserves capacity, so the staging roots
    // must already be private and the quotas kept: a phone that begins a
    // hundred uploads must not pin two hundred mebibytes of desktop disk.
    await this.#sweep()
    await this.#ensureSecured()
    if (this.#uploads.size >= this.#maxActiveUploads) {
      throw new MethodError(
        'UPLOAD_LIMIT_REACHED',
        `upload.begin: ${this.#uploads.size} uploads are already in flight, the limit is ${this.#maxActiveUploads}`,
      )
    }
    const deviceUploads = [...this.#uploads.values()].filter((upload) => upload.deviceId === deviceId).length
    if (deviceUploads >= this.#maxDeviceUploads) {
      throw new MethodError(
        'UPLOAD_LIMIT_REACHED',
        `upload.begin: this device already has ${deviceUploads} uploads in flight, the limit is ${this.#maxDeviceUploads}`,
      )
    }
    if (this.#reservedBytes() + request.byteSize > this.#maxReservedBytes) {
      throw new MethodError(
        'UPLOAD_LIMIT_REACHED',
        `upload.begin: ${this.#reservedBytes() + request.byteSize} declared bytes would be reserved, the limit is ${this.#maxReservedBytes}`,
      )
    }
    if (request.kind === 'image') {
      if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(request.mediaType)) {
        throw new MethodError(
          'ATTACHMENT_UNSUPPORTED',
          `upload.begin: image media type must be one of ${IMAGE_MEDIA_TYPES.join(', ')}, got "${request.mediaType}"`,
        )
      }
      if (request.byteSize > UPLOAD_LIMITS.imageBytes) {
        throw new MethodError(
          'UPLOAD_TOO_LARGE',
          `upload.begin: image is ${request.byteSize} bytes, the limit is ${UPLOAD_LIMITS.imageBytes}`,
        )
      }
    } else {
      if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(request.mediaType)) {
        throw new MethodError(
          'ATTACHMENT_UNSUPPORTED',
          `upload.begin: file media type must be "type/subtype", got "${request.mediaType}"`,
        )
      }
      if (request.byteSize > UPLOAD_LIMITS.fileBytes) {
        throw new MethodError(
          'UPLOAD_TOO_LARGE',
          `upload.begin: file is ${request.byteSize} bytes, the limit is ${UPLOAD_LIMITS.fileBytes}`,
        )
      }
    }

    const uploadId = randomUUID()
    const dir = join(this.#root, uploadId)
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await writeFile(join(dir, 'payload'), new Uint8Array(0), { mode: 0o600 })
    } catch (error) {
      throw new MethodError(
        'ATTACHMENT_FAILED',
        `upload.begin: could not create the staging directory — ${describe(error)}`,
        error,
      )
    }

    this.#uploads.set(uploadId, {
      uploadId,
      deviceId,
      sessionId: request.sessionId,
      kind: request.kind,
      name: request.name,
      mediaType: request.mediaType,
      byteSize: request.byteSize,
      ...(request.sha256 === undefined ? {} : { sha256: request.sha256 }),
      dir,
      receivedBytes: 0,
      receivedChunks: 0,
      expiresAt: this.#now() + this.#ttlMs,
    })

    return { uploadId, chunkBytes: this.#chunkBytes }
  }

  /**
   * Accept one chunk.
   *
   * Ordering is part of the contract: the index must be the next one, or one
   * already accepted (idempotent retry). A gap cannot be repaired later because
   * the offsets are the index times the chunk size, so a chunk after a gap would
   * write at a hole that `finish` would then count as received.
   *
   * @param deviceId - the authenticated device sending the chunk.
   * @param request - the validated `upload.chunk` arguments.
   * @returns how many chunks have been received up to and including this index.
   * @throws MethodError `UPLOAD_UNKNOWN`, `UPLOAD_BAD_CHUNK`, `UPLOAD_TOO_LARGE` or `ATTACHMENT_FAILED`.
   */
  chunk(deviceId: string, request: UploadChunkRequest): Promise<{ received: number }> {
    return this.#serialize(() => this.#chunk(deviceId, request))
  }

  async #chunk(deviceId: string, request: UploadChunkRequest): Promise<{ received: number }> {
    const upload = this.#uploadFor(deviceId, request.uploadId)
    const bytes = decodeChunk(request.data)
    const { index } = request

    if (bytes.length > this.#chunkBytes) {
      throw new MethodError(
        'UPLOAD_TOO_LARGE',
        `upload.chunk: chunk ${index} is ${bytes.length} bytes, the limit is ${this.#chunkBytes}`,
      )
    }

    if (index > upload.receivedChunks) {
      throw new MethodError(
        'UPLOAD_BAD_CHUNK',
        `upload.chunk: chunk ${index} arrived before chunk ${upload.receivedChunks}; chunks must be sent in order`,
      )
    }

    const path = this.#payloadPath(upload)
    if (index < upload.receivedChunks) {
      // A retry of a chunk already accepted. The bytes are compared rather than
      // trusted: the same index with different content is a client assembling
      // two different files under one upload id, which would corrupt the result.
      await this.#expectChunk(path, index, bytes, upload)
      return { received: index + 1 }
    }

    const offset = index * this.#chunkBytes
    if (offset !== upload.receivedBytes) {
      // Only reachable if a previous chunk was short and the file is not yet
      // complete; such a chunk is refused below, so this is a safety net.
      throw new MethodError(
        'UPLOAD_BAD_CHUNK',
        `upload.chunk: chunk ${index} begins at byte ${offset}, but ${upload.receivedBytes} bytes were received`,
      )
    }
    if (upload.receivedBytes + bytes.length > upload.byteSize) {
      throw new MethodError(
        'UPLOAD_TOO_LARGE',
        `upload.chunk: ${upload.receivedBytes + bytes.length} bytes would exceed the declared ${upload.byteSize}`,
      )
    }
    // Every chunk but the last is exactly one chunk long. A short chunk in the
    // middle would make the next index ambiguous (is index N the chunk at byte
    // offset N*128 KiB, or the short one after it?), so it is refused before it
    // can put a hole in the file that finish would count as complete.
    if (
      bytes.length !== this.#chunkBytes &&
      upload.receivedBytes + bytes.length !== upload.byteSize
    ) {
      throw new MethodError(
        'UPLOAD_BAD_CHUNK',
        `upload.chunk: chunk ${index} is ${bytes.length} bytes; all but the last must be ${this.#chunkBytes}`,
      )
    }

    try {
      const handle = await open(path, 'r+')
      try {
        await handle.write(bytes, 0, bytes.length, offset)
      } finally {
        await handle.close()
      }
    } catch (error) {
      throw new MethodError(
        'ATTACHMENT_FAILED',
        `upload.chunk: could not write chunk ${index} — ${describe(error)}`,
        error,
      )
    }

    upload.receivedBytes += bytes.length
    upload.receivedChunks += 1
    return { received: upload.receivedChunks }
  }

  /**
   * Check that a retried chunk carries the bytes already stored for its index.
   * @param path - the payload path.
   * @param index - the chunk index being retried.
   * @param bytes - the bytes the client sent again.
   * @param upload - the upload being assembled.
   * @throws MethodError `UPLOAD_BAD_CHUNK` when the bytes differ or are unusable.
   */
  async #expectChunk(
    path: string,
    index: number,
    bytes: Buffer,
    upload: UploadRecord,
  ): Promise<void> {
    const offset = index * this.#chunkBytes
    // The stored chunk may have been the last, short one; the retry must be the
    // same length as what was stored, so read only what was actually received.
    const storedLength = Math.min(bytes.length, upload.receivedBytes - offset)
    if (storedLength !== bytes.length) {
      throw new MethodError(
        'UPLOAD_BAD_CHUNK',
        `upload.chunk: chunk ${index} was already received with a different length`,
      )
    }
    const existing = Buffer.alloc(bytes.length)
    try {
      const handle = await open(path, 'r')
      try {
        const { bytesRead } = await handle.read(existing, 0, bytes.length, offset)
        if (bytesRead !== bytes.length) {
          throw new MethodError(
            'UPLOAD_BAD_CHUNK',
            `upload.chunk: chunk ${index} was already received with a different length`,
          )
        }
      } finally {
        await handle.close()
      }
    } catch (error) {
      if (error instanceof MethodError) throw error
      throw new MethodError(
        'ATTACHMENT_FAILED',
        `upload.chunk: could not verify retried chunk ${index} — ${describe(error)}`,
        error,
      )
    }
    if (!existing.equals(bytes)) {
      throw new MethodError(
        'UPLOAD_BAD_CHUNK',
        `upload.chunk: chunk ${index} was already received with different bytes`,
      )
    }
  }

  /**
   * Finish one upload and mint the attachment id a prompt refers to.
   *
   * The byte count is checked rather than the chunk count: a client that sent
   * the right chunks in a different size than declared gets `UPLOAD_INCOMPLETE`,
   * which is the same answer as a dropped tail and the same fix (send it again).
   *
   * @param deviceId - the authenticated device finishing the upload.
   * @param uploadId - the id `upload.begin` returned.
   * @returns the attachment identity.
   * @throws MethodError `UPLOAD_UNKNOWN` or `UPLOAD_INCOMPLETE`.
   */
  finish(deviceId: string, uploadId: string): Promise<UploadFinishResult> {
    return this.#serialize(() => this.#finish(deviceId, uploadId))
  }

  async #finish(deviceId: string, uploadId: string): Promise<UploadFinishResult> {
    const upload = this.#uploadFor(deviceId, uploadId)
    if (upload.receivedBytes !== upload.byteSize) {
      throw new MethodError(
        'UPLOAD_INCOMPLETE',
        `upload.finish: received ${upload.receivedBytes} of ${upload.byteSize} bytes for upload "${uploadId}"`,
      )
    }

    await this.#sweep()
    // The sweep can retire an upload whose TTL ran out between the lookup above
    // and here. Minting an attachment over a directory that was just deleted
    // would give the phone an id whose bytes are gone.
    if (!this.#uploads.has(uploadId)) {
      throw new MethodError('UPLOAD_UNKNOWN', `upload "${uploadId}" expired`)
    }

    // The bytes on disk are the truth, not the write path that produced them:
    // a declared SHA-256 is checked against a full re-read, and an image
    // against its media type's signature. A failure retires the upload — the
    // phone re-uploads rather than prompts with bytes nobody verified.
    // Ported from XEPX2's PR #2.
    await this.#verify(upload).catch((error: unknown) => {
      this.#uploads.delete(uploadId)
      void rm(upload.dir, { recursive: true, force: true }).catch(() => {})
      throw error
    })

    const attachmentId = randomUUID()
    this.#attachments.set(attachmentId, {
      attachmentId,
      uploadId: upload.uploadId,
      deviceId: upload.deviceId,
      sessionId: upload.sessionId,
      kind: upload.kind,
      name: upload.name,
      mediaType: upload.mediaType,
      byteSize: upload.byteSize,
      dir: upload.dir,
      expiresAt: this.#now() + this.#ttlMs,
    })
    this.#uploads.delete(uploadId)

    return {
      attachmentId,
      kind: upload.kind,
      name: upload.name,
      mediaType: upload.mediaType,
      byteSize: upload.byteSize,
    }
  }

  /**
   * Verify the stored bytes against what was declared, reading them back.
   *
   * Two checks, both ported from XEPX2's PR #2:
   *
   *   - when the client declared a SHA-256 at `upload.begin`, the digest of a
   *     full re-read from disk must match — the bytes on disk are the truth,
   *     not the accumulator that watched them being written;
   *   - an image's leading bytes must carry the signature of its declared
   *     media type, so a mislabeled file is refused here instead of by the
   *     model minutes later.
   *
   * @param upload - the completed upload, still live in the map.
   * @throws MethodError `UPLOAD_INTEGRITY` when a declared SHA-256 mismatches.
   * @throws MethodError `ATTACHMENT_UNSUPPORTED` when an image's signature differs.
   */
  async #verify(upload: UploadRecord): Promise<void> {
    const handle = await open(this.#payloadPath(upload), 'r')
    try {
      const digest = createHash('sha256')
      const prefix = Buffer.alloc(16)
      let prefixFilled = 0
      let offset = 0
      while (offset < upload.byteSize) {
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, upload.byteSize - offset))
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
        if (bytesRead === 0) break
        if (prefixFilled < prefix.length) {
          const take = Math.min(prefix.length - prefixFilled, bytesRead)
          buffer.copy(prefix, prefixFilled, 0, take)
          prefixFilled += take
        }
        digest.update(buffer.subarray(0, bytesRead))
        offset += bytesRead
      }
      if (upload.sha256 !== undefined && digest.digest('hex') !== upload.sha256) {
        throw new MethodError(
          'UPLOAD_INTEGRITY',
          `upload.finish: the stored bytes do not match the declared SHA-256 for upload "${upload.uploadId}"`,
        )
      }
      if (upload.kind === 'image' && !signatureMatches(prefix, prefixFilled, upload.mediaType)) {
        throw new MethodError(
          'ATTACHMENT_UNSUPPORTED',
          `upload.finish: image bytes do not carry the signature of "${upload.mediaType}"`,
        )
      }
    } finally {
      await handle.close()
    }
  }

  /**
   * Discard one unfinished upload.
   *
   * Aborting something already gone is answered as unknown rather than
   * `{aborted: true}`: a client that believes it cleaned up an upload it did not
   * is one that will not investigate a stale file. The bytes go away before the
   * answer, so the next `begin` does not see them.
   *
   * @param deviceId - the authenticated device aborting the upload.
   * @param uploadId - the upload to discard.
   * @returns the acknowledgement.
   * @throws MethodError `UPLOAD_UNKNOWN`.
   */
  abort(deviceId: string, uploadId: string): Promise<{ aborted: true }> {
    return this.#serialize(() => this.#abort(deviceId, uploadId))
  }

  async #abort(deviceId: string, uploadId: string): Promise<{ aborted: true }> {
    const upload = this.#uploadFor(deviceId, uploadId)
    this.#uploads.delete(uploadId)
    // Best effort: the record is already gone, and a directory that cannot be
    // removed now is removed by the sweep on the next begin.
    await rm(upload.dir, { recursive: true, force: true }).catch(() => {})
    return { aborted: true }
  }

  /**
   * Resolve the attachments one prompt names.
   *
   * Every id must belong to this device and this session, and still be within
   * its lifetime. The checks are deliberately indistinguishable from "unknown
   * id": the phone can only react by picking the attachment again, and knowing
   * that another device holds that id would be a fact it must not have.
   *
   * @param deviceId - the authenticated device sending the prompt.
   * @param sessionId - the session receiving the prompt.
   * @param attachmentIds - the ids from the payload, in order.
   * @returns the attachments, in the order given.
   * @throws MethodError `MALFORMED_FRAME`, `ATTACHMENT_UNKNOWN`, `ATTACHMENT_TOO_LARGE` or `ATTACHMENT_UNSUPPORTED`.
   */
  resolveForPrompt(
    deviceId: string,
    sessionId: string,
    attachmentIds: readonly string[],
  ): Promise<PromptAttachment[]> {
    return this.#serialize(() => this.#resolveForPrompt(deviceId, sessionId, attachmentIds))
  }

  async #resolveForPrompt(
    deviceId: string,
    sessionId: string,
    attachmentIds: readonly string[],
  ): Promise<PromptAttachment[]> {
    if (attachmentIds.length > UPLOAD_LIMITS.attachments) {
      throw new MethodError(
        'ATTACHMENT_TOO_LARGE',
        `session.prompt: ${attachmentIds.length} attachments, at most ${UPLOAD_LIMITS.attachments} are allowed`,
      )
    }
    const seen = new Set<string>()
    for (const attachmentId of attachmentIds) {
      if (seen.has(attachmentId)) {
        throw new MethodError(
          'MALFORMED_FRAME',
          `session.prompt: attachment "${attachmentId}" is listed more than once`,
        )
      }
      seen.add(attachmentId)
    }

    await this.#sweep()

    const attachments: PromptAttachment[] = []
    for (const attachmentId of attachmentIds) {
      const attachment = this.#attachments.get(attachmentId)
      if (
        attachment === undefined ||
        attachment.deviceId !== deviceId ||
        attachment.sessionId !== sessionId
      ) {
        throw new MethodError(
          'ATTACHMENT_UNKNOWN',
          `session.prompt: attachment "${attachmentId}" is not available for this session`,
        )
      }
      if (isExpired(attachment, this.#now())) {
        this.#attachments.delete(attachmentId)
        await rm(attachment.dir, { recursive: true, force: true }).catch(() => {})
        throw new MethodError(
          'ATTACHMENT_UNKNOWN',
          `session.prompt: attachment "${attachmentId}" expired`,
        )
      }
      if (attachment.kind === 'image') {
        if (!(IMAGE_MEDIA_TYPES as readonly string[]).includes(attachment.mediaType)) {
          throw new MethodError(
            'ATTACHMENT_UNSUPPORTED',
            `session.prompt: attachment "${attachmentId}" has media type "${attachment.mediaType}"`,
          )
        }
      } else if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(attachment.mediaType)) {
        throw new MethodError(
          'ATTACHMENT_UNSUPPORTED',
          `session.prompt: attachment "${attachmentId}" has media type "${attachment.mediaType}"`,
        )
      }
      attachments.push(this.#promptAttachment(attachment))
    }

    enforcePromptLimits(attachments)
    return attachments
  }

  /**
   * Build the caller-facing view of one finished attachment.
   * @param attachment - the record.
   * @returns the attachment, with its fallback saver bound.
   */
  #promptAttachment(attachment: AttachmentRecord): PromptAttachment {
    const path = join(attachment.dir, 'payload')
    return {
      attachmentId: attachment.attachmentId,
      kind: attachment.kind,
      name: attachment.name,
      mediaType: attachment.mediaType,
      byteSize: attachment.byteSize,
      path,
      saveFallback: () => this.#saveFallback(attachment),
    }
  }

  /**
   * Copy one attachment's bytes out of the staging area.
   *
   * The destination is `<stateDir>/attachments/<attachmentId>/<safe name>`, and
   * it is deliberately outside `<stateDir>/uploads`: the staging area is swept on
   * a timer, and the file a prompt text handle points at must outlive that.
   *
   * @param attachment - the attachment to copy.
   * @returns the absolute path of the copy.
   * @throws MethodError `ATTACHMENT_FAILED` when the copy cannot be made.
   */
  async #saveFallback(attachment: AttachmentRecord): Promise<string> {
    const dir = join(this.#attachmentsRoot, attachment.attachmentId)
    const destination = join(dir, safeFileName(attachment.name))
    try {
      await mkdir(dir, { recursive: true, mode: 0o700 })
      await copyFile(join(attachment.dir, 'payload'), destination)
      return destination
    } catch (error) {
      throw new MethodError(
        'ATTACHMENT_FAILED',
        `session.prompt: could not save file "${attachment.name}" — ${describe(error)}`,
        error,
      )
    }
  }

  /**
   * Look up one upload that belongs to this device, refusing silently-expired ones.
   *
   * @param deviceId - the authenticated device.
   * @param uploadId - the id the payload named.
   * @returns the upload.
   * @throws MethodError `UPLOAD_UNKNOWN` when it is absent, foreign or expired.
   */
  #uploadFor(deviceId: string, uploadId: string): UploadRecord {
    const upload = this.#uploads.get(uploadId)
    if (upload === undefined || upload.deviceId !== deviceId) {
      throw new MethodError('UPLOAD_UNKNOWN', `upload "${uploadId}" is unknown or belongs to another device`)
    }
    if (isExpired(upload, this.#now())) {
      this.#uploads.delete(uploadId)
      void rm(upload.dir, { recursive: true, force: true }).catch(() => {})
      throw new MethodError('UPLOAD_UNKNOWN', `upload "${uploadId}" expired`)
    }
    return upload
  }

  /**
   * The payload path of one upload.
   * @param upload - the upload.
   * @returns the path.
   */
  #payloadPath(upload: UploadRecord): string {
    return join(upload.dir, 'payload')
  }

  /**
   * Remove expired records and directories left behind by an earlier process.
   *
   * Called on the operations that are not on the hot path (`begin`, `finish`,
   * `resolveForPrompt`), not on every chunk: a 32 MiB file is 256 chunks and
   * listing the staging area 256 times would be work for nothing beyond the one
   * record that is already being looked up.
   */
  async #sweep(): Promise<void> {
    const now = this.#now()
    for (const [uploadId, upload] of this.#uploads) {
      if (isExpired(upload, now)) {
        this.#uploads.delete(uploadId)
        await rm(upload.dir, { recursive: true, force: true }).catch(() => {})
      }
    }
    const activeDirectories = new Set<string>()
    for (const attachment of this.#attachments.values()) activeDirectories.add(attachment.uploadId)
    for (const [attachmentId, attachment] of this.#attachments) {
      if (isExpired(attachment, now)) {
        this.#attachments.delete(attachmentId)
        await rm(attachment.dir, { recursive: true, force: true }).catch(() => {})
      }
    }
    for (const upload of this.#uploads.values()) activeDirectories.add(upload.uploadId)

    let entries: string[]
    try {
      entries = await readdir(this.#root)
    } catch {
      // No staging root yet: nothing to sweep.
      return
    }
    for (const entry of entries) {
      if (activeDirectories.has(entry)) continue
      const dir = join(this.#root, entry)
      try {
        // Directory timestamps do not change when a file inside is rewritten, so
        // the payload's own mtime is what says when the bytes were last touched.
        const payload = await stat(join(dir, 'payload'))
        if (now - payload.mtimeMs > this.#ttlMs) {
          await rm(dir, { recursive: true, force: true })
        }
      } catch {
        // A directory without a payload, or one that disappeared mid-sweep: both
        // are things a sweep exists to clean, not to fail on.
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
  }
}

/**
 * Refuses a `requestId` reused for a different attachment prompt.
 *
 * DSH deduplicates prompts by session and request id: the same key always
 * returns the first answer. For a text prompt that is the client's own
 * idempotency choice; for a prompt that carries attachments, the key plus the
 * content is the contract — the same retry must carry the same text, the same
 * attachments in the same order, the same mode and timezone, from the same
 * device. Anything else is either a client bug or an attempt to borrow another
 * request's acceptance, and it is refused rather than second-guessed.
 *
 * The ledger is memory-only and bounded: at most 1000 keys globally, 100 per
 * device, each forgotten 30 minutes after it was last seen — the same bounds
 * XEPX2's PR #2 chose, for the same reason: a restart is allowed to forget,
 * because DSH's own persistence is the final guard against duplicates.
 */
export class PromptReplayGuard {
  readonly #entries = new Map<string, { readonly deviceId: string; readonly fingerprint: string; seenAt: number }>()
  readonly #now: () => number

  /**
   * @param now - the clock, overridable for tests.
   */
  constructor(now: () => number = Date.now) {
    this.#now = now
  }

  /**
   * Record one attachment prompt, refusing a key reused with different content.
   *
   * @param deviceId - the authenticated device.
   * @param sessionId - the target session.
   * @param requestId - the client's idempotency key.
   * @param content - everything that makes this prompt this prompt.
   * @throws MethodError `ATTACHMENT_INVALID` when the key was seen with a
   *   different device or content.
   * @throws MethodError `UPLOAD_LIMIT_REACHED` when the ledger is full.
   */
  check(
    deviceId: string,
    sessionId: string,
    requestId: string,
    content: {
      readonly text?: string
      readonly mode: 'queue' | 'steer'
      readonly clientTimeZone?: string
      readonly attachmentIds: readonly string[]
    },
  ): void {
    this.#prune()
    const key = JSON.stringify([sessionId, requestId])
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([
          deviceId,
          sessionId,
          content.text ?? null,
          content.mode,
          content.clientTimeZone ?? null,
          content.attachmentIds,
        ]),
      )
      .digest('hex')
    const existing = this.#entries.get(key)
    if (existing !== undefined) {
      if (existing.deviceId !== deviceId || existing.fingerprint !== fingerprint) {
        throw new MethodError(
          'ATTACHMENT_INVALID',
          'session.prompt: this requestId was already used with different content or from another device',
        )
      }
      // The same request again: the ledger entry lives a little longer, so a
      // client retrying in a loop keeps getting the same answer.
      existing.seenAt = this.#now()
      return
    }
    const perDevice = [...this.#entries.values()].filter((entry) => entry.deviceId === deviceId).length
    if (this.#entries.size >= 1000 || perDevice >= 100) {
      throw new MethodError(
        'UPLOAD_LIMIT_REACHED',
        'session.prompt: the replay ledger is full; retry shortly as the oldest entries expire',
      )
    }
    this.#entries.set(key, { deviceId, fingerprint, seenAt: this.#now() })
  }

  /** Drop entries the TTL has forgotten. */
  #prune(): void {
    const now = this.#now()
    for (const [key, entry] of this.#entries) {
      if (now - entry.seenAt > UPLOAD_TTL_MS) this.#entries.delete(key)
    }
  }
}
