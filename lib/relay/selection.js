/**
 * Which relay this computer may be moved between, and where that choice is kept.
 *
 * The tunnel credential, and therefore the room, is derived from the token and
 * not from the relay address: moving between the two public relays keeps every
 * paired phone's pairing intact. What changes is only the address a phone dials,
 * which is why the phone asks for the move and the host remembers it.
 *
 * The set is an allowlist on purpose. A paired phone can name the relay it wants
 * this computer to use, so the host has to bound what "the relay" can mean -- a
 * compromised or merely buggy client must not be able to point this computer's
 * tunnel at an arbitrary server that would then see every request.
 *
 * @module dsh-mizar/relay/selection
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ACCOUNT_RELAY_URL, PUBLIC_RELAY_URL, SELECTABLE_RELAY_URLS, } from '../config.js';
/** The relay a free account uses. */
export const FREE_RELAY_URL = PUBLIC_RELAY_URL;
/** The account/paid relay, which is also the only host that can verify a session. */
export const PAID_RELAY_URL = ACCOUNT_RELAY_URL;
/** The origins `relay.set` will agree to move this computer to. */
export { SELECTABLE_RELAY_URLS };
/** Where the remembered choice lives, under the plugin's state directory. */
export const RELAY_OVERRIDE_FILE = 'relay-override.json';
/**
 * Normalize a relay origin.
 *
 * Accepts what a human or an app would send: an `https://host` URL, optionally
 * with a trailing slash. Rejects anything that is not an origin -- a path, a
 * query, a fragment, credentials -- because those would make the same relay look
 * different to different call sites, and one of them would be a stranger.
 *
 * @param value - the candidate URL.
 * @returns the canonical origin, or `null` when the value is not one.
 */
export function canonicalRelayURL(value) {
    let parsed;
    try {
        parsed = new URL(value);
    }
    catch {
        return null;
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
        return null;
    if (parsed.username !== '' || parsed.password !== '')
        return null;
    if (parsed.search !== '' || parsed.hash !== '')
        return null;
    if (parsed.pathname !== '/' && parsed.pathname !== '')
        return null;
    return `${parsed.protocol}//${parsed.host}`;
}
/**
 * Whether a phone may ask this host to dial the given relay.
 * @param value - the candidate URL.
 * @returns whether it canonicalizes to one of {@link SELECTABLE_RELAY_URLS}.
 */
export function isSelectableRelayURL(value) {
    const canonical = canonicalRelayURL(value);
    return canonical !== null && SELECTABLE_RELAY_URLS.includes(canonical);
}
/** Path of the remembered choice. */
function overridePath(stateDir) {
    return join(stateDir, RELAY_OVERRIDE_FILE);
}
/**
 * Read the remembered relay choice.
 *
 * A missing file is the normal case. A file that cannot be read, or that names
 * a relay outside the allowlist, is logged and ignored rather than fatal: the
 * configured relay still works, and refusing to start over a stale preference
 * would make a bad write take the tunnel down.
 *
 * @param stateDir - the plugin's state directory.
 * @param log - operator-facing diagnostics.
 * @returns the remembered relay origin, or `null`.
 */
export async function readRelayOverride(stateDir, log = () => { }) {
    let raw;
    try {
        raw = await readFile(overridePath(stateDir), 'utf8');
    }
    catch (error) {
        const code = error.code;
        if (code !== 'ENOENT') {
            log(`relay: could not read the remembered relay choice (${code ?? 'unknown'}) — using the configured one`);
        }
        return null;
    }
    try {
        const parsed = JSON.parse(raw);
        if (typeof parsed.url !== 'string' || !isSelectableRelayURL(parsed.url)) {
            log('relay: ignoring the remembered relay choice — it names no selectable relay');
            return null;
        }
        return canonicalRelayURL(parsed.url);
    }
    catch {
        log('relay: ignoring the remembered relay choice — it is not valid JSON');
        return null;
    }
}
/**
 * Remember the relay a phone asked for.
 *
 * Written even when the requested relay is already the configured one: the file
 * is then an explicit statement that survives a later configuration change,
 * which is what makes an account logging out put the computer back on the free
 * relay rather than leaving it wherever the last paid session left it.
 *
 * @param stateDir - the plugin's state directory.
 * @param url - the relay origin to remember.
 * @throws when the URL is not one of the selectable relays.
 */
export async function writeRelayOverride(stateDir, url) {
    const canonical = canonicalRelayURL(url);
    if (canonical === null || !SELECTABLE_RELAY_URLS.includes(canonical)) {
        throw new Error(`relay: refusing to remember a relay outside the allowlist: ${url}`);
    }
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    const target = overridePath(stateDir);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ url: canonical }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
}
