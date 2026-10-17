/**
 * Tests for host state persistence.
 *
 * The state file holds the host secret, so the cases below target the failure
 * modes that matter: permissions on disk, a corrupt file not bricking the
 * plugin, malformed rows not taking good devices down with them, and concurrent
 * mutations not losing one another.
 *
 * @module dsh-mizar/test/store
 */
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createInitialState,
  MizarStore,
  parseState,
  resolveMizarHome,
  STATE_VERSION,
} from '../src/auth/store.js'
import { createDeviceRecord, issueToken } from '../src/auth/devices.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mizar-store-'))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Build a valid state file body with the given devices. */
function stateFile(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...createInitialState(1000), ...overrides })
}

describe('resolveMizarHome', () => {
  // Expectations are built with `join`, not written out with forward slashes:
  // the function under test joins with `node:path`, so a hard-coded
  // `/custom/home/.mizar` is an assertion about the separator the *test runner*
  // happens to use. On Windows the same call correctly answers
  // `\custom\home\.mizar`, and the literal version failed for that reason and
  // no other.
  it('prefers DSH_HOME when set', () => {
    expect(resolveMizarHome({ DSH_HOME: '/custom/home' }, '/users/x')).toBe(
      join('/custom/home', '.mizar'),
    )
  })

  it('falls back to ~/.dsh', () => {
    expect(resolveMizarHome({}, '/users/x')).toBe(join('/users/x', '.dsh', '.mizar'))
  })

  it('ignores a blank DSH_HOME rather than resolving to a relative path', () => {
    expect(resolveMizarHome({ DSH_HOME: '   ' }, '/users/x')).toBe(
      join('/users/x', '.dsh', '.mizar'),
    )
  })
})

describe('parseState', () => {
  it('accepts a well-formed state', () => {
    const parsed = parseState(stateFile())
    expect(parsed?.version).toBe(STATE_VERSION)
    expect(parsed?.devices).toEqual([])
  })

  it('rejects unparseable JSON', () => {
    expect(parseState('{ not json')).toBeNull()
  })

  it('rejects an unknown version', () => {
    expect(parseState(stateFile({ version: 99 }))).toBeNull()
  })

  it('rejects a secret that is not 32 bytes', () => {
    expect(parseState(stateFile({ hostSecret: Buffer.from('short').toString('base64url') }))).toBeNull()
  })

  it('rejects a missing host identity', () => {
    expect(parseState(stateFile({ hostId: '' }))).toBeNull()
  })

  it('drops malformed device rows but keeps the good ones', () => {
    const good = createDeviceRecord(issueToken(), { name: 'iPhone' }, 1000)
    const parsed = parseState(
      stateFile({
        devices: [good, null, 'nonsense', { deviceId: 'x' }, { ...good, tokenHash: '' }],
      }),
    )
    expect(parsed?.devices).toHaveLength(1)
    expect(parsed?.devices[0]?.name).toBe('iPhone')
  })

  it('tolerates a missing pairing slot', () => {
    expect(parseState(stateFile({ pairing: undefined }))?.pairing).toBeNull()
  })

  it('drops a malformed pairing slot', () => {
    expect(parseState(stateFile({ pairing: { epoch: 'x' } }))?.pairing).toBeNull()
  })
})

