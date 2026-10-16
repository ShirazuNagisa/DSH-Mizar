/**
 * This Mac's tunnel identity.
 *
 * The relay serves everyone, so there is no shared token to hand out: a token
 * that identified one Mac would put every user in the same room, able to see
 * each other's sessions. Instead each install invents its own secret the first
 * time it runs, keeps it, and presents it to the relay. The relay derives a room
 * from it, so the room is a function of something only this machine knows.
 *
 * That is what makes "install the plugin and scan" possible. There is nothing
 * for a user to configure, and nothing for an operator to issue, revoke or keep
 * in sync between two files.
 *
 * The secret is a capability, not an identity: anyone holding it can act as this
 * Mac on the relay. It is written 0600 in Mizar's own state directory, and it
 * never leaves the machine except as a bearer token on the tunnel connection.
 *
 * @module dsh-mizar/relay/identity
 */
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
/** The file holding this install's tunnel secret. */
export const IDENTITY_FILE = 'tunnel.json';
/** Bytes of entropy. 32 bytes is 256 bits; the room keeps 60 of them. */
const SECRET_BYTES = 32;
/**
 * Read this install's tunnel secret, creating one on first run.
 *
 * Generated rather than configured, and generated here rather than by the relay,
 * because the relay must not be the one choosing secrets it will later trust.
 *
 * A file that cannot be written is not fatal: the identity is returned for this
 * process's lifetime, so the tunnel still works and the operator sees a working
 * plugin with a warning. The alternative -- refusing to start -- would turn a
 * read-only home directory into a plugin that does nothing at all.
 *
 * @param stateDir - Mizar's state directory.
 * @param log - where to report a failure to persist.
 * @returns the tunnel secret.
 */
export async function loadOrCreateTunnelSecret(stateDir, log) {
    const path = join(stateDir, IDENTITY_FILE);
    const existing = await readSecret(path);
    if (existing !== null)
        return existing;
    const secret = randomBytes(SECRET_BYTES).toString('base64url');
    try {
        await mkdir(stateDir, { recursive: true });
        const stored = { tunnelSecret: secret, createdAt: new Date().toISOString() };
        await writeFile(path, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
        // `mode` only applies when the file is created, and this path is reached
        // with the file already present whenever it was unreadable -- a truncated
        // one, say. Without this, a file that was 0644 stays 0644, and the comment
        // above about it being owner-only would be a claim rather than a fact.
        await chmod(path, 0o600).catch(() => { });
    }
    catch (error) {
        log(`relay: could not save this Mac's tunnel identity to ${path} ` +
            `(${error instanceof Error ? error.message : String(error)}) — ` +
            'it will work until DSH restarts, then the room changes and phones must re-pair');
    }
    return secret;
}
/**
 * Read a stored secret, treating anything unreadable as absent.
 *
 * @param path - the file to read.
 * @returns the secret, or `null`.
 */
async function readSecret(path) {
    let text;
    try {
        text = await readFile(path, 'utf8');
    }
    catch {
        return null;
    }
    try {
        const value = JSON.parse(text);
        if (typeof value.tunnelSecret === 'string' && value.tunnelSecret.length >= 16) {
            return value.tunnelSecret;
        }
    }
    catch {
        // A truncated file is replaced rather than reported: a new identity costs a
        // re-pair, and refusing to start costs everything.
    }
    return null;
}
