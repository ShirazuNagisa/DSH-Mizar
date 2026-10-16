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
import { sessionStats } from './bridge/sessions.js'
import { registerPanelApi } from './panel/api.js'
import { createPushBinding } from './push/binding.js'
import { PushNotifier } from './push/notifier.js'
import { isNotifiable, type ScopedSessionHeader } from './push/scope.js'
import { NoopTransport, RelayTransport, type PushTransport } from './push/transport.js'
import { MizarStore, resolveMizarHome } from './auth/store.js'
import {
  selectBindAddresses,
  snapshotInterfaces,
  type BindPlan,
} from './net/interfaces.js'
import type { BindMode } from './config.js'
import { awaitRequestedPlan, bindKey, isRequested, needsRebind } from './net/watch.js'
import { PROTOCOL_VERSION } from './protocol/frames.js'
import { MizarListener } from './server/listener.js'
import { RelayClient, phoneBaseURL } from './relay/client.js'
import { loadOrCreateTunnelSecret } from './relay/identity.js'
import type { RelayClientState } from './relay/client.js'
import { runSpike } from './spike.js'

/** Cordis plugin name. */
export const name = 'mizar'

/**
 * The two shapes the session-event observer needs, declared structurally.
 *
 * Not imported from `@deepseek-ai/dsh-session`: this file is the composition
 * root, and naming the full `Session` type here would tie the whole plugin's
 * compile to a package it only touches through two fields. The header is
 * `./push/scope.js`'s, so the rule about which sessions are notified about is
 * stated once, where it can be tested.
 */
interface SessionHandle {
  readonly id: string
  readonly header: ScopedSessionHeader
}

/** One post-commit log record, as much of it as the notifier reads. */
interface SessionEventLike {
  readonly type: string
  readonly data?: unknown
}

/**
 * This machine's own language, for a host whose phones have never said.
 *
 * Read once at module load: a process-wide locale does not change while the
 * process runs, and calling it per notification would be work for nothing.
 */
const systemLocale = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return 'en'
  }
})()

/**
 * The version this build reports at startup.
 *
 * Printed because the most expensive confusion in this project's history was
 * not knowing whether a fix was running: a plugin is loaded into the DSH
 * process when it starts, so reinstalling without restarting leaves the old
 * code in place and every symptom unchanged. One line at boot turns that from a
 * guess into a fact.
 */
