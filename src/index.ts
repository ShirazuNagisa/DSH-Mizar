/**
 * dsh-mizar 0.9.0 — the helper plugin.
 *
 * This is not the 0.8.x plugin with features removed. It is a different thing
 * with the same name: a pipe between the DSH process and the AGI Mizar desktop
 * app, and nothing else. There is no listener, no pairing, no device roster, no
 * relay, no push, no panel. Those all moved to the desktop, which is the only
 * side that talks to a phone now.
 *
 * ### What is left, and why each part has to be here
 *
 * - **The event feed** — `session/event` and `projection/changed` are in-process
 *   subscriptions. Nothing outside the process can hear them.
 * - **The endpoint proxy** — `ctx.typertGateway` is an in-process service.
 * - **The service proxy** — the workspace registry and projection store have no
 *   Typert endpoint at all.
 * - **The waterfall answerers** — `approval/request` and `user-questions/request`
 *   are Cordis waterfalls. A channel that is not in the process cannot be a peer
 *   in one, which is exactly why the desktop cannot do this half itself.
 *
 * ### What a user sees if they install this alone
 *
 * Nothing. That is deliberate and it is logged once at startup: with no desktop
 * running, this plugin must behave as though it were not installed at all.
 *
 * @module dsh-mizar
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Context } from './dsh.js'
import { Config } from './config.js'
import type { Config as PluginConfig } from './config.js'
import { InteractionBroker, registerAnswerers } from './bridge/interactions.js'
import { LinkClient } from './link/client.js'
import { Dispatcher } from './link/dispatch.js'
import { EventFeed } from './link/events.js'
import { LINK_VERSION } from './link/frames.js'
import { sharedMountRegistry, type Mounted } from './mount.js'
import { localEndpoints } from './ready.js'

/** Cordis plugin name. Unchanged from 0.8.x so profiles keep loading it. */
export const name = 'mizar'

/**
 * Services this plugin must observe before it activates.
 *
 * `typert` backs the descriptor registry the handshake reports, `typertGateway`
 * carries endpoint calls, `sessionProjections` feeds the change subscription, and
 * `sessions` is what a session event arrives with. Everything else — the
 * workspace registry in particular — is read through `ctx.get` so that a
 * composition without it still activates.
 */
export const inject = ['typert', 'typertGateway', 'sessionProjections', 'sessions']

/**
 * The version this build reports.
 *
 * Printed at startup because the most expensive confusion in this project's
 * history was not knowing whether a fix was running: a plugin loads when DSH
 * starts, so reinstalling without restarting leaves the old code in place.
 */
const PLUGIN_VERSION = '0.9.0'

/**
 * Operator-facing diagnostics: stdout, and a file.
 *
 * stdout is enough for a CLI profile and useless for a packaged app — a window
 * launched from Finder has nowhere to put it. This plugin has no panel, so a
 * file is the only channel left when the link does not come up. It is appended
 * to and truncated on load; a plugin that cannot start must still say why.
 */
