/**
 * dsh-mizar — host half.
 *
 * Companion plugin backing the DSH-Mizar iOS app. It owns a standalone listener
 * (never the shared DSH webserver, whose bind policy DSH deliberately keeps
 * loopback-only), pairs devices, and — from Phase 2 — bridges DSH's own session,
 * model, permission and usage services into mobile-shaped frames.
 *
 * @module dsh-mizar
 */
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import type { Context } from './dsh.js'
import { Config } from './config.js'
import type { Config as MizarConfig } from './config.js'
import { registerAnswerers } from './bridge/answerers.js'
import { createMethodTable } from './bridge/index.js'
import { InteractionBroker } from './bridge/interactions.js'
import { registerPanelApi } from './panel/api.js'
import { MizarStore, resolveMizarHome } from './auth/store.js'
import { selectBindAddresses, snapshotInterfaces, type BindPlan } from './net/interfaces.js'
import {
  bringTailscaleUp,
  describeTailscaleState,
  findTailscaleCli,
  readTailscaleState,
} from './net/tailscale.js'
import { awaitRequestedPlan, bindKey, needsRebind } from './net/watch.js'
import { PROTOCOL_VERSION } from './protocol/frames.js'
import { MizarListener } from './server/listener.js'
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
 * Watch the bind plan and rebind when the host's addresses change.
 *
 * Covers the case the startup wait cannot: Tailscale connected long after DSH
 * started, reconnected after a reboot, or moved to a different address. Without
 * this the listener would sit on loopback forever and the phone would simply
 * never reach it.
 *
 * @param config - plugin configuration.
 * @param readPlan - reads the current plan.
 * @param holder - the listener handle, swapped on rebind.
 * @param initial - the plan the listener is bound to now.
 * @param signal - aborted when the plugin unloads.
 */
function startBindWatcher(
  config: MizarConfig,
  readPlan: () => BindPlan,
  holder: { current: MizarListener | null },
  initial: BindPlan,
  signal: AbortSignal,
): void {
  let current = bindKey(initial)

  const timer = setInterval(() => {
    void (async () => {
      const next = readPlan()
      if (!needsRebind(current, next)) return
      const listener = holder.current
      if (listener === null) return

      report(`network changed — rebinding from [${current}] to [${bindKey(next)}]`)
      try {
        await listener.rebind(next)
        current = bindKey(next)
      } catch (error) {
        report(`rebind failed, staying on [${current}] — ${describe(error)}`)
      }
    })()
  }, Math.max(1000, config.bind.pollMs))
  timer.unref?.()
  signal.addEventListener('abort', () => clearInterval(timer))
}

/**
 * Say why a tailnet address was not found, and optionally fix it.
 *
 * "No Tailscale interface found" covers three different situations with three
 * different remedies, and only one of them is something the plugin can do.
 *
 * @param config - plugin configuration.
 * @param fallback - the plan that was chosen instead.
 */
async function explainTailscale(config: MizarConfig, fallback: BindPlan): Promise<void> {
  if (config.bind.mode !== 'tailscale') {
    report(`binding fallback — ${fallback.reason}`)
    return
  }

  const cli = findTailscaleCli()
  if (cli === null) {
    report(describeTailscaleState({ kind: 'absent' }))
    return
  }

  let state = await readTailscaleState(cli)
  report(describeTailscaleState(state))

  if (!config.bind.autoConnect || state.kind !== 'stopped') return

  report('bind.autoConnect is enabled — bringing Tailscale up')
  const result = await bringTailscaleUp(cli)
  if (!result.ok) {
    report(`could not bring Tailscale up (${result.detail}); start it yourself and the listener will follow`)
    return
  }
  state = await readTailscaleState(cli)
  report(`after tailscale up: ${describeTailscaleState(state)}`)
}

/** Operator-facing diagnostics, on plain stdout. */
function report(message: string): void {
  console.log(`[mizar] ${message}`)
}

/** Render an unknown thrown value as one line. */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Start the listener for one plugin mount and return its disposer.
 *
 * @param ctx - the plugin context, used for the lifecycle effect.
 * @param config - validated plugin configuration.
 * @param signal - aborted when the plugin unloads.
 */
