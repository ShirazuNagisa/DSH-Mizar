/**
 * The endpoint file the desktop publishes.
 *
 * Every malformed case collapses to the same answer — `null`, meaning "there is
 * no desktop to dial" — because they are all transient from the plugin's point of
 * view: the desktop is starting, restarting, or not installed.
 *
 * @module dsh-mizar/test/endpoint
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { expandHome, readEndpoint } from '../src/link/endpoint.js'

const created: string[] = []

/** Write one endpoint file into a fresh temporary directory. */
async function withEndpoint(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'agi-mizar-endpoint-'))
  created.push(dir)
  const file = join(dir, 'endpoint.json')
  await writeFile(file, contents, 'utf8')
  return file
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('expandHome', () => {
  it('expands a bare tilde and a tilde path', () => {
    expect(expandHome('~')).toBe(homedir())
    expect(expandHome('~/.agi-mizar/endpoint.json')).toBe(join(homedir(), '.agi-mizar/endpoint.json'))
  })

  it('leaves an absolute path alone', () => {
    expect(expandHome('/tmp/endpoint.json')).toBe('/tmp/endpoint.json')
  })
})

describe('readEndpoint', () => {
  it('reads a valid file', async () => {
    const file = await withEndpoint(JSON.stringify({ port: 51_234, token: 'abc', pid: 42 }))
    await expect(readEndpoint(file)).resolves.toEqual({ port: 51_234, token: 'abc', pid: 42 })
  })

  it('omits a pid that is not an integer', async () => {
    const file = await withEndpoint(JSON.stringify({ port: 51_234, token: 'abc', pid: 'x' }))
    await expect(readEndpoint(file)).resolves.toEqual({ port: 51_234, token: 'abc' })
  })

  it('answers null for a missing file', async () => {
    await expect(readEndpoint(join(tmpdir(), 'agi-mizar-does-not-exist.json'))).resolves.toBeNull()
  })

  it('answers null for malformed JSON', async () => {
    const file = await withEndpoint('{')
    await expect(readEndpoint(file)).resolves.toBeNull()
  })

  it('answers null for a port out of range, a float, or a missing token', async () => {
    await expect(readEndpoint(await withEndpoint(JSON.stringify({ port: 0, token: 'a' })))).resolves.toBeNull()
    await expect(readEndpoint(await withEndpoint(JSON.stringify({ port: 70_000, token: 'a' })))).resolves.toBeNull()
    await expect(readEndpoint(await withEndpoint(JSON.stringify({ port: 1.5, token: 'a' })))).resolves.toBeNull()
    await expect(readEndpoint(await withEndpoint(JSON.stringify({ port: 1234, token: '' })))).resolves.toBeNull()
    await expect(readEndpoint(await withEndpoint(JSON.stringify({ port: 1234 })))).resolves.toBeNull()
  })
})
