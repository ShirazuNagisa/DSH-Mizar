/**
 * The tunnel protocol, from the computer's side.
 *
 * Declared again here rather than imported from `relay/` so the plugin and the
 * relay stay separately deployable -- a plugin installed from a git checkout has
 * no relay/ directory at all, because the package's `files` list is
 * `["lib", "cordis.patch.yml"]`. The two declarations are pinned by decoding the
 * same golden frames: `protocol/fixtures/relay-tunnel.json` here and
 * `relay/test/protocol.test.ts` there. A shared artifact is what holds a
 * contract; a shared import would only hold a build.
 *
 * @module dsh-mizar/relay/protocol
 */
/** The tunnel protocol version. */
export const TUNNEL_PROTOCOL_VERSION = 1;
/** The path a computer dials to establish its tunnel. */
export const TUNNEL_PATH = '/tunnel';
/**
 * Parse a frame from the relay, refusing anything unrecognised.
 *
 * A relay that is a version ahead may send frames this build does not know; the
 * honest response is to ignore them rather than to guess, so this returns `null`
 * instead of throwing and the caller drops the frame.
 *
 * @param text - the raw frame.
 * @returns the frame, or `null`.
 */
export function parseRelayFrame(text) {
    let value;
    try {
        value = JSON.parse(text);
    }
    catch {
        return null;
    }
    if (typeof value !== 'object' || value === null)
        return null;
    const t = value.t;
    if (typeof t !== 'string')
        return null;
    const known = ['welcome', 'req', 'ws-open', 'ws-msg', 'ws-close', 'ping'];
    if (!known.includes(t))
        return null;
    return value;
}