async function startListener(
  ctx: Context,
  config: MizarConfig,
  signal: AbortSignal,
): Promise<MizarListener> {
  const stateDir = resolveMizarHome()
  const store = await MizarStore.open(stateDir)

  const readPlan = (): BindPlan =>
    selectBindAddresses(snapshotInterfaces(), config.bind.mode, config.bind.addresses)

  // Wait for the requested mode to take effect before accepting a fallback. DSH
  // and Tailscale both start at login with nothing ordering them, and a one-shot
  // decision that lands on loopback stays there for the life of the process.
  let plan = await awaitRequestedPlan(readPlan, {
    waitMs: config.bind.waitForMs,
    pollMs: 1000,
    signal,
    onGiveUp: (fallback) => {
      report(
        `no ${config.bind.mode} address after ${Math.round(config.bind.waitForMs / 1000)}s — ` +
          `${fallback.reason}`,
      )
      void explainTailscale(config, fallback)
    },
  })

  const liveDevices = store.state.devices.filter((d) => d.revokedAt === undefined).length
  report(`state: ${stateDir} · devices: ${liveDevices} live`)

  // Created before the listener so the method table can reach it, and given its
  // transport only once the listener is up: the broker must not hold a socket
  // reference that outlives the server.
  const broker = new InteractionBroker()

  const methods = createMethodTable(
    ctx,
    {
      hostId: store.state.hostId,
      hostName: hostname(),
      home: stateDir,
      protocolVersion: PROTOCOL_VERSION,
    },
    broker,
  )

  // A stable handle the rest of the plugin reads through, so a rebind can swap
  // the listener without every consumer holding a stale reference.
  const holder: { current: MizarListener | null } = { current: null }

  const listener = await MizarListener.start({
    plan,
    port: config.port,
    portFallback: config.portFallback,
    store,
    pairingTtlSeconds: config.pairing.codeTtlSeconds,
    maxAttemptsPerMinute: config.pairing.maxAttemptsPerMinute,
    heartbeatMs: config.reconnect.heartbeatMs,
    pongTimeoutMs: config.reconnect.pongTimeoutMs,
    log: report,
    onSession: (session) => {
      report(`client connected: ${session.deviceName} from ${session.remote}`)
    },
    // Dropping to zero clients is the broker's fail-closed trigger: an approval
    // with nobody left to answer it must settle rather than hang the agent.
    onClientCount: (count) => broker.setClientCount(count),
    // The bridge speaks in terms of its own context; the listener speaks in
    // terms of the connection. Adapting here keeps both sides ignorant of the
    // other's vocabulary.
    methods: Object.fromEntries(
      Object.entries(methods).map(([name, handler]) => [
        name,
        (payload: unknown, session: { deviceId: string; deviceName: string; remote: string }) =>
          handler(payload, {
            deviceId: session.deviceId,
            deviceName: session.deviceName,
            remote: session.remote,
          }),
      ]),
    ),
  })

  holder.current = listener
  broker.setSender((frame) => holder.current?.broadcast(frame))

  // Panel routes ride DSH's own authenticated /api channel; a composition with
  // no browser carrier simply gets no panel and keeps everything else.
  // The host is read through the holder so a rebind is visible to the panel
  // without re-registering the routes.
  registerPanelApi(ctx, {
    host: {
      get authorities() {
        return holder.current?.authorities ?? []
      },
      get clientCount() {
        return holder.current?.clientCount ?? 0
      },
      issuePairingCode: () => {
        const current = holder.current
        if (current === null) throw new Error('the listener is not running')
        return current.issuePairingCode()
      },
      revokeDevice: (deviceId: string) => {
        const current = holder.current
        if (current === null) return Promise.resolve(false)
        return current.revokeDevice(deviceId)
      },
    },
    store,
    plan,
    hostName: hostname(),
    protocolVersion: PROTOCOL_VERSION,
    log: report,
  })
  // Registered with `prepend`, so the phone is asked alongside the desktop GUI
  // rather than only when the GUI declines.
  registerAnswerers(ctx, broker)

  startBindWatcher(config, readPlan, holder, plan, signal)

  signal.addEventListener('abort', () => {
    // Release anything still waiting before the transport disappears, so no
    // agent is left holding a turn open for a question nobody can answer.
    broker.dispose()
    void listener.stop().catch((error: unknown) => {
      report(`listener shutdown failed — ${describe(error)}`)
    })
  })

  if (config.pairing.issueOnStart) {
    const issued = await listener.issuePairingCode()
    report(`pairing code: ${issued.display} (valid for ${config.pairing.codeTtlSeconds}s)`)
  }

  return listener
}

/**
 * Mount the Mizar host half.
 * @param ctx - the plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: MizarConfig): void {
  // `apply` runs only once every name in `inject` resolves, so this line
  // distinguishes "the bundle loaded and activated" from "the row is composed
  // but still waiting on a service". Plain stdout, because a Cordis logger's
  // visibility depends on the composition's exporters.
  report('apply() entered — injects resolved')

  if (!config.enabled) {
    report('disabled by configuration')
    return
  }

  report(
    `mounted (bind=${config.bind.mode} port=${config.port} fallback=${String(config.portFallback)} tls=${config.tls.mode})`,
  )

  ctx.effect(() => {
    const controller = new AbortController()

    void (async () => {
      try {
        const listener = await startListener(ctx, config, controller.signal)
        if (controller.signal.aborted) {
          await listener.stop()
          return
        }
        report(
          `ready — pair with the code shown in the DSH Web panel, or reach ${listener.authorities.join(' / ')}`,
        )
      } catch (error) {
        report(`listener failed to start — ${describe(error)}`)
      }
    })()

    return () => controller.abort()
  }, 'mizar:listener')

  if (!config.spike) return

  const workspace = process.env['DSH_MIZAR_SPIKE_WORKSPACE'] ?? join(homedir(), 'Documents')
  ctx.effect(() => {
    const controller = new AbortController()
    void (async () => {
      try {
        if (!controller.signal.aborted) await runSpike(ctx, workspace)
      } catch (error) {
        report(`spike crashed — ${describe(error)}`)
      }
    })()
    return () => controller.abort()
  }, 'mizar:phase-0.1-spike')
}

export { Config }
