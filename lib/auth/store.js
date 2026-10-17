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
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, appendFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { isLiveActivityToken } from './devices.js';
/** Schema version of the state file. */
export const STATE_VERSION = 1;
/** Bytes in the host secret. */
const SECRET_BYTES = 32;
/** Directory name for Mizar state under the DSH home. */
const STATE_DIR_NAME = '.mizar';
/**
 * Resolve the Mizar state directory for a DSH home.
 * @param env - environment to read `DSH_HOME` from.
 * @param home - the user's home directory.
 * @returns the absolute state directory.
 */
export function resolveMizarHome(env = process.env, home = homedir()) {
    const configured = env['DSH_HOME']?.trim();
    const base = configured !== undefined && configured !== '' ? configured : join(home, '.dsh');
    return join(base, STATE_DIR_NAME);
}
/** Encode bytes as base64url. */
function toBase64Url(bytes) {
    return Buffer.from(bytes).toString('base64url');
}
/** Decode base64url, returning `null` when the input is malformed. */
function fromBase64Url(value) {
    try {
        return new Uint8Array(Buffer.from(value, 'base64url'));
    }
    catch {
        return null;
    }
}
/** Build a brand-new state with a fresh secret. */
function createState(now = Date.now()) {
    return {
        version: STATE_VERSION,
        hostSecret: toBase64Url(new Uint8Array(randomBytes(SECRET_BYTES))),
        hostId: randomUUID(),
        createdAt: now,
        pairing: null,
        devices: [],
    };
}
/**
 * Narrow a device's stored push endpoint.
 *
 * Dropped rather than failing the device: a push token that cannot be parsed
 * costs notifications, and failing the whole record would cost the pairing. The
 * device re-registers on its next launch, and this file is the wrong place for a
 * recoverable field to become a lockout.
 *
 * The Live Activity token inside it gets the same treatment one level down: an
 * unusable one costs the activity, not the endpoint, because a phone that can
 * still be notified is worth more than one whose corrupt extra field made the
 * whole registration vanish.
 *
 * @param value - the candidate.
 * @returns the endpoint, or `null` when it is unusable.
 */
function parsePush(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const record = value;
    if (typeof record['token'] !== 'string' || record['token'] === '')
        return null;
    if (typeof record['locale'] !== 'string')
        return null;
    if (typeof record['updatedAt'] !== 'number')
        return null;
    // A record written before `platform` existed is an iOS one: nothing else
    // could have written it. Defaulting rather than dropping is what keeps an
    // existing state.json loading, and dropping would silently stop notifying
    // every phone already registered.
    const platform = record['platform'] === 'android' ? 'android' : 'ios';
    const raw = record['environment'];
    const environment = raw === 'sandbox' || raw === 'production'
        ? raw
        : // An iOS record with no usable environment keeps the old meaning of an
            // unknown value, which is the safe direction: the production host
            // refuses a sandbox token loudly. An Android one has none to keep.
            platform === 'ios'
                ? 'production'
                : null;
    // Validated on the way in and on the way back out, because this is the copy
    // the relay is told again after a restart -- a token that rotted in the file
    // would be re-announced as if it were still a Live Activity.
    const liveActivityToken = isLiveActivityToken(record['liveActivityToken'])
        ? record['liveActivityToken']
        : undefined;
    return {
        token: record['token'],
        platform,
        environment,
        locale: record['locale'],
        updatedAt: record['updatedAt'],
        ...(liveActivityToken === undefined ? {} : { liveActivityToken }),
    };
}
/**
 * Narrow an unknown device record.
 *
 * A malformed record is dropped rather than failing the load: one corrupt row
 * must not lock the operator out of every other paired device.
 * @param value - the candidate record.
 * @returns the record, or `null` when it is unusable.
 */
