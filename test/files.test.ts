/**
 * Tests for reading a delivered file off the host.
 *
 * The fence is the subject. A preview page is a read of a path a *model* named,
 * and the model's output is prose — so every test below is about what the host
 * refuses, not about what it returns:
 *
 *   - a relative path that climbs out with `..`,
 *   - a symlink inside the workspace that points outside it,
 *   - a credential-shaped name that is inside the workspace,
 *   - a directory, a session with no working directory, a missing file,
 *   - a file past the 32 MiB ceiling.
 *
 * The slice tests then pin the part a phone depends on: offsets are honoured,
 * `eof` is exact, and the bytes are the file's own.
 *
 * @module dsh-mizar/test/files
 */
import { mkdtemp, mkdir, open, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Context } from '../src/dsh.js'
import { fileRead, fileStat, MAX_CHUNK_BYTES, MAX_FILE_BYTES } from '../src/bridge/files.js'

/** A context whose only job is to answer `session/list` with one working directory. */
function sessionContext(cwd: string | null): Context {
  const gateway = {
    invoke: async (request: { namespace: string; method: string }) => {
      if (request.namespace === 'session' && request.method === 'list') {
        return {
          items: [{
            sessionId: 'session-1',
            updatedAt: 1,
            running: false,
            blank: false,
            agentAvailable: true,
            cwd,
            parentSessionId: null,
            origin: null,
          }],
        }
      }
      throw new Error(`unexpected gateway call ${request.namespace}/${request.method}`)
    },
  }
  return { typertGateway: gateway, effect: () => () => {} } as unknown as Context
}

/** The wire code of a rejected promise, for assertions that care which refusal it was. */
async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return (error as { code?: string }).code ?? 'NO_CODE'
  }
  return 'RESOLVED'
}

describe('file.stat', () => {
  let root = ''
  let outside = ''
  let ctx: Context

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'mizar-files-'))
    root = join(base, 'workspace')
    outside = join(base, 'elsewhere')
    await mkdir(join(root, 'docs'), { recursive: true })
    await mkdir(outside, { recursive: true })
    await writeFile(join(root, 'docs', 'report.md'), '# Report\n\nHello.\n')
    await writeFile(join(outside, 'secret.txt'), 'not yours\n')
    await symlink(join(outside, 'secret.txt'), join(root, 'docs', 'escape.txt'))
    ctx = sessionContext(root)
  })

  afterEach(() => {
    // Nothing to unwind: the temp tree is under the OS's own cleanup.
  })

  it('describes a relative path inside the workspace', async () => {
    const result = await fileStat(ctx, { sessionId: 'session-1', path: 'docs/report.md' })
    expect(result.name).toBe('report.md')
    expect(result.byteSize).toBe(17)
    expect(result.mediaType).toBe('text/markdown')
    expect(result.previewable).toBe(true)
    expect(result.path).toBe('docs/report.md')
    expect(result.modifiedAt).toBeGreaterThan(0)
  })

  it('accepts an absolute path inside the workspace', async () => {
    const result = await fileStat(ctx, { sessionId: 'session-1', path: join(root, 'docs', 'report.md') })
    expect(result.name).toBe('report.md')
  })

  it('refuses a path that climbs out of the workspace', async () => {
    expect(await codeOf(fileStat(ctx, { sessionId: 'session-1', path: '../elsewhere/secret.txt' })))
      .toBe('FILE_FORBIDDEN')
  })

  it('refuses an absolute path outside the workspace', async () => {
    expect(await codeOf(fileStat(ctx, { sessionId: 'session-1', path: join(outside, 'secret.txt') })))
      .toBe('FILE_FORBIDDEN')
  })

  it('refuses a link inside the workspace that points outside it', async () => {
    expect(await codeOf(fileStat(ctx, { sessionId: 'session-1', path: 'docs/escape.txt' })))
      .toBe('FILE_FORBIDDEN')
  })

  it('says a missing file inside the workspace is unknown', async () => {
    expect(await codeOf(fileStat(ctx, { sessionId: 'session-1', path: 'docs/gone.md' })))
      .toBe('FILE_UNKNOWN')
  })

  it('refuses a credential-shaped name even inside the workspace', async () => {
    await writeFile(join(root, '.env'), 'TOKEN=1\n')
    expect(await codeOf(fileStat(ctx, { sessionId: 'session-1', path: '.env' }))).toBe('FILE_FORBIDDEN')
  })

  it('refuses a directory', async () => {
    expect(await codeOf(fileStat(ctx, { sessionId: 'session-1', path: 'docs' }))).toBe('FILE_FORBIDDEN')
  })

  it('refuses when the session recorded no working directory', async () => {
    expect(await codeOf(fileStat(sessionContext(null), { sessionId: 'session-1', path: 'a.md' })))
      .toBe('FILE_FORBIDDEN')
  })

  it('refuses a file past the ceiling', async () => {
    const big = join(root, 'big.bin')
    const handle = await open(big, 'w')
    await handle.truncate(MAX_FILE_BYTES + 1)
    await handle.close()
    expect(await codeOf(fileStat(ctx, { sessionId: 'session-1', path: 'big.bin' }))).toBe('FILE_TOO_LARGE')
  })

  it('rejects a payload without a path', async () => {
    expect(await codeOf(fileStat(ctx, { sessionId: 'session-1' }))).toBe('MALFORMED_FRAME')
  })
})

