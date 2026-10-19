/** Attachment RPCs and replay-safe admission into DSH's real prompt/file services. */
import { createHash } from 'node:crypto'
import type { Context, SessionId } from '../dsh.js'
import { MethodError, optionalString, requireObject, requireString } from '../bridge/method-error.js'
import { promptSession, type PromptResult, type PromptPart } from '../bridge/sessions.js'
import { boundedId, UploadStore } from './store.js'
import { optionalService } from './services.js'

interface PromptOptions {
  sessionId: string
  text: string
  mode: 'queue' | 'steer'
  requestId?: string
  clientTimeZone?: string
}
interface Admission {
  readonly deviceId: string
  readonly fingerprint: string
  readonly expiresAt: number
  readonly receipts: Map<string, string>
  pending?: Promise<PromptResult>
  result?: PromptResult
}

/** One instance per plugin mount. Reconnection does not discard uploads or request identity. */
export class AttachmentBridge {
  readonly #ctx: Context
  readonly #admissions = new Map<string, Admission>()
  readonly #busyDevices = new Set<string>()
  readonly #now: () => number
  readonly #timer: ReturnType<typeof setInterval>
  #closed = false

  constructor(ctx: Context, readonly uploads: UploadStore, now = Date.now) {
    this.#ctx = ctx
    this.#now = now
    this.#timer = setInterval(() => this.#prune(), 60_000)
    this.#timer.unref?.()
  }

  capabilities(): unknown {
    this.#available()
    return this.uploads.capabilities
  }

  async begin(deviceId: string, payload: unknown): Promise<unknown> {
    this.#available()
    return this.uploads.begin(deviceId, payload)
  }

