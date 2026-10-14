import type { Context } from './dsh.js';
import { Config } from './config.js';
import type { Config as MizarConfig } from './config.js';
/** Cordis plugin name. */
export declare const name = "mizar";
/**
 * Services this plugin must observe before it activates.
 *
 * `typertGateway` drives the shipped Remotes, `sessionProjections` and
 * `sessions` back the usage and transcript bridges, and `typert` is required to
 * read the strict descriptor registry the readiness gate polls — Cordis refuses
 * `ctx.typert` to a plugin that does not declare it.
 */
export declare const inject: string[];
/**
 * Mount the Mizar host half.
 * @param ctx - the plugin context.
 * @param config - validated plugin configuration.
 */
export declare function apply(ctx: Context, config: MizarConfig): void;
export { Config };
