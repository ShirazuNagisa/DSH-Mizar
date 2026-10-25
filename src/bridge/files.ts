/**
 * Reading a delivered file off this computer, for the phone's preview page.
 *
 * The protocol had one direction for files — `upload.*`, phone to computer — and
 * a model that delivers a report produced a file the phone could name but never
 * read. This module is the other direction: `file.stat` says what a path is,
 * `file.read` returns a slice of it.
 *
 * Four decisions hold the safety of it:
 *
 *   - **The session's working directory is the fence.** A path is resolved
 *     against the session's own `cwd` (the tool that names deliverables says
 *     relative paths mean exactly that), normalised with `realpath`, and then
 *     required to sit inside the normalised root. That closes `..` and a symlink
 *     that points out of the workspace, in one check that happens *after* the
 *     filesystem has had its say.
 *   - **Outside is one answer, whatever the truth is.** A path that is not
 *     inside the workspace gets `FILE_FORBIDDEN` whether or not it exists:
 *     "there is no file there" and "there is a file you may not read" are the
 *     same sentence to anyone probing for one.
 *   - **A short list of names is refused even inside the workspace.** `.env`,
 *     private keys, `id_rsa`, npm and pip credentials. The model's output is
 *     not trustworthy input — a summary is prose, and prose can be talked into
 *     presenting `~/.ssh/id_ed25519` — so the fence is not only about
 *     directories.
 *   - **No state.** No open handles, no upload-style session, no temp copies:
 *     `file.read` is a pure function of (path, offset, length). A phone that
 *     loses its socket mid-file reconnects and asks for the next slice.
 *
 * Sizes: 32 MiB per file (the same ceiling `upload.begin` applies in the other
 * direction) and 256 KiB per slice, which is 341 KiB of base64 — under the
 * listener's 512 KiB frame budget with room for the envelope.
 *
 * @module dsh-mizar/bridge/files
 */

import { open, realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve, sep } from 'node:path'
import type { Context } from '../dsh.js'
import { MethodError, requireObject, requireString } from './method-error.js'
import { listSessions } from './sessions.js'

/** The largest file the phone may read. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024

/**
 * The largest slice one `file.read` may ask for.
 *
 * 256 KiB of bytes becomes 341 KiB of base64; the listener refuses a frame over
 * 512 KiB, and the answer still has to fit beside its envelope.
 */
export const MAX_CHUNK_BYTES = 256 * 1024

/** How long a session's working directory is remembered. */
const ROOT_TTL_MS = 5 * 60 * 1000

/**
 * The extensions the phone can draw, by the host's own opinion.
 *
 * A hint, not a gate: the app decides again on arrival, and an unknown type is
 * still readable — it just opens in whatever the phone offers.
 */
const PREVIEWABLE = new Set(['md', 'markdown', 'pdf', 'docx'])

/** Media types for the formats this feature exists for; everything else is octets. */
const MEDIA_TYPES: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

/**
 * Names refused even inside the workspace.
 *
 * Deliberately short and about credentials only: a preview page is a read of
 * whatever the model pointed at, and "whatever" must not include the operator's
 * secrets because a sentence in a summary asked for them.
 */
const DENIED_NAMES: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.mobileprovision$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.netrc$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.git-credentials$/i,
]

/** What `file.stat` answers. */
export interface FileStatResult {
  /** The path as the request named it, echoed so a client can match answers to asks. */
  readonly path: string
  /** The file's name, without its directory. */
  readonly name: string
  /** Size in bytes. */
  readonly byteSize: number
  /** Last modification, epoch milliseconds. */
  readonly modifiedAt: number
  /** The media type this host associates with the extension. */
  readonly mediaType: string
  /** Whether the app has a viewer for this type. */
  readonly previewable: boolean
}

/** What `file.read` answers. */
export interface FileReadResult {
  /** Where this slice starts. */
  readonly offset: number
  /** How many bytes it holds. */
  readonly length: number
  /** The whole file's size, so a client can show progress without a `stat`. */
  readonly byteSize: number
  /** The slice, standard base64. */
  readonly data: string
  /** Whether this slice ends the file. */
  readonly eof: boolean
}

/** One resolved file, ready to be sliced. */
interface Resolved {
  /** The real, absolute path. */
  readonly absolute: string
  /** The real workspace root it was confined to. */
  readonly root: string
  /** Size in bytes. */
  readonly byteSize: number
  /** Last modification, epoch milliseconds. */
  readonly modifiedAt: number
}