  #available(): Context['fileUploads'] {
    if (this.#closed) throw new MethodError('REMOTE_ERROR', 'attachment service is stopping')
    const service = optionalService(this.#ctx, 'fileUploads')
    if (typeof service?.uploadStream !== 'function') {
      throw new MethodError('NOT_IMPLEMENTED', 'this DSH composition has no streamed file-upload service')
    }
    return service
  }

  async prompt(deviceId: string, payload: unknown, mode: 'queue' | 'steer'): Promise<PromptResult> {
    const record = requireObject(payload, 'session.prompt')
    const sessionId = requireString(record, 'sessionId', 'session.prompt')
    const raw = record['attachments']
    if (raw !== undefined && (!Array.isArray(raw) || raw.length > 5 ||
        raw.some((id) => typeof id !== 'string' || id.length === 0 || id.length > 256) || new Set(raw).size !== raw.length)) {
      throw new MethodError('ATTACHMENT_INVALID', 'attachments must be at most five distinct opaque IDs')
    }
    const ids = (raw ?? []) as string[]
    if (this.#closed) throw new MethodError('REMOTE_ERROR', 'attachment service is stopping')
    this.#prune()
    if (!ids.length) {
      // Preserve the original text client's optional-field semantics and throughput.
      // Only a key already reserved by an attachment admission is ours to police.
      const text = requireString(record, 'text', 'session.prompt')
      const requestId = optionalString(record, 'requestId')
      const existing = requestId ? this.#admissions.get(JSON.stringify([sessionId, requestId])) : undefined
      if (existing) throw new MethodError('ATTACHMENT_INVALID', 'requestId was already used with attached prompt content')
      return promptSession(this.#ctx, {
        sessionId, text, mode, requestId,
        clientTimeZone: optionalString(record, 'clientTimeZone'),
      })
    }
    boundedId(sessionId, 'sessionId')
    const text = record['text']
    if (typeof text !== 'string' || (text === '' && ids.length === 0)) {
      throw new MethodError('MALFORMED_FRAME', 'session.prompt requires text, or an empty string with attachments')
    }
    // Match the listener's frame bound even when a handler is called in process.
    if (Buffer.byteLength(text, 'utf8') > 512 * 1024) throw new MethodError('MALFORMED_FRAME', 'prompt text is too long')
    const requestId = record['requestId'] === undefined ? undefined : boundedId(record['requestId'], 'requestId')
    if (ids.length && !requestId) throw new MethodError('MALFORMED_FRAME', 'attached prompts require a stable requestId')
    const clientTimeZone = record['clientTimeZone'] === undefined ? undefined : boundedId(record['clientTimeZone'], 'clientTimeZone')
    const options: PromptOptions = { sessionId, text, mode, requestId, clientTimeZone }
    // DSH keys requests by session, not device. Never let a different device reuse
    // an in-memory key and accidentally get the original device's acceptance.
    const key = JSON.stringify([sessionId, requestId])
    const fingerprint = createHash('sha256').update(JSON.stringify([deviceId, sessionId, text, mode, clientTimeZone ?? null, ids])).digest('hex')
    let admission = this.#admissions.get(key)
    if (admission) {
      if (admission.deviceId !== deviceId || admission.fingerprint !== fingerprint) {
        throw new MethodError('ATTACHMENT_INVALID', 'requestId was already used with different prompt content')
      }
      if (admission.result) return { ...admission.result }
      if (admission.pending) return admission.pending
    } else {
      if (this.#admissions.size >= 1000 || [...this.#admissions.values()].filter((item) => item.deviceId === deviceId).length >= 100) {
        throw new MethodError('UPLOAD_LIMIT_REACHED', 'prompt replay ledger is full; wait for expiry')
      }
      admission = { deviceId, fingerprint, receipts: new Map(), expiresAt: this.#now() + 30 * 60 * 1000 }
      this.#admissions.set(key, admission)
    }
    const current = admission
    // Limit simultaneous base64 image admission: staging is streamed, whereas DSH's
    // image prompt contract necessarily materializes bounded base64 strings.
    if (ids.length && (this.#busyDevices.has(deviceId) || this.#busyDevices.size >= 2)) {
      throw new MethodError('UPLOAD_LIMIT_REACHED', 'another attached prompt is being admitted; retry this same requestId')
    }
    if (ids.length) this.#busyDevices.add(deviceId)
    current.pending = (async () => {
      const fileUploads = this.#available()
      return this.uploads.withReady(deviceId, sessionId, ids, async (items) => {
        const parts: PromptPart[] = []
        for (const item of items) {
          if (item.info.kind === 'image') {
            parts.push({ type: 'image', mediaType: item.info.mediaType!, data: await item.imageData(), name: item.info.name })
          } else {
            let receiptId = current.receipts.get(item.info.attachmentId)
            if (!receiptId) {
              // The phone never supplies a receipt or a host path. Only the receipt
              // returned by DSH for this exact Session is allowed into the prompt.
              const signal = AbortSignal.any([this.uploads.signal, AbortSignal.timeout(60_000)])
              const value = await fileUploads.uploadStream({
                sessionId: sessionId as SessionId,
                data: item.stream(signal), signal, name: item.info.name,
              })
              if (typeof value?.receiptId !== 'string' || value.receiptId === '') {
                throw new MethodError('REMOTE_ERROR', 'DSH file upload returned no receipt')
              }
              receiptId = value.receiptId
              current.receipts.set(item.info.attachmentId, receiptId)
            }
            parts.push({ type: 'file', receiptId })
          }
        }
        return promptSession(this.#ctx, { ...options, attachmentParts: parts, signal: this.uploads.signal })
      })
    })().then(async (result) => {
      // Record success first: cleanup must never turn a durably accepted prompt
      // into an apparent failure. Replays return this result without ready files.
      current.result = result
      await this.uploads.releaseAccepted(deviceId, sessionId, ids).catch(() => {
        // The store logs deletion failures and retains failed reservations for TTL cleanup.
      })
      return { ...result }
    }).finally(() => {
      current.pending = undefined
      if (ids.length) this.#busyDevices.delete(deviceId)
    })
    return current.pending
  }

  #prune(): void {
    for (const [key, value] of this.#admissions) {
      if (!value.pending && value.expiresAt <= this.#now()) this.#admissions.delete(key)
    }
  }

  async dispose(): Promise<void> {
    this.#closed = true
    clearInterval(this.#timer)
    await this.uploads.dispose()
    this.#admissions.clear()
  }
}
