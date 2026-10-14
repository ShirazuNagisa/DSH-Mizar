/**
 * Phase 0.1 spike — settles the one unknown the whole plugin design rests on:
 * **can a third-party plugin drive the shipped Typert Remotes and read session
 * projections from its own Cordis context, in-process, with no wire client?**
 *
 * Three questions, each answered independently and reported as PASS/FAIL:
 *
 *   1. `ctx.typertGateway.invoke()` on a strict generated endpoint.
 *   2. `ctx.sessionProjections.snapshot()` on a live session.
 *   3. `ctx.typertGateway.stream()` on a `mode: 'stream'` endpoint.
 *
 * If (1) or (3) fail, the plugin falls back to calling the `sessionController`
 * business methods directly; projections (2) are a plain Cordis service with no
 * Remote involvement, so they are expected to work either way.
 *
 * @module dsh-mizar/spike
 */
import type { Context } from './dsh.js';
/**
 * Run the Phase 0.1 probe set once and log a single report.
 *
 * The `session/create` call is deliberate: a session has to exist for the
 * projection and stream probes to have something to address. It lands in the
 * development profile's own `$DSH_HOME`, never in the operator's real home.
 *
 * @param ctx - the plugin's own context.
 * @param workspace - absolute directory to root the probe session in.
 */
export declare function runSpike(ctx: Context, workspace: string): Promise<void>;
