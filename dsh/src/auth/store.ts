/**
 * Host-side persistent state.
 *
 * Mizar keeps one file per DSH home: the host secret, the host identity, the
 * outstanding pairing slot, and the device roster. It is written atomically and
 * with owner-only permissions, because a leaked `state.json` would let an
 * attacker mint codes indistinguishable from the real ones.
 *
 * The file is deliberately **not** partitioned by profile. A device pairs once
 * and then works in whichever profile has the plugin mounted, and the dev
 * harness already isolates itself by running against a workspace-local
 * `DSH_HOME`. DSH home resolution is reimplemented here rather than imported
 * from `@deepseek-ai/dsh-home-paths`: the plugin's only runtime dependency on
 * the DSH tree is `schemastery`, which the Cordis Config convention requires.
 *
 * @module dsh-mizar/auth/store
 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, unlink, appendFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { DeviceRecord } from './devices.js'
import type { PairingSlot } from './pairing.js'

/** Schema version of the state file. */
export const STATE_VERSION = 1

/** Bytes in the host secret. */
const SECRET_BYTES = 32

/** Directory name for Mizar state under the DSH home. */
const STATE_DIR_NAME = '.mizar'

/** The persisted state. */
export interface MizarState {
  readonly version: typeof STATE_VERSION
  /** Base64url host secret; the root of every pairing code and device token. */
  readonly hostSecret: string
  /** Stable host identity, shown to the phone on pairing. */
  readonly hostId: string
  /** When this host first ran Mizar, in epoch milliseconds. */
  readonly createdAt: number
  /** The outstanding pairing slot, or `null` when no code is live. */
  readonly pairing: PairingSlot | null
  /** Every device ever paired, including revoked ones. */
  readonly devices: readonly DeviceRecord[]
}

/** One line of the append-only audit log. */
export interface AuditEvent {
  /** Epoch milliseconds. */
  readonly time: number
  /** What happened. */
  readonly event:
    | 'state-created'
    | 'pairing-issued'
    | 'pairing-redeemed'
    | 'pairing-failed'
    | 'device-paired'
    | 'device-revoked'
    | 'client-connected'
    | 'client-rejected'
  /** Remote address the request came from, when known. */
  readonly remote?: string
  /** Free-form detail; never contains secrets. */
  readonly detail?: string
}

/**
 * Resolve the Mizar state directory for a DSH home.
 * @param env - environment to read `DSH_HOME` from.
 * @param home - the user's home directory.
 * @returns the absolute state directory.
 */
export function resolveMizarHome(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const configured = env['DSH_HOME']?.trim()
  const base = configured !== undefined && configured !== '' ? configured : join(home, '.dsh')
  return join(base, STATE_DIR_NAME)
}

/** Encode bytes as base64url. */
function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url')
}

/** Decode base64url, returning `null` when the input is malformed. */
function fromBase64Url(value: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(value, 'base64url'))
  } catch {
    return null
  }
}

/** Build a brand-new state with a fresh secret. */
function createState(now: number = Date.now()): MizarState {
  return {
    version: STATE_VERSION,
    hostSecret: toBase64Url(new Uint8Array(randomBytes(SECRET_BYTES))),
    hostId: randomUUID(),
    createdAt: now,
    pairing: null,
    devices: [],
  }
}

/**
 * Narrow an unknown device record.
 *
 * A malformed record is dropped rather than failing the load: one corrupt row
 * must not lock the operator out of every other paired device.
 * @param value - the candidate record.
 * @returns the record, or `null` when it is unusable.
 */
function parseDevice(value: unknown): DeviceRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const strings = ['deviceId', 'name', 'tokenHash', 'tokenPrefix'] as const
  for (const key of strings) {
    if (typeof record[key] !== 'string' || (record[key] as string) === '') return null
  }
  const numbers = ['createdAt', 'lastSeenAt'] as const
  for (const key of numbers) {
    if (typeof record[key] !== 'number' || !Number.isFinite(record[key] as number)) return null
  }
  return {
    deviceId: record['deviceId'] as string,
    name: record['name'] as string,
    ...(typeof record['model'] === 'string' ? { model: record['model'] } : {}),
    ...(typeof record['appVersion'] === 'string' ? { appVersion: record['appVersion'] } : {}),
    tokenHash: record['tokenHash'] as string,
    tokenPrefix: record['tokenPrefix'] as string,
    createdAt: record['createdAt'] as number,
    lastSeenAt: record['lastSeenAt'] as number,
    ...(typeof record['revokedAt'] === 'number' ? { revokedAt: record['revokedAt'] } : {}),
  }
}

/**
 * Parse persisted JSON into state, or return `null` when it is unusable.
 * @param raw - the file contents.
 * @returns the parsed state, or `null`.
 */
export function parseState(raw: string): MizarState | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const record = parsed as Record<string, unknown>
  if (record['version'] !== STATE_VERSION) return null
  if (typeof record['hostSecret'] !== 'string') return null
  const secret = fromBase64Url(record['hostSecret'])
  if (secret === null || secret.length !== SECRET_BYTES) return null
  if (typeof record['hostId'] !== 'string' || record['hostId'] === '') return null
  if (typeof record['createdAt'] !== 'number') return null

  const pairingRaw = record['pairing']
  let pairing: PairingSlot | null = null
  if (typeof pairingRaw === 'object' && pairingRaw !== null) {
    const slot = pairingRaw as Record<string, unknown>
    if (typeof slot['epoch'] === 'number' && typeof slot['expiresAt'] === 'number') {
      pairing = { epoch: slot['epoch'], expiresAt: slot['expiresAt'] }
    }
  }

  const devices = Array.isArray(record['devices'])
    ? record['devices'].map(parseDevice).filter((device): device is DeviceRecord => device !== null)
    : []

  return {
    version: STATE_VERSION,
    hostSecret: record['hostSecret'],
    hostId: record['hostId'],
    createdAt: record['createdAt'],
    pairing,
    devices,
  }
}