/** Per-context memo of session working directories. */
const roots = new WeakMap<Context, Map<string, { cwd: string | null; at: number }>>()

/**
 * Read one file's facts.
 *
 * @param ctx - a context observing the session gateway.
 * @param payload - `{sessionId, path}`.
 * @returns the file's name, size, modification time and type.
 * @throws MethodError `FILE_UNKNOWN`, `FILE_FORBIDDEN` or `FILE_TOO_LARGE`.
 */
export async function fileStat(ctx: Context, payload: unknown): Promise<FileStatResult> {
  const sessionId = requireString(payload, 'sessionId', 'file.stat')
  const path = requireString(payload, 'path', 'file.stat')
  const resolved = await resolveInSession(ctx, sessionId, path, 'file.stat')
  return {
    path,
    name: basename(resolved.absolute),
    byteSize: resolved.byteSize,
    modifiedAt: resolved.modifiedAt,
    mediaType: mediaTypeOf(resolved.absolute),
    previewable: PREVIEWABLE.has(extensionOf(resolved.absolute)),
  }
}

/**
 * Read one slice of a file.
 *
 * @param ctx - a context observing the session gateway.
 * @param payload - `{sessionId, path, offset, length}`.
 * @returns the slice, base64, and whether it was the last one.
 * @throws MethodError `MALFORMED_FRAME` for a bad range, and everything `file.stat` throws.
 */
export async function fileRead(ctx: Context, payload: unknown): Promise<FileReadResult> {
  const record = requireObject(payload, 'file.read')
  const sessionId = requireString(record, 'sessionId', 'file.read')
  const path = requireString(record, 'path', 'file.read')
  const offset = integer(record, 'offset', 'file.read')
  const requested = integer(record, 'length', 'file.read')
  if (offset < 0) {
    throw new MethodError('MALFORMED_FRAME', 'file.read: payload."offset" must not be negative')
  }
  if (requested <= 0 || requested > MAX_CHUNK_BYTES) {
    throw new MethodError(
      'MALFORMED_FRAME',
      `file.read: payload."length" must be between 1 and ${MAX_CHUNK_BYTES}`,
    )
  }

  const resolved = await resolveInSession(ctx, sessionId, path, 'file.read')
  if (offset > resolved.byteSize) {
    throw new MethodError(
      'MALFORMED_FRAME',
      `file.read: payload."offset" ${offset} is past the end of a ${resolved.byteSize}-byte file`,
    )
  }
  const length = Math.min(requested, resolved.byteSize - offset)

  const handle = await open(resolved.absolute, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, offset)
    const slice = bytesRead === length ? buffer : buffer.subarray(0, bytesRead)
    return {
      offset,
      length: bytesRead,
      byteSize: resolved.byteSize,
      data: slice.toString('base64'),
      eof: offset + bytesRead >= resolved.byteSize,
    }
  } finally {
    await handle.close()
  }
}

// MARK: - Resolution

/**
 * Turn a request's path into a confined, real file.
 *
 * The order matters and is the whole safety argument: the *lexical* path is
 * checked against the root before the filesystem is asked anything, so a path
 * outside the workspace answers `FILE_FORBIDDEN` without revealing whether it
 * exists; then `realpath` resolves symlinks, and the resolved path is checked
 * again, which is what catches a link inside the workspace pointing out of it.
 *
 * @param ctx - a context observing the session gateway.
 * @param sessionId - the session whose working directory is the fence.
 * @param path - the path from the request, relative or absolute.
 * @returns the file's real path and facts.
 * @throws MethodError when the path is outside, absent, not a regular file, refused by name, or too large.
 */
