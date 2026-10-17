/**
 * The three wire methods that let a phone be notified.
 *
 * Split from the bridge's method table so the table stays a table: every DSH
 * call lives under `bridge/`, and everything that touches the roster or the
 * relay lives here.
 *
 * Three methods rather than one, and the split is not cosmetic. A device
 * registers its token once per launch, tells the host whether its app is on
 * screen every time the operator switches away, and forgets the token when
 * permission is revoked. Folding the second into the first would put an HTTP
 * request to the relay behind every app switch.
 *
 * @module dsh-mizar/push/binding
 */
import type { MizarStore } from '../auth/store.js'
import type { PushNotifier } from './notifier.js'
import type { PushPlatform, PushRegistration, PushTransport } from './transport.js'

/** What a client may report about its push endpoint. */
export interface PushRegistrationInput {
  readonly token: string
  /** Which service the token belongs to. */
  readonly platform: PushPlatform
  /**
   * Which APNs environment the token was issued for.
   *
   * `null` on Android. The bridge is what enforces that: it reads this field
   * only for iOS, so an Android client neither has to know about it nor can get
   * it wrong.
   */
  readonly environment: 'sandbox' | 'production' | null
  readonly locale: string
  /**
   * The APNs push token of the Live Activity on screen, or `null` when none is.
   *
   * `null` clears the stored token rather than leaving it alone: the app omits
   * the field once its activity is gone, and a token kept past that point is a
   * credential for ending a countdown that no longer exists.
   */
  readonly liveActivityToken: string | null
}

/** What the bridge calls. */
export interface PushBinding {
  /**
   * Record where to reach one device, and tell the relay.
   * @param deviceId - the authenticated device.
   * @param input - its token, platform and environment.
   * @returns whether the device is on the roster.
   */
  register(deviceId: string, input: PushRegistrationInput): Promise<boolean>
  /**
   * Say whether the app is on screen, without touching the relay.
   * @param deviceId - the authenticated device.
   * @param foreground - whether its app is in the foreground.
   */
  presence(deviceId: string, foreground: boolean): void
  /**
   * Forget a device's token, here and at the relay.
   * @param deviceId - the authenticated device.
   * @returns whether the device is on the roster.
   */
  unregister(deviceId: string): Promise<boolean>
  /**
   * Re-announce every stored token to the relay.
   *
   * Called when the tunnel comes back. The relay keeps registrations in memory
   * and loses them when it restarts; the roster is the durable copy, so a
   * reconnect is the moment to hand it over again. Without this a relay restart
   * silently ends push until every phone happens to relaunch.
   */
  republish(): Promise<number>
}

/** What the binding needs. */
export interface PushBindingOptions {
  readonly store: MizarStore
  readonly notifier: PushNotifier
  readonly transport: PushTransport
  readonly log: (message: string) => void
}

/**
 * Build the binding.
 * @param options - the roster, the notifier and the relay.
 * @returns the binding the bridge calls.
 */
export function createPushBinding(options: PushBindingOptions): PushBinding {
  /** Every device's stored endpoint, as the transport last saw it. */
  const registrationOf = (deviceId: string): PushRegistration | null => {
    const device = options.store.state.devices.find((entry) => entry.deviceId === deviceId)
    const push = device?.push
    if (device === undefined || push === undefined) return null
    return {
      deviceId,
      token: push.token,
      platform: push.platform,
      environment: push.environment,
      locale: push.locale,
      ...(push.liveActivityToken === undefined ? {} : { liveActivityToken: push.liveActivityToken }),
    }
  }

  return {
    async register(deviceId, input) {
      const known = await options.store.setDevicePush(deviceId, {
        token: input.token,
        platform: input.platform,
        environment: input.environment,
        locale: input.locale,
        updatedAt: Date.now(),
        // Omitted when there is none, which is how `setDevicePush` is told to
        // clear it: this object is the whole record, not a patch.
        ...(input.liveActivityToken === null ? {} : { liveActivityToken: input.liveActivityToken }),
      })
      if (!known) {
        // A device that is not on the roster cannot have got here: every method
        // is behind authentication. Reaching this means the roster changed under
        // a live connection, which is worth saying out loud.
        options.log(`push: ${deviceId} asked to register but is not on the roster`)
        return false
      }
      const accepted = await options.notifier.register({
        deviceId,
        token: input.token,
        platform: input.platform,
        environment: input.environment,
        locale: input.locale,
        ...(input.liveActivityToken === null ? {} : { liveActivityToken: input.liveActivityToken }),
      })
      // Whether a Live Activity token is held, never the token itself: it is a
      // notification credential, and this log is what support requests quote.
      const activity =
        input.liveActivityToken === null ? 'live-activity token: none' : 'live-activity token: held'
      // Only the first eight characters of the token, which is enough to tell
      // two registrations apart in a log and not enough to be one.
      options.log(
        accepted
          ? `push: ${deviceId} registered (${input.platform}, ${input.environment ?? 'no environment'}, ${input.locale}) — ${input.token.slice(0, 8)}…, ${activity}`
          : `push: the relay did not take ${deviceId}'s token (${input.platform}, ${input.environment ?? 'no environment'}) — this phone will not be woken, ${activity}`,
      )
      // The roster keeps the token either way: the relay may be an older build
      // today and accept it after an upgrade, and `republish` hands it over
      // again on the next reconnect. What must not happen is telling the phone
      // its notifications are working when the relay refused them.
      return accepted
    },

    presence(deviceId, foreground) {
      options.notifier.setForeground(deviceId, foreground)
    },

    async unregister(deviceId) {
      const known = await options.store.setDevicePush(deviceId, null)
      options.notifier.forget(deviceId)
      await options.transport.unregister(deviceId)
      return known
    },

    async republish() {
      let count = 0
      for (const device of options.store.state.devices) {
        if (device.revokedAt !== undefined) continue
        const registration = registrationOf(device.deviceId)
        if (registration === null) continue
        await options.transport.register(registration)
        count += 1
      }
      return count
    },
  }
}
