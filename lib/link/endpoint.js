/**
 * The file the desktop app publishes its address in.
 *
 * Written by AGI Mizar before it starts serving, and rewritten on every launch
 * because the token is minted per launch. The plugin treats it as the only
 * source of truth: no port is configured here, and no token is stored anywhere
 * else. That is what makes "the desktop is not running" a state the plugin can
 * express without a setting to get wrong.
 *
 * @module dsh-mizar/link/endpoint
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
/**
 * Resolve a leading `~` to the user's home directory.
 *
 * `node:fs` does not expand it, and the default configuration is written the way
 * a person writes a path.
 *
 * @param file - a path that may start with `~`.
 * @returns an absolute path.
 */
export function expandHome(file) {
    if (file === '~')
        return homedir();
    if (file.startsWith('~/') || file.startsWith('~\\'))
        return join(homedir(), file.slice(2));
    return isAbsolute(file) ? file : join(homedir(), file);
}
/**
 * Read and validate the endpoint file.
 *
 * Every failure — missing, unreadable, malformed, out of range — is the same
 * answer: `null`, meaning "there is no desktop to dial right now". The caller
 * retries; it must not distinguish these cases, because they are all transient
 * (the desktop is starting, restarting, or was never installed).
 *
 * @param file - the configured path, possibly with `~`.
 * @returns the endpoint, or `null` when there is not a usable one.
 */
export async function readEndpoint(file) {
    let raw;
    try {
        raw = await readFile(expandHome(file), 'utf8');
    }
    catch {
        return null;
    }
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof value !== 'object' || value === null)
        return null;
    const record = value;
    const port = record['port'];
    const token = record['token'];
    if (typeof port !== 'number' || !Number.isInteger(port) || port <= 0 || port > 65_535)
        return null;
    if (typeof token !== 'string' || token === '')
        return null;
    const pid = record['pid'];
    return {
        port,
        token,
        ...(typeof pid === 'number' && Number.isInteger(pid) ? { pid } : {}),
    };
}