const MIZAR_VERSION = '0.7.2'

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
 * Covers the case the startup wait cannot: the network changed long after DSH
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
  // The store's survivable failures -- an audit log that stopped accepting
  // lines, for instance -- are the operator's business, not the store's.
  const store = await MizarStore.open(stateDir, (warning) => report(`state: ${warning}`))

  // With a tunnel up, the phone never needs to reach this machine directly, so
  // the listener goes to loopback and stops exporting itself onto whatever
  // network the Mac happens to be on. The tunnel still connects out normally --
  // it talks to the listener over loopback, which is always reachable.
  const bindMode: BindMode =
    config.relay.enabled && config.relay.preferLoopback ? 'loopback' : config.bind.mode
  if (bindMode !== config.bind.mode) {
    report(`relay enabled: binding ${bindMode} instead of ${config.bind.mode}`)
  }

  const readPlan = (): BindPlan =>
    selectBindAddresses(snapshotInterfaces(), bindMode, config.bind.addresses)

  // Wait for the requested mode to take effect before accepting a fallback. DSH
  // and the network both come up at login with nothing ordering them, and a
  // one-shot decision that lands on loopback stays there for the process.
  const waitSeconds = Math.round(config.bind.waitForMs / 1000)
  let plan = await awaitRequestedPlan(readPlan, {
    waitMs: config.bind.waitForMs,
    pollMs: 1000,
    signal,
  })

  if (!isRequested(plan)) {
    report(`no ${bindMode} address after ${waitSeconds}s — ${plan.reason}`)
  }

  const liveDevices = store.state.devices.filter((d) => d.revokedAt === undefined).length
  const withPush = store.state.devices.filter(
    (d) => d.revokedAt === undefined && d.push !== undefined,
  ).length
  // The notification count is on the same line as everything else because the
  // question it answers -- "is my phone actually registered" -- is asked at
  // exactly the moment somebody is looking at this log for the version number.
  report(
    `dsh-mizar ${MIZAR_VERSION} · state: ${stateDir} · devices: ${liveDevices} live` +
      (config.relay.enabled ? ` · push: ${withPush}/${liveDevices} registered` : ' · push: no relay'),
  )

  // No token configured is the normal case, not an error: this install invents
  // its own identity and the relay derives the room from it. That is what makes
  // "install and scan" possible -- there is no per-user credential for anyone to
  // issue, hand out or keep in sync.
  //
  // Resolved here rather than beside the tunnel because notifications need it
  // too: the relay authenticates a push against the same secret it authenticates
  // the tunnel with, which is what keeps a second enrolment mechanism out of the
  // design.
  const tunnelToken =
    config.relay.token !== ''
      ? config.relay.token
      : await loadOrCreateTunnelSecret(stateDir, report)

  const relayBaseURL =
    config.relay.enabled && config.relay.url !== ''
      ? phoneBaseURL(config.relay.url, config.relay.publicUrl)
      : null

  // With no relay there is nowhere to send a notification: pushing needs a
  // server that can reach Apple, and a phone that is asleep has no socket here.
  const pushTransport: PushTransport =
    relayBaseURL === null
      ? new NoopTransport()
      : new RelayTransport({ baseURL: relayBaseURL, token: tunnelToken, log: report })

  const notifier = new PushNotifier({
    transport: pushTransport,
    describeSession: async (sessionId) => {
      try {
        const frame = await sessionStats(ctx, sessionId)
        return frame.stats?.title ?? null
      } catch {
        // A notification is not worth failing over a title.
        return null
      }
    },
    locale: () => {
      // The newest phone that asked, because that is the one most likely to be
      // carried. Falls back to this Mac's own locale, which is right when the
      // operator reads the same language in both places.
      for (let index = store.state.devices.length - 1; index >= 0; index -= 1) {
        const push = store.state.devices[index]?.push
        if (push !== undefined) return push.locale
      }
      return systemLocale
    },
    log: report,
  })

  const push = createPushBinding({ store, notifier, transport: pushTransport, log: report })

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
    push,
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

  // The tunnel is started after the listener and stopped before it: the client
  // replays phone requests onto the listener's port, so it has nothing to talk
  // to until the port exists, and nothing to say once it is gone.
  let relayState: RelayClientState = { connected: false, room: null, lastError: null }

  const relay =
    config.relay.enabled && config.relay.url !== ''
      ? new RelayClient({
          url: config.relay.url,
          token: tunnelToken,
          localPort: listener.port,
          log: report,
          reconnectBaseMs: config.relay.reconnectBaseMs,
          reconnectMaxMs: config.relay.reconnectMaxMs,
          onState: (state) => {
            const wasConnected = relayState.connected
            relayState = state
            if (!state.connected) return
            if (state.room !== null && !wasConnected) {
              const base = phoneBaseURL(config.relay.url, config.relay.publicUrl, state.room)
              if (base !== null) report(`relay: phones should pair against ${base}`)
            }
            // Every reconnect, not only the first. The relay holds push
            // registrations in memory, so a relay restarted under a live tunnel
            // comes back knowing about nobody -- and the tunnel reconnecting is
            // exactly how this Mac finds out. The roster is the durable copy.
            if (!wasConnected) {
              void push
                .republish()
                .then((count) => {
                  if (count > 0) report(`push: re-registered ${count} device(s) with the relay`)
                })
                .catch((error: unknown) => {
                  // Swallowing this is how push dies quietly: the relay keeps
                  // its registrations in memory, so a reconnect that failed to
                  // hand them over leaves every phone silent with nothing in
                  // the log to say why.
                  report(`push: could not re-register with the relay — ${describe(error)}`)
                })
            }
          },
        })
      : null
  if (config.relay.enabled && relay === null) {
    report('relay: enabled but no url is configured — not connecting')
  }
  relay?.start()

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
      revokeDevice: async (deviceId: string) => {
        const current = holder.current
        // Revoking from the panel goes straight to the listener, which is the
        // one path that removes a device without passing through the push
        // binding -- and the binding is where every other removal tells the
        // notifier and the relay. Two things are left behind if this path skips
        // it:
        //
        //   - a foreground flag that is never cleared, because a revoked device
        //     never reports a `false` again -- so the notifier goes on holding
        //     presence for a phone that is not on the roster; and
        //   - a registration at the relay, which pushes to that phone's token
        //     until the relay restarts. A device the operator has just removed
        //     should stop being woken about this Mac's work immediately, not at
        //     the next deploy.
        //
        // Both happen before the revocation is attempted, so a revocation that
        // fails still leaves the safer of the two states behind.
        await push.unregister(deviceId)
        if (current === null) return false
        return current.revokeDevice(deviceId)
      },
    },
    store,
    plan,
    hostName: hostname(),
    protocolVersion: PROTOCOL_VERSION,
    relay: {
      get enabled() {
        return config.relay.enabled
      },
      get state() {
        return relayState
      },
      get pairBaseURL() {
        if (relayState.room === null) return null
        return phoneBaseURL(config.relay.url, config.relay.publicUrl, relayState.room)
      },
    },
    log: report,
  })
  // Registered with `prepend`, so the phone is asked alongside the desktop GUI
  // rather than only when the GUI declines.
  registerAnswerers(ctx, broker, notifier)

  // The one exact signal that a turn finished. `session/event` is the post-commit
  // append feed, so this is the log itself rather than a summary of it, and
  // `turn/end` is the only record that ends a turn -- `agent/status` going idle
  // is coarser and also fires for maintenance that is not a turn at all.
  //
  // Unscoped, so it sees every session including subagents and forks. The filter
  // is explicit and one line, and it is written as "would the app draw a row for
  // this session" rather than "is this a subagent", because those are different
  // questions with different answers. The app hides a row carrying either an
  // origin or a parent, and the two are not the same thing: a subagent is a
  // delegated child nobody asked to follow, while a fork is a session the
  // operator duplicated and can go on working in. What both have in common is
  // that the notification would be a banner for a session with no row to open,
  // which is a notification that can only be dismissed.
  ctx.on('session/event', (session: SessionHandle, event: SessionEventLike) => {
    if (!isNotifiable(session.header)) return
    if (event.type === 'turn/end') {
      const reason = (event.data as { reason?: { kind?: unknown } } | undefined)?.reason
      notifier.turnEnded(session.id, typeof reason?.kind === 'string' ? reason.kind : null)
      return
    }
    // A continuation that starts before the quiet period runs out cancels the
    // announcement it was about to earn, which is what keeps one instruction
    // from producing three notifications. The record type goes through so the
    // notifier can tell work from bookkeeping: a title written by the title
    // model, a rename from the desktop GUI or a todo snapshot is not the agent
    // starting up again, and treating it as one swallowed the announcement
    // entirely.
    notifier.noteActivity(session.id, event.type)
  })

  startBindWatcher(config, readPlan, holder, plan, signal)

  signal.addEventListener('abort', () => {
    // The tunnel goes first: it exists to carry traffic to the listener, so
    // leaving it up while the listener closes would produce 502s instead of
    // clean disconnects for whatever is still connected.
    relay?.stop()
    // A pending notification is about a session that has stopped; on unload
    // there is nothing left to announce it with.
    notifier.dispose()
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
    `mounted (bind=${config.bind.mode} port=${config.port} fallback=${String(config.portFallback)})`,
  )
  if (config.tls.mode !== 'off') {
    // The knob is part of the config schema and nothing reads it: the listener
    // speaks plain HTTP, and termination is the reverse proxy's job. Saying so
    // is the difference between "TLS is on" and "somebody set a field".
    report(`tls: mode "${config.tls.mode}" has no effect — this listener does not implement TLS`)
  }

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
