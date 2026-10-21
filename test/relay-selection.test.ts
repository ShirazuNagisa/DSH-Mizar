/**
 * Tests for the relay allowlist and the remembered relay choice.
 *
 * A paired phone can ask this computer to redial a relay, so the set of
 * addresses it can name is a security boundary, not a preference list. These
 * cases pin the boundary and the persistence around it.
 *
 * @module dsh-mizar/test/relay-selection
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canonicalRelayURL,
  isSelectableRelayURL,
  readRelayOverride,
  RELAY_OVERRIDE_FILE,
  writeRelayOverride,
} from '../src/relay/selection.js'

const FREE = 'https://dshmizar.shirazu-nagisa.com'
const PAID = 'https://dshmizar-1.shirazu-nagisa.com'

describe('relay allowlist', () => {
  it('canonicalizes an origin and tolerates a trailing slash', () => {
    expect(canonicalRelayURL(`${FREE}/`)).toBe(FREE)
    expect(canonicalRelayURL(FREE)).toBe(FREE)
  })

  it('refuses anything that is not an origin', () => {
    expect(canonicalRelayURL(`${FREE}/r/ROOM1`)).toBeNull()
    expect(canonicalRelayURL(`${FREE}?x=1`)).toBeNull()
    expect(canonicalRelayURL(`${FREE}#x`)).toBeNull()
    expect(canonicalRelayURL('https://user:pass@example.com')).toBeNull()
    expect(canonicalRelayURL('ftp://example.com')).toBeNull()
    expect(canonicalRelayURL('not a url')).toBeNull()
  })

  it('selects only the two public relays', () => {
    expect(isSelectableRelayURL(FREE)).toBe(true)
    expect(isSelectableRelayURL(`${PAID}/`)).toBe(true)
    expect(isSelectableRelayURL('https://evil.example.com')).toBe(false)
    expect(isSelectableRelayURL('http://dshmizar.shirazu-nagisa.com')).toBe(false)
    expect(isSelectableRelayURL(`${FREE}/r/ROOM1`)).toBe(false)
  })
})

describe('remembered relay choice', () => {
  let stateDir: string

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), 'mizar-relay-selection-'))
  })

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true })
  })

  it('is absent until a relay is chosen', async () => {
    await expect(readRelayOverride(stateDir)).resolves.toBeNull()
  })

  it('round-trips the chosen relay at mode 600', async () => {
    await writeRelayOverride(stateDir, `${PAID}/`)
    await expect(readRelayOverride(stateDir)).resolves.toBe(PAID)
    const raw = await readFile(join(stateDir, RELAY_OVERRIDE_FILE), 'utf8')
    expect(JSON.parse(raw)).toEqual({ url: PAID })
    const { mode } = await import('node:fs/promises').then((fs) => fs.stat(join(stateDir, RELAY_OVERRIDE_FILE)))
    expect(mode & 0o777).toBe(0o600)
  })

  it('ignores an unreadable choice and keeps the configured relay', async () => {
    await writeFile(join(stateDir, RELAY_OVERRIDE_FILE), '{not json')
    const logged: string[] = []
    await expect(readRelayOverride(stateDir, (message) => logged.push(message))).resolves.toBeNull()
    expect(logged.join('\n')).toContain('not valid JSON')
  })

  it('ignores a choice outside the allowlist', async () => {
    await writeFile(
      join(stateDir, RELAY_OVERRIDE_FILE),
      JSON.stringify({ url: 'https://evil.example.com' }),
    )
    const logged: string[] = []
    await expect(readRelayOverride(stateDir, (message) => logged.push(message))).resolves.toBeNull()
    expect(logged.join('\n')).toContain('no selectable relay')
  })

  it('refuses to remember a relay outside the allowlist', async () => {
    await expect(writeRelayOverride(stateDir, 'https://evil.example.com')).rejects.toThrow(
      /allowlist/,
    )
  })
})