function parseDevice(value) {
    if (typeof value !== 'object' || value === null)
        return null;
    const record = value;
    const strings = ['deviceId', 'name', 'tokenHash', 'tokenPrefix'];
    for (const key of strings) {
        if (typeof record[key] !== 'string' || record[key] === '')
            return null;
    }
    const numbers = ['createdAt', 'lastSeenAt'];
    for (const key of numbers) {
        if (typeof record[key] !== 'number' || !Number.isFinite(record[key]))
            return null;
    }
    const push = parsePush(record['push']);
    return {
        deviceId: record['deviceId'],
        name: record['name'],
        ...(typeof record['model'] === 'string' ? { model: record['model'] } : {}),
        ...(typeof record['appVersion'] === 'string' ? { appVersion: record['appVersion'] } : {}),
        tokenHash: record['tokenHash'],
        tokenPrefix: record['tokenPrefix'],
        createdAt: record['createdAt'],
        lastSeenAt: record['lastSeenAt'],
        ...(typeof record['revokedAt'] === 'number' ? { revokedAt: record['revokedAt'] } : {}),
        ...(push === null ? {} : { push }),
    };
}
/**
 * Parse persisted JSON into state, or return `null` when it is unusable.
 * @param raw - the file contents.
 * @returns the parsed state, or `null`.
 */
export function parseState(raw) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null)
        return null;
    const record = parsed;
    if (record['version'] !== STATE_VERSION)
        return null;
    if (typeof record['hostSecret'] !== 'string')
        return null;
    const secret = fromBase64Url(record['hostSecret']);
    if (secret === null || secret.length !== SECRET_BYTES)
        return null;
    if (typeof record['hostId'] !== 'string' || record['hostId'] === '')
        return null;
    if (typeof record['createdAt'] !== 'number')
        return null;
    const pairingRaw = record['pairing'];
    let pairing = null;
    if (typeof pairingRaw === 'object' && pairingRaw !== null) {
        const slot = pairingRaw;
        if (typeof slot['epoch'] === 'number' && typeof slot['expiresAt'] === 'number') {
            pairing = { epoch: slot['epoch'], expiresAt: slot['expiresAt'] };
        }
    }
    const devices = Array.isArray(record['devices'])
        ? record['devices'].map(parseDevice).filter((device) => device !== null)
        : [];
    return {
        version: STATE_VERSION,
        hostSecret: record['hostSecret'],
        hostId: record['hostId'],
        createdAt: record['createdAt'],
        pairing,
        devices,
    };
}
/**
 * Read one file as UTF-8, returning `null` when it does not exist.
 * @param path - the file to read.
 * @returns its contents, or `null`.
 */