async function resolveInSession(
  ctx: Context,
  sessionId: string,
  path: string,
  method: string,
): Promise<Resolved> {
  const cwd = await sessionCwd(ctx, sessionId)
  if (cwd === null) {
    throw new MethodError('FILE_FORBIDDEN', `${method}: this session has no working directory`)
  }
  // Two spellings of the same directory, and both are needed. `cwd` is what the
  // host recorded and what the model's relative paths are written against; on
  // macOS `/var` and `/private/var` are the same place with different names, so
  // comparing only the real path would refuse every path the model wrote.
  const root = await realpath(cwd).catch(() => null)
  if (root === null) {
    throw new MethodError('FILE_FORBIDDEN', `${method}: this session working directory is gone`)
  }

  const candidate = isAbsolute(path) ? resolve(path) : resolve(cwd, path)
  if (!inside(root, candidate) && !inside(cwd, candidate)) {
    throw new MethodError('FILE_FORBIDDEN', `${method}: the path is outside the session workspace`)
  }

  const absolute = await realpath(candidate).catch(() => null)
  if (absolute === null) {
    throw new MethodError('FILE_UNKNOWN', `${method}: no file named "${basename(candidate)}"`)
  }
  // Second check, on what the filesystem actually resolved to: a symlink inside
  // the workspace that points at `/etc/passwd` passes the lexical test above.
  if (!inside(root, absolute)) {
    throw new MethodError('FILE_FORBIDDEN', `${method}: the path resolves outside the session workspace`)
  }
  if (DENIED_NAMES.some((pattern) => pattern.test(basename(absolute)))) {
    throw new MethodError('FILE_FORBIDDEN', `${method}: this file name is not readable over Mizar`)
  }

  const facts = await stat(absolute).catch(() => null)
  if (facts === null || !facts.isFile()) {
    throw new MethodError('FILE_FORBIDDEN', `${method}: the path is not a regular file`)
  }
  if (facts.size > MAX_FILE_BYTES) {
    throw new MethodError(
      'FILE_TOO_LARGE',
      `${method}: the file is ${facts.size} bytes, over the ${MAX_FILE_BYTES}-byte limit`,
    )
  }
  return { absolute, root, byteSize: facts.size, modifiedAt: Math.round(facts.mtimeMs) }
}

/**
 * A session's working directory, remembered briefly.
 *
 * The gateway answers this only through `session/list`, which reads every
 * session the computer has. A preview is a handful of `file.read` calls in a
 * row, and paying that read per slice would make a 2 MiB document 8 list reads
 * on the host. Five minutes is long enough to cover one viewing and short
 * enough that a session that moved (or a workspace that was deleted) is noticed
 * before anyone stares at a stale answer.
 *
 * @param ctx - a context observing the session gateway.
 * @param sessionId - the session to look up.
 * @returns its working directory, or `null` when the host did not record one.
 */
async function sessionCwd(ctx: Context, sessionId: string): Promise<string | null> {
  let cache = roots.get(ctx)
  if (cache === undefined) {
    cache = new Map()
    roots.set(ctx, cache)
  }
  const hit = cache.get(sessionId)
  const now = Date.now()
  if (hit !== undefined && now - hit.at < ROOT_TTL_MS) return hit.cwd

  const { items } = await listSessions(ctx)
  const row = items.find((item) => item.sessionId === sessionId)
  const cwd = row?.cwd ?? null
  cache.set(sessionId, { cwd, at: now })
  return cwd
}

/**
 * Whether a path sits inside a root.
 *
 * Compares path segments, not string prefixes: `/work/app-notes` is not inside
 * `/work/app`, and a plain `startsWith` would say it was.
 *
 * @param root - the real, absolute root.
 * @param path - the real, absolute candidate.
 * @returns whether it is the root itself or below it.
 */
function inside(root: string, path: string): boolean {
  if (path === root) return true
  const prefix = root.endsWith(sep) ? root : root + sep
  return path.startsWith(prefix)
}

// MARK: - Types

/**
 * A request field that must be a non-negative safe integer.
 *
 * @param payload - the request payload.
 * @param key - the field name.
 * @param method - the method name, for the message.
 * @returns the value.
 * @throws MethodError when the field is missing or not an integer.
 */
function integer(payload: Record<string, unknown>, key: string, method: string): number {
  const value = payload[key]
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new MethodError('MALFORMED_FRAME', `${method}: payload."${key}" must be an integer`)
  }
  return value
}

/**
 * The lower-case extension of a path, without its dot.
 * @param path - a file path.
 * @returns the extension, or `''` when there is none.
 */
function extensionOf(path: string): string {
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/**
 * The media type this host associates with a path.
 * @param path - a file path.
 * @returns an IANA media type, or `application/octet-stream`.
 */
function mediaTypeOf(path: string): string {
  return MEDIA_TYPES[extensionOf(path)] ?? 'application/octet-stream'
}