describe('MizarStore', () => {
  it('creates state on first run with a 32-byte secret', async () => {
    const store = await MizarStore.open(dir)
    expect(store.state.version).toBe(STATE_VERSION)
    expect(store.secret).toHaveLength(32)
    expect(store.state.devices).toEqual([])
    expect(store.state.pairing).toBeNull()
    expect(store.state.hostId).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('writes the state file owner-only', async () => {
    await MizarStore.open(dir)
    const info = await stat(join(dir, 'state.json'))
    if (process.platform === 'win32') {
      // Node accepts `0o600` on Windows and the filesystem discards it, so the
      // file reports the default `0o666`. What protects it there is the profile
      // directory's ACL, which Node cannot read back -- see
      // docs/windows-status.md, "文件权限模式在 Windows 上是空操作". Asserting
      // `0o600` here would be asserting a POSIX mechanism on a platform that
      // does not have it.
      expect(info.isFile()).toBe(true)
      return
    }
    expect(info.mode & 0o777).toBe(0o600)
  })

  it('does not persist the secret in plaintext form anywhere obvious', async () => {
    const store = await MizarStore.open(dir)
    const raw = await readFile(join(dir, 'state.json'), 'utf8')
    // The secret is base64url in the file by design; assert it is the encoded
    // form and that no raw bytes leak as JSON numbers.
    expect(raw).toContain(store.state.hostSecret)
    expect(store.state.hostSecret).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('reuses existing state across opens', async () => {
    const first = await MizarStore.open(dir)
    const second = await MizarStore.open(dir)
    expect(second.state.hostId).toBe(first.state.hostId)
    expect(second.state.hostSecret).toBe(first.state.hostSecret)
  })

  it('quarantines unusable state instead of overwriting it', async () => {
    await writeFile(join(dir, 'state.json'), '{ this is not json', 'utf8')
    const store = await MizarStore.open(dir)

    // A working store, and the original file preserved for recovery.
    expect(store.secret).toHaveLength(32)
    const quarantined = (await import('node:fs/promises')).readdir(dir)
    const names = await quarantined
    expect(names.some((name) => name.includes('state.json.corrupt-'))).toBe(true)
  })

  it('persists a mutation', async () => {
    const store = await MizarStore.open(dir)
    const device = createDeviceRecord(issueToken(), { name: 'iPad' }, 2000)
    await store.mutate((state) => ({ ...state, devices: [...state.devices, device] }))

    const reopened = await MizarStore.open(dir)
    expect(reopened.state.devices).toHaveLength(1)
    expect(reopened.state.devices[0]?.name).toBe('iPad')
  })

  it('skips the write when a mutation returns the same reference', async () => {
    const store = await MizarStore.open(dir)
    const before = await stat(join(dir, 'state.json'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    await store.mutate((state) => state)
    const after = await stat(join(dir, 'state.json'))
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  it('serializes concurrent mutations so none is lost', async () => {
    const store = await MizarStore.open(dir)

    // Each mutation appends one device; without serialization these would
    // interleave their read-modify-write cycles and drop entries.
    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.mutate((state) => ({
          ...state,
          devices: [
            ...state.devices,
            createDeviceRecord(issueToken(), { name: `device-${index}` }, 3000 + index),
          ],
        })),
      ),
    )

    expect(store.state.devices).toHaveLength(25)
    const reopened = await MizarStore.open(dir)
    expect(reopened.state.devices).toHaveLength(25)
    expect(new Set(reopened.state.devices.map((d) => d.name)).size).toBe(25)
  })

  it('rolls back in-memory state when the write fails', async () => {
    const store = await MizarStore.open(dir)
    const original = store.state.devices.length

    await expect(
      store.mutate(() => {
        throw new Error('mutation blew up')
      }),
    ).rejects.toThrow('mutation blew up')
    expect(store.state.devices).toHaveLength(original)

    // The store stays usable after a failed mutation.
    await store.mutate((state) => ({ ...state, devices: [...state.devices] }))
    expect(store.state.version).toBe(STATE_VERSION)
  })

  it('appends and reads back the audit log, honouring the limit', async () => {
    const store = await MizarStore.open(dir)
    for (let index = 0; index < 5; index += 1) {
      await store.audit({ time: index, event: 'pairing-failed', detail: `attempt ${index}` })
    }

    const all = await store.readAudit()
    // 5 explicit lines plus the state-created line written on open.
    expect(all).toHaveLength(6)
    expect(all.at(-1)?.detail).toBe('attempt 4')

    const limited = await store.readAudit(2)
    expect(limited.map((event) => event.detail)).toEqual(['attempt 3', 'attempt 4'])
  })

  it('never throws from audit when the log is unwritable', async () => {
    const store = await MizarStore.open(dir)
    // Replace the audit path with a directory so the append must fail.
    await rm(join(dir, 'audit.jsonl'), { force: true })
    await mkdir(join(dir, 'audit.jsonl'))
    await expect(store.audit({ time: 0, event: 'state-created' })).resolves.toBeUndefined()
  })

  it('says so when the audit log stops accepting lines', async () => {
    // Swallowing is right -- losing a log line must not fail a pairing that
    // already happened -- but swallowing *silently* is not: the audit trail is
    // the operator's only forensic record, and a trail that ended yesterday
    // looks exactly like a host nothing has happened to.
    const warnings: string[] = []
    const store = await MizarStore.open(dir, (message) => warnings.push(message))
    await rm(join(dir, 'audit.jsonl'), { force: true })
    await mkdir(join(dir, 'audit.jsonl'))

    await store.audit({ time: 0, event: 'device-paired' })

    expect(warnings.some((message) => message.includes('audit'))).toBe(true)
  })

  it('refuses to start rather than overwrite state it could not move aside', async () => {
    // The quarantine is the promise that a corrupt roster is recoverable by
    // hand. If the move fails, writing fresh state over it destroys the only
    // copy of every device record -- so this fails loudly instead, and the
    // operator still has their file.
    await writeFile(join(dir, 'state.json'), '{ this is not json', 'utf8')
    const frozen = 1_700_000_000_000
    vi.useFakeTimers()
    try {
      vi.setSystemTime(frozen)
      // A directory in the quarantine's way makes the rename fail while the
      // directory itself stays writable.
      await mkdir(`${join(dir, 'state.json')}.corrupt-${frozen}`)

      await expect(MizarStore.open(dir)).rejects.toThrow(/moved aside|quarantine/i)
      // The unusable file is still there, byte for byte.
      expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe('{ this is not json')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports an empty audit log rather than failing', async () => {
    const store = await MizarStore.open(dir)
    // Drop the state-created line written by open.
    await writeFile(join(dir, 'audit.jsonl'), '', 'utf8')
    expect(await store.readAudit()).toEqual([])
  })

  it('creates the state directory when it does not exist', async () => {
    const nested = join(dir, 'a', 'b', 'c')
    const store = await MizarStore.open(nested)
    expect(store.dir).toBe(nested)
    expect(store.secret).toHaveLength(32)
  })
})
