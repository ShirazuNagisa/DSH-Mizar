import { SELECTABLE_RELAY_URLS } from '../config.js';
/** The relay a free account uses. */
export declare const FREE_RELAY_URL = "https://dshmizar.shirazu-nagisa.com";
/** The account/paid relay, which is also the only host that can verify a session. */
export declare const PAID_RELAY_URL = "https://dshmizar-1.shirazu-nagisa.com";
/** The origins `relay.set` will agree to move this computer to. */
export { SELECTABLE_RELAY_URLS };
/** Where the remembered choice lives, under the plugin's state directory. */
export declare const RELAY_OVERRIDE_FILE = "relay-override.json";
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
export declare function canonicalRelayURL(value: string): string | null;
/**
 * Whether a phone may ask this host to dial the given relay.
 * @param value - the candidate URL.
 * @returns whether it canonicalizes to one of {@link SELECTABLE_RELAY_URLS}.
 */
export declare function isSelectableRelayURL(value: string): boolean;
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
export declare function readRelayOverride(stateDir: string, log?: (message: string) => void): Promise<string | null>;
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
export declare function writeRelayOverride(stateDir: string, url: string): Promise<void>;