function report(message: string): void {
  console.log(`[mizar] ${message}`)
  try {
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${message}\n`)
  } catch {
    // A log that cannot be written is not a reason to fail the plugin.
  }
}

/** `~/.agi-mizar/dsh-plugin.log`. */
const LOG_PATH = join(homedir(), '.agi-mizar', 'dsh-plugin.log')

/** Render an unknown thrown value as one line. */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * One running mount: the link and everything wired to it.
 *
 * `dispose` is the single shutdown path, idempotent and awaitable, because an
 * unload and a replacement mount can both ask for it.
 */
interface LinkMount extends Mounted {
  readonly connected: () => boolean
}

/**
 * Start the link and wire the two feeds to it.
 *
 * @param ctx - the plugin context.
 * @param config - validated plugin configuration.
 * @param signal - aborted when the plugin unloads.
 */
function startLink(ctx: Context, config: PluginConfig, signal: AbortSignal): LinkMount {
  const broker = new InteractionBroker()
  let client: LinkClient | null = null

  const send = (frame: Parameters<LinkClient['send']>[0]): boolean =>
    client === null ? false : client.send(frame)
  broker.setSender(send)

  const dispatcher = new Dispatcher({
    ctx,
    send,
    broker,
    services: config.services,
    log: report,
    logCalls: true,
  })

  const feed = new EventFeed(send, config.logEvents)
  const unbind = feed.bind(ctx)

  // Registered before the first dial: an approval that arrives while the link is
  // still connecting must find the answerer in place, or it is answered by the
  // GUI alone and the desktop never sees it.
  registerAnswerers(ctx, broker)

  client = new LinkClient({
    endpointFile: config.endpointFile,
    identity: () => {
      let endpoints: string[] = []
      try {
        endpoints = [...localEndpoints(ctx)]
      } catch {
        // A registry that is not readable yet is not a reason to refuse the
        // handshake: the desktop can ask again through `invoke`.
      }
      return {
        plugin: { name: 'dsh-mizar', version: PLUGIN_VERSION, linkVersion: LINK_VERSION },
        dsh: {
          platform: process.platform,
          home: process.env['DSH_HOME'] ?? join(homedir(), '.dsh'),
          node: process.version,
        },
        endpoints,
        services: config.services,
      }
    },
    onFrame: (frame) => dispatcher.handle(frame),
    onUp: (welcome) => {
      broker.setConnected(true)
      report(
        `link up with ${welcome.desktop ?? 'AGI Mizar'} — ` +
          `${localEndpointsSafe(ctx)} endpoints, ${config.services.length} services`,
      )
    },
    onDown: (reason) => {
      broker.setConnected(false)
      report(`link down — ${reason} (pending approvals settled unavailable)`)
    },
    log: report,
    reconnect: config.reconnect,
  })

  client.start()

  let shutdown: Promise<void> | null = null
  const dispose = (): Promise<void> => {
    shutdown ??= (async () => {
      // Stop writing first, then release the work: a stream that is still
      // pumping would otherwise send into a closed socket, and a pending
      // approval would keep an agent waiting for an operator who has left.
      client?.stop()
      dispatcher.dispose()
      broker.dispose()
      unbind()
    })()
    return shutdown
  }
  signal.addEventListener('abort', () => {
    void dispose()
  })

  return { connected: () => client?.connected ?? false, dispose }
}

/** The endpoint count, without letting a failed read break a log line. */
function localEndpointsSafe(ctx: Context): number {
  try {
    return localEndpoints(ctx).size
  } catch {
    return 0
  }
}

/**
 * The one mount this process runs at a time.
 *
 * DSH may compose or re-apply a bundle more than once. Two mounts would mean two
 * links and two sets of waterfall listeners, which shows up as duplicated
 * approvals and events. The registry serialises them.
 */
const mounts = sharedMountRegistry()

/**
 * Mount the helper plugin.
 * @param ctx - the plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: PluginConfig): void {
  // Truncated on load: this file describes one run, and a stale tail from last
  // week is worse than no tail at all.
  try {
    mkdirSync(join(homedir(), '.agi-mizar'), { recursive: true })
    writeFileSync(LOG_PATH, '')
  } catch {
    // Best effort.
  }
  report('apply() entered — injects resolved')

  if (!config.enabled) {
    report('disabled by configuration')
    return
  }

  report(
    `dsh-mizar ${PLUGIN_VERSION} — helper plugin: no listener, no pairing, no relay. ` +
      `Waiting for AGI Mizar at ${config.endpointFile}`,
  )

  ctx.effect(() => {
    const controller = new AbortController()
    let mounted: LinkMount | null = null

    void mounts
      .start(async () => {
        if (controller.signal.aborted) return null
        try {
          mounted = startLink(ctx, config, controller.signal)
          return mounted
        } catch (error) {
          // Swallowed by the registry otherwise, and a plugin that silently
          // does nothing is the worst failure this thing can have.
          report(`link failed to start — ${describe(error)}`)
          return null
        }
      })
      .catch((error: unknown) => report(`mount failed — ${describe(error)}`))

    return () => {
      controller.abort()
      void mounts.stop(mounted)
      mounted = null
    }
  }, 'mizar:link')
}

export { Config }
