/**
 * DSH Link v1 — the wire between this plugin and the AGI Mizar desktop app.
 *
 * One loopback WebSocket, and the plugin is the **client**. That direction is
 * the whole security posture: the plugin opens no port, advertises nothing, and
 * has no reachable surface when the desktop is not running. It also means the
 * desktop can be restarted at will without leaving a stale listener behind.
 *
 * ### Two properties the frames have to keep
 *
 * **Opaqueness.** `payload`, `value`, `request` and `details` are carried
 * through untouched. This module validates the envelope and nothing inside it.
 * The plugin is not allowed to know what a session event looks like, because the
 * day it does, a new DSH field needs a new plugin release.
 *
 * **Fidelity.** `toWire` is a total serialiser with one job: produce what
 * `JSON.stringify` would produce, minus the values JSON cannot carry. It must
 * never drop a key because the key was not expected — that is the difference
 * between "the desktop can use a new field tomorrow" and "the plugin silently
 * ate it".
 *
 * @module dsh-mizar/link/frames
 */
/** Protocol version of this link. Independent of DSH's own versions. */
export const LINK_VERSION = 1;
/** The path the desktop serves this link on. */
export const LINK_PATH = '/dsh';
/**
 * Serialise a value for the wire without losing anything JSON can carry.
 *
 * `JSON.stringify` already does most of this. The replacer exists for the four
 * things it cannot: functions and symbols (dropped, as JSON does), bigints
 * (rendered as strings rather than throwing), and `AbortSignal`s — which appear
 * on Cordis waterfall payloads and would otherwise be serialised as an empty
 * object that looks like data.
 *
 * A value that cannot be serialised at all (a cycle) becomes a marker rather
 * than an exception: one weird record must not take down the feed.
 *
 * @param value - anything.
 * @returns a JSON-safe projection of it.
 */
export function toWire(value) {
    try {
        const text = JSON.stringify(value, (_key, item) => {
            if (typeof item === 'function' || typeof item === 'symbol')
                return undefined;
            if (typeof item === 'bigint')
                return item.toString();
            if (item instanceof AbortSignal)
                return undefined;
            if (item instanceof Error) {
                return { name: item.name, message: item.message, stack: item.stack };
            }
            return item;
        });
        return text === undefined ? null : JSON.parse(text);
    }
    catch {
        return { __unserializable: true, kind: typeof value };
    }
}
/** Read a string field from an unknown record. */
function text(record, key) {
    const value = record[key];
    return typeof value === 'string' ? value : undefined;
}
/**
 * Parse one frame the desktop sent.
 *
 * Unknown frame types return `null` rather than throwing: a desktop that grew a
 * frame this plugin does not know is a version skew, and the right answer is to
 * ignore that frame, not to drop the connection.
 *
 * @param raw - the text of one WebSocket message.
 * @returns the frame, or `null` when it is not one this version understands.
 */
export function parseDesktopFrame(raw) {
    let value;
    try {
        value = JSON.parse(raw);
    }
    catch {
        return null;
    }
    if (typeof value !== 'object' || value === null)
        return null;
    const frame = value;
    const type = text(frame, 'type');
    if (type === undefined)
        return null;
    switch (type) {
        case 'welcome': {
            const linkVersion = frame['linkVersion'];
            return {
                v: LINK_VERSION,
                type: 'welcome',
                linkVersion: typeof linkVersion === 'number' ? linkVersion : 0,
                ...(text(frame, 'desktop') === undefined ? {} : { desktop: text(frame, 'desktop') }),
            };
        }
        case 'invoke': {
            const id = text(frame, 'id');
            const endpoint = text(frame, 'endpoint');
            if (id === undefined || endpoint === undefined)
                return null;
            const mode = frame['mode'] === 'stream' ? 'stream' : 'unary';
            return { v: LINK_VERSION, type: 'invoke', id, endpoint, args: frame['args'], mode };
        }
        case 'service': {
            const id = text(frame, 'id');
            const service = text(frame, 'service');
            const method = text(frame, 'method');
            if (id === undefined || service === undefined || method === undefined)
                return null;
            const args = Array.isArray(frame['args']) ? frame['args'] : [];
            return { v: LINK_VERSION, type: 'service', id, service, method, args };
        }
        case 'cancel': {
            const id = text(frame, 'id');
            return id === undefined ? null : { v: LINK_VERSION, type: 'cancel', id };
        }
        case 'answer': {
            const id = text(frame, 'id');
            if (id === undefined)
                return null;
            const outcome = text(frame, 'outcome');
            const answers = Array.isArray(frame['answers']) ? frame['answers'] : undefined;
            return {
                v: LINK_VERSION,
                type: 'answer',
                id,
                ...(outcome === undefined ? {} : { outcome }),
                ...(answers === undefined ? {} : { answers }),
            };
        }
        case 'filter': {
            const drop = Array.isArray(frame['drop'])
                ? frame['drop'].filter((entry) => typeof entry === 'string')
                : [];
            return { v: LINK_VERSION, type: 'filter', drop };
        }
        default:
            return null;
    }
}
/**
 * Build the handshake this plugin sends.
 * @param input - token, identities, endpoint and service names.
 * @returns the frame.
 */
export function helloFrame(input) {
    return {
        v: LINK_VERSION,
        type: 'hello',
        token: input.token,
        plugin: input.plugin,
        dsh: input.dsh,
        endpoints: [...input.endpoints],
        services: [...input.services],
    };
}