async function readIfPresent(path) {
    try {
        return await readFile(path, 'utf8');
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
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
async function writeAtomic(path, contents) {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    // The POSIX mode is a no-op on Windows -- Node accepts it and the OS ignores
    // it, so the state file there is protected by the user profile's ACL instead.
    // That is still "only this account and administrators", which is the same
    // guarantee by a different mechanism, but it is a different mechanism and
    // pretending otherwise would be wrong.
    const handle = await open(temp, 'w', 0o600);
    try {
        await handle.writeFile(contents, 'utf8');
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    try {
        await rename(temp, path);
    }
    catch (error) {
        await unlink(temp).catch(() => { });
        throw error;
    }
}
/**
 * Owner-only state store for one DSH home.
 *
 * All writes are serialized through an internal promise chain, so two concurrent
 * mutations cannot interleave their read-modify-write cycles and lose one.
 */
export class MizarStore {
    #dir;
    #statePath;
    #auditPath;
    #warn;
    #state;
    #secret;
    #queue = Promise.resolve();
    constructor(dir, state, warn) {
        this.#dir = dir;
        this.#statePath = join(dir, 'state.json');
        this.#auditPath = join(dir, 'audit.jsonl');
        this.#warn = warn;
        this.#state = state;
        const secret = fromBase64Url(state.hostSecret);
        if (secret === null)
            throw new Error('mizar: state carries an unusable host secret');
        this.#secret = secret;
    }
    /**
     * Open the store, creating state on first run.
     * @param dir - the state directory, normally from {@link resolveMizarHome}.
     * @param warn - sink for a failure that is survivable but must not be silent,
     *   such as an audit log that has stopped accepting lines. Defaults to
     *   dropping them, which is what a bare test store wants.
     * @returns the opened store.
     */
    static async open(dir, warn = () => { }) {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const raw = await readIfPresent(join(dir, 'state.json'));
        if (raw === null) {
            const store = new MizarStore(dir, createState(), warn);
            await store.#persist();
            await store.audit({ time: Date.now(), event: 'state-created', detail: dir });
            return store;
        }
        const parsed = parseState(raw);
        if (parsed !== null)
            return new MizarStore(dir, parsed, warn);
        // Unusable state is moved aside rather than overwritten, so an operator can
        // still recover paired-device records by hand. If it cannot be moved, this
        // stops rather than continuing: the alternative is a fresh state file
        // written over the only copy of every device record, which is exactly the
        // loss the quarantine exists to prevent.
        const quarantine = `${join(dir, 'state.json')}.corrupt-${Date.now()}`;
        try {
            await rename(join(dir, 'state.json'), quarantine);
        }
        catch (error) {
            throw new Error(`mizar: ${join(dir, 'state.json')} is unusable and could not be moved aside ` +
                `(${error instanceof Error ? error.message : String(error)}) — refusing to overwrite it`);
        }
        const store = new MizarStore(dir, createState(), warn);
        await store.#persist();
        await store.audit({
            time: Date.now(),
            event: 'state-created',
            detail: `previous state was unusable and moved to ${quarantine}`,
        });
        return store;
    }
    /** The current state. Immutable; use {@link mutate} to change it. */
    get state() {
        return this.#state;
    }
    /** The decoded host secret. */
    get secret() {
        return this.#secret;
    }
    /** The state directory. */
    get dir() {
        return this.#dir;
    }
    /** Write the current state to disk. */
    async #persist() {
        await writeAtomic(this.#statePath, `${JSON.stringify(this.#state, null, 2)}\n`);
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
    async mutate(produce) {
        const run = this.#queue.then(async () => {
            const next = produce(this.#state);
            if (next === this.#state)
                return this.#state;
            const previous = this.#state;
            this.#state = next;
            try {
                await this.#persist();
            }
            catch (error) {
                this.#state = previous;
                throw error;
            }
            return this.#state;
        });
        // Keep the chain alive even when one mutation rejects.
        this.#queue = run.catch(() => { });
        return run;
    }
    /**
     * Record, or clear, one device's push endpoint.
     *
     * Only ever touches the one device. A phone that registers its token must not
     * be able to disturb another phone's pairing, and the roster is the record of
     * who may connect at all.
     *
     * @param deviceId - the device to update.
     * @param push - the endpoint, or `null` to forget it.
     * @returns whether a device with that id is on the roster.
     */
    async setDevicePush(deviceId, push) {
        let found = false;
        await this.mutate((state) => {
            if (!state.devices.some((device) => device.deviceId === deviceId))
                return state;
            found = true;
            const devices = state.devices.map((device) => {
                if (device.deviceId !== deviceId)
                    return device;
                const { push: _previous, ...rest } = device;
                return push === null ? rest : { ...rest, push };
            });
            return { ...state, devices };
        });
        return found;
    }
    /**
     * Append one line to the audit log.
     *
     * Auditing never throws into the caller: losing a log line must not take down
     * a pairing request that already succeeded. It is not silent either -- the
     * audit trail is the operator's only forensic record, and a trail that stopped
     * last week looks exactly like a host nothing has happened to.
     *
     * @param event - the event to record.
     */
    async audit(event) {
        try {
            await appendFile(this.#auditPath, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 });
        }
        catch (error) {
            this.#warn(`the audit log at ${this.#auditPath} is not being written ` +
                `(${error instanceof Error ? error.message : String(error)}) — ` +
                'pairing and revocation are still working, but nothing is being recorded');
        }
    }
    /**
     * Read the audit log back, newest last.
     * @param limit - maximum lines to return.
     * @returns the parsed events, skipping unreadable lines.
     */
    async readAudit(limit = 200) {
        const raw = await readIfPresent(this.#auditPath);
        if (raw === null)
            return [];
        return raw
            .split('\n')
            .filter((line) => line.trim() !== '')
            .slice(-limit)
            .map((line) => {
            try {
                return JSON.parse(line);
            }
            catch {
                return null;
            }
        })
            .filter((event) => event !== null);
    }
}
/** Exported for tests: build a state object without touching disk. */
export function createInitialState(now = Date.now()) {
    return createState(now);
}
