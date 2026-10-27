import type { Context } from './dsh.js';
import { Config } from './config.js';
import type { Config as PluginConfig } from './config.js';
/** Cordis plugin name. Unchanged from 0.8.x so profiles keep loading it. */
export declare const name = "mizar";
/**
 * Services this plugin must observe before it activates.
 *
 * `typert` backs the descriptor registry the handshake reports, `typertGateway`
 * carries endpoint calls, `sessionProjections` feeds the change subscription, and
 * `sessions` is what a session event arrives with. Everything else — the
 * workspace registry in particular — is read through `ctx.get` so that a
 * composition without it still activates.
 */
export declare const inject: string[];
/**
 * Mount the helper plugin.
 * @param ctx - the plugin context.
 * @param config - validated plugin configuration.
 */
export declare function apply(ctx: Context, config: PluginConfig): void;
export { Config };