describe('file.read', () => {
  let root = ''
  let ctx: Context
  let body = ''

  beforeEach(async () => {
    const base = await mkdtemp(join(tmpdir(), 'mizar-read-'))
    root = join(base, 'workspace')
    await mkdir(root, { recursive: true })
    body = 'abcdefghij'.repeat(10)
    await writeFile(join(root, 'data.md'), body)
    ctx = sessionContext(root)
  })

  it('returns the whole file when it fits in one slice', async () => {
    const result = await fileRead(ctx, { sessionId: 'session-1', path: 'data.md', offset: 0, length: MAX_CHUNK_BYTES })
    expect(result.length).toBe(body.length)
    expect(result.byteSize).toBe(body.length)
    expect(result.eof).toBe(true)
    expect(Buffer.from(result.data, 'base64').toString('utf8')).toBe(body)
  })

  it('slices at an offset and says where the end is', async () => {
    const first = await fileRead(ctx, { sessionId: 'session-1', path: 'data.md', offset: 0, length: 40 })
    expect(first.eof).toBe(false)
    const next = await fileRead(ctx, { sessionId: 'session-1', path: 'data.md', offset: 40, length: 60 })
    expect(next.eof).toBe(true)
    expect(Buffer.concat([
      Buffer.from(first.data, 'base64'),
      Buffer.from(next.data, 'base64'),
    ]).toString('utf8')).toBe(body)
  })

  it('clamps the last slice to what is left', async () => {
    const result = await fileRead(ctx, { sessionId: 'session-1', path: 'data.md', offset: body.length - 5, length: 100 })
    expect(result.length).toBe(5)
    expect(result.eof).toBe(true)
  })

  it('answers an empty last slice at exactly the end', async () => {
    const result = await fileRead(ctx, { sessionId: 'session-1', path: 'data.md', offset: body.length, length: 10 })
    expect(result.length).toBe(0)
    expect(result.eof).toBe(true)
  })

  it('refuses an offset past the end', async () => {
    expect(await codeOf(fileRead(ctx, { sessionId: 'session-1', path: 'data.md', offset: body.length + 1, length: 10 })))
      .toBe('MALFORMED_FRAME')
  })

  it('refuses a slice larger than the chunk ceiling', async () => {
    expect(await codeOf(fileRead(ctx, {
      sessionId: 'session-1', path: 'data.md', offset: 0, length: MAX_CHUNK_BYTES + 1,
    }))).toBe('MALFORMED_FRAME')
  })

  it('refuses a zero or negative length and a negative offset', async () => {
    expect(await codeOf(fileRead(ctx, { sessionId: 'session-1', path: 'data.md', offset: 0, length: 0 })))
      .toBe('MALFORMED_FRAME')
    expect(await codeOf(fileRead(ctx, { sessionId: 'session-1', path: 'data.md', offset: -1, length: 10 })))
      .toBe('MALFORMED_FRAME')
  })

  it('refuses a non-integer range', async () => {
    expect(await codeOf(fileRead(ctx, { sessionId: 'session-1', path: 'data.md', offset: 0.5, length: 10 })))
      .toBe('MALFORMED_FRAME')
  })

  it('applies the same fence as file.stat', async () => {
    expect(await codeOf(fileRead(ctx, { sessionId: 'session-1', path: '../x.md', offset: 0, length: 10 })))
      .toBe('FILE_FORBIDDEN')
  })
})
