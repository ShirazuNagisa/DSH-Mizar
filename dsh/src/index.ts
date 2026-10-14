/**
 * dsh-mizar — host half.
 *
 * Companion plugin that backs the DSH-Mizar iOS app: it owns a standalone
 * listener (never the shared DSH webserver), pairs devices, and bridges DSH's
 * own session/model/permission/usage/services into mobile-shaped frames.
 *
 * Phase 0.1 ships only the load path plus the spike that settles whether a
 * third-party plugin can drive the shipped Remotes in-process.
 *
 * @module dsh-mizar
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from './dsh.js'
import { Config } from './config.js'
import type { Config as MizarConfig } from './config.js'
import { runSpike } from './spike.js'

/** Cordis plugin name. */
export const name = 'mizar'

/**
 * Services this plugin must observe before it activates.
 *
 * `typertGateway` drives the shipped Remotes, `sessionProjections` and
 * `sessions` back the usage and transcript bridges, and `typert` is required to
 * read the strict descriptor registry the readiness gate polls — Cordis refuses
 * `ctx.typert` to a plugin that does not declare it.
 */
export const inject = ['typert', 'typertGateway', 'sessionProjections', 'sessions']

/**
 * Mount the Mizar host half.
 * @param ctx - the plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: MizarConfig): void {
  // Phase 0.1 load marker. `apply` runs only once every name in `inject`
  // resolves, so this line distinguishes "the bundle loaded and activated" from
  // "the row is composed but still waiting on a service". Plain stdout, because
  // a Cordis logger's visibility depends on the composition's exporters.
  console.log('[mizar] apply() entered — injects resolved')
  const logger = ctx.logger('mizar')
  if (!config.enabled) {
    logger.info('mizar: disabled by configuration')
    return
  }

  logger.info(
    'mizar: mounted (bind=%s port=%d fallback=%s tls=%s)',
    config.bind.mode,
    config.port,
    String(config.portFallback),
    config.tls.mode,
  )

  if (!config.spike) return

  const workspace = process.env.DSH_MIZAR_SPIKE_WORKSPACE ?? join(homedir(), 'Documents')
  ctx.effect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        if (!controller.signal.aborted) await runSpike(ctx, workspace)
      } catch (error) {
        console.error('[mizar] spike crashed —', error)
      }
    })()
    return () => controller.abort()
  }, 'mizar:phase-0.1-spike')
}

export { Config }