/**
 * Read one file as UTF-8, returning `null` when it does not exist.
 * @param path - the file to read.
 * @returns its contents, or `null`.
 */
async function readIfPresent(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Write a file atomically: a sibling temp file, flushed, then renamed over the
 * target. The rename is what makes a reader see either the whole old file or the
 * whole new one.
 *
 * @param path - the destination.
 * @param contents - the contents to write.
 */
async function writeAtomic(path: string, contents: string): Promise<void> {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  const handle = await open(temp, 'w', 0o600)
  try {
    await handle.writeFile(contents, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temp, path)
  } catch (error) {
    await unlink(temp).catch(() => {})
    throw error
  }
}

/**
 * Owner-only state store for one DSH home.
 *
 * All writes are serialized through an internal promise chain, so two concurrent
 * mutations cannot interleave their read-modify-write cycles and lose one.
 */
export class MizarStore {
  readonly #dir: string
  readonly #statePath: string
  readonly #auditPath: string
  #state: MizarState
  #secret: Uint8Array
  #queue: Promise<unknown> = Promise.resolve()

  private constructor(dir: string, state: MizarState) {
    this.#dir = dir
    this.#statePath = join(dir, 'state.json')
    this.#auditPath = join(dir, 'audit.jsonl')
    this.#state = state
    const secret = fromBase64Url(state.hostSecret)
    if (secret === null) throw new Error('mizar: state carries an unusable host secret')
    this.#secret = secret
  }

  /**
   * Open the store, creating state on first run.
   * @param dir - the state directory, normally from {@link resolveMizarHome}.
   * @returns the opened store.
   */
  static async open(dir: string): Promise<MizarStore> {
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const raw = await readIfPresent(join(dir, 'state.json'))
    if (raw === null) {
      const store = new MizarStore(dir, createState())
      await store.#persist()
      await store.audit({ time: Date.now(), event: 'state-created', detail: dir })
      return store
    }

    const parsed = parseState(raw)
    if (parsed !== null) return new MizarStore(dir, parsed)

    // Unusable state is moved aside rather than overwritten, so an operator can
    // still recover paired-device records by hand.
    const quarantine = `${join(dir, 'state.json')}.corrupt-${Date.now()}`
    await rename(join(dir, 'state.json'), quarantine).catch(() => {})
    const store = new MizarStore(dir, createState())
    await store.#persist()
    await store.audit({
      time: Date.now(),
      event: 'state-created',
      detail: `previous state was unusable and moved to ${quarantine}`,
    })
    return store
  }

  /** The current state. Immutable; use {@link mutate} to change it. */
  get state(): MizarState {
    return this.#state
  }

  /** The decoded host secret. */
  get secret(): Uint8Array {
    return this.#secret
  }

  /** The state directory. */
  get dir(): string {
    return this.#dir
  }

  /** Write the current state to disk. */
  async #persist(): Promise<void> {
    await writeAtomic(this.#statePath, `${JSON.stringify(this.#state, null, 2)}\n`)
  }

  /**
   * Apply a change and persist it.
   *
   * Calls are serialized: the mutation runs against the state produced by the
   * previous one, so a concurrent pair of updates cannot lose an entry.
   *
   * @param produce - returns the next state; returning the same reference skips the write.
   * @returns the state after the mutation.
   */
  async mutate(produce: (state: MizarState) => MizarState): Promise<MizarState> {
    const run = this.#queue.then(async () => {
      const next = produce(this.#state)
      if (next === this.#state) return this.#state
      const previous = this.#state
      this.#state = next
      try {
        await this.#persist()
      } catch (error) {
        this.#state = previous
        throw error
      }
      return this.#state
    })
    // Keep the chain alive even when one mutation rejects.
    this.#queue = run.catch(() => {})
    return run
  }

  /**
   * Append one line to the audit log.
   *
   * Auditing never throws into the caller: losing a log line must not take down
   * a pairing request that already succeeded.
   *
   * @param event - the event to record.
   */
  async audit(event: AuditEvent): Promise<void> {
    try {
      await appendFile(this.#auditPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch {
      // Deliberately swallowed; see above.
    }
  }

  /**
   * Read the audit log back, newest last.
   * @param limit - maximum lines to return.
   * @returns the parsed events, skipping unreadable lines.
   */
  async readAudit(limit = 200): Promise<AuditEvent[]> {
    const raw = await readIfPresent(this.#auditPath)
    if (raw === null) return []
    return raw
      .split('\n')
      .filter((line) => line.trim() !== '')
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as AuditEvent
        } catch {
          return null
        }
      })
      .filter((event): event is AuditEvent => event !== null)
  }
}

/** Exported for tests: build a state object without touching disk. */
export function createInitialState(now: number = Date.now()): MizarState {
  return createState(now)
}
