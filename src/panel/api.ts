/**
 * The Web panel's data API.
 *
 * Three exact routes under `/api`, registered on the shared authenticated
 * channel. They reuse DSH's own browser-session cookie rather than inventing a
 * second authentication scheme: the panel runs in the operator's already
 * authenticated browser, and the `/api` bridge's trust fence and cookie check
 * have already run by the time a handler is called.
 *
 * The routes are registered through `ctx.inject`, so a composition without a
 * browser carrier — headless, SDK, a bare test tree — still gets the whole
 * listener and bridge, just no panel. Requiring `connection` in the plugin's
 * `inject` would instead stop Mizar loading altogether on those surfaces.
 *
 * @module dsh-mizar/panel/api
 */
import type { Context } from '../dsh.js'
import { deriveCode } from '../auth/pairing.js'
import type { MizarStore } from '../auth/store.js'
import type { BindPlan } from '../net/interfaces.js'
import { buildPanelStatus, type PanelStatus } from './status.js'

/**
 * Route paths.
 *
 * These carry the `/api` prefix themselves. The interface doc calls `path` an
 * "absolute path below `/api`", but the shipped registrations pass `/api/file`
 * and friends — the prefix is part of the path, and omitting it produces a
 * silent 404 with no registration error.
 */
export const PANEL_ROUTES = {
  status: '/api/mizar.status',
  pairing: '/api/mizar.pairing',
  revoke: '/api/mizar.revoke',
} as const

/** What the panel needs from the running listener. */
export interface PanelHost {
  /** Every `host:port` the phone can dial. */
  readonly authorities: readonly string[]
  /** How many authenticated clients are connected. */
  readonly clientCount: number
  /**
   * Issue a fresh pairing code.
   * @returns the code and its deadline.
   */
  issuePairingCode(): Promise<{ code: string; display: string; expiresAt: number }>
  /**
   * Revoke one device and drop its live sessions.
   * @param deviceId - the device to revoke.
   * @returns whether a device was revoked.
   */
  revokeDevice(deviceId: string): Promise<boolean>
}

/**
 * The reverse tunnel, read through getters.
 *
 * Getters because both the connection state and the room change while the panel
 * is open, and re-registering the routes on every change would be a worse way to
 * keep them current than reading them when a request arrives.
 */
export interface PanelRelay {
  readonly enabled: boolean
  readonly state: { connected: boolean; room: string | null; lastError: string | null }
  /** The base URL a phone should be paired against, or `null` before a room exists. */
  readonly pairBaseURL: string | null
}

/** Wiring for the panel routes. */
export interface PanelOptions {
  readonly host: PanelHost
  readonly store: MizarStore
  readonly plan: BindPlan
  readonly hostName: string
  readonly protocolVersion: number
  /** The reverse tunnel, or `null` when none is configured. */
  readonly relay: PanelRelay | null
  /** Sink for operator-facing diagnostics. */
  readonly log: (message: string) => void
}

/**
 * Build a JSON response.
 * @param body - the value to serialise.
 * @param status - the HTTP status.
 * @returns the response.
 */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * Register the panel's routes on the shared API channel.
 *
 * @param ctx - the plugin context.
 * @param options - host wiring.
 */
export function registerPanelApi(ctx: Context, options: PanelOptions): void {
  const snapshot = (): PanelStatus => {
    const state = options.store.state
    return buildPanelStatus({
      hostId: state.hostId,
      hostName: options.hostName,
      protocolVersion: options.protocolVersion,
      authorities: options.host.authorities,
      plan: options.plan,
      pairing: state.pairing,
      devices: state.devices,
      clients: options.host.clientCount,
      relay:
        options.relay === null || !options.relay.enabled
          ? null
          : {
              connected: options.relay.state.connected,
              room: options.relay.state.room,
              pairBaseURL: options.relay.pairBaseURL,
              lastError: options.relay.state.lastError,
            },
      now: Date.now(),
      // The code is derived, never stored, so the panel reads it back the same
      // way the host verified it.
      deriveCode: (slot) => deriveCode(options.store.secret, slot.epoch),
    })
  }

  options.log('panel: waiting for the connection service')
  ctx.inject(['connection'], (scoped) => {
    options.log('panel: connection is available, registering routes')
    const disposers: (() => Promise<void>)[] = []

    disposers.push(
      scoped.connection.fetch.register({
        path: PANEL_ROUTES.status,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => json(snapshot()),
      }),
    )

    disposers.push(
      scoped.connection.fetch.register({
        path: PANEL_ROUTES.pairing,
        methods: ['POST'],
        requestBody: 'buffered',
        // Issuing invalidates any outstanding code, so this doubles as "show me
        // a fresh one" — the panel's only pairing action.
        fetch: async () => {
          await options.host.issuePairingCode()
          return json(snapshot())
        },
      }),
    )

    disposers.push(
      scoped.connection.fetch.register({
        path: PANEL_ROUTES.revoke,
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: async (request: Request) => {
          const body = (await request.json().catch(() => null)) as { deviceId?: unknown } | null
          const deviceId = body?.deviceId
          if (typeof deviceId !== 'string' || deviceId === '') {
            return json({ error: 'deviceId must be a non-empty string' }, 400)
          }
          const revoked = await options.host.revokeDevice(deviceId)
          if (!revoked) return json({ error: 'unknown device' }, 404)
          return json(snapshot())
        },
      }),
    )

    options.log(`panel: registered ${disposers.length} routes (${Object.values(PANEL_ROUTES).join(', ')})`)

    return async () => {
      // Unregister in reverse, so a partially-registered panel leaves nothing
      // behind if one disposer throws.
      for (const dispose of disposers.reverse()) {
        await dispose().catch(() => {})
      }
    }
  })
}
