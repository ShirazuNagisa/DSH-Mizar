/**
 * Where a room's phones can be reached.
 *
 * The relay's half of push, and deliberately the smaller half. It knows which
 * tokens belong to which room and how to hand a notification to Apple; it does
 * **not** know what a session is, what an approval is, or when either deserves a
 * notification. That judgement stays on the Mac, in the plugin, where the
 * evidence is.
 *
 * ### Why the room comes from the credential
 *
 * A registration is authenticated by the same tunnel credential the Mac already
 * presents, and the room is derived from it exactly as the tunnel's is. There is
 * therefore no way to register a token against somebody else's room, and no
 * second enrolment mechanism to get wrong -- which is the whole reason the phone
 * does not talk to this API directly.
 *
 * ### Why the registry is in memory
 *
 * A room's registrations are a cache of what the Mac already knows, and the Mac
 * re-announces all of them every time its tunnel reconnects. Persisting them
 * here would create a second copy of a fact that has an owner, and a relay that
 * restarted would then serve stale tokens forever with nothing to correct it.
 *
 * @module dsh-mizar-relay/push
 */
import type { ApnsClient, ApnsEnvironment, ApnsNotification, ApnsResult } from './apns.js'

/** One device's push endpoint, as its app reported it. */
export interface PushDevice {
  readonly deviceId: string
  readonly token: string
  readonly environment: ApnsEnvironment
  readonly locale: string
  readonly registeredAt: number
}

/** One notification, as the plugin described it. */
export interface PushRequest {
  readonly kind: string
  readonly title: string
  readonly body: string
  readonly sessionId: string | null
  readonly threadId: string
  readonly collapseId: string
  readonly timeSensitive: boolean
  /**
   * Devices the plugin has already decided are looking at the app.
   *
   * Empty means everybody. Skipped rather than refused: the plugin's evidence is
   * that an app reported itself on screen, which says nothing about whether the
   * token is still good, so a device dropped from the registry because of it
   * would have to re-register to be told anything ever again.
   */
  readonly exceptDeviceIds: readonly string[]
}

/** What a notify call did. */
export interface PushOutcome {
  /** How many devices Apple accepted it for. */
  readonly sent: number
  /** How many it refused. */
  readonly failed: number
  /** How many tokens were retired and forgotten. */
  readonly dropped: number
  /** Whether this relay has push configured at all. */
  readonly enabled: boolean
}

/** Longest accepted device token, in characters. */
const MAX_TOKEN_LENGTH = 200

/** Longest accepted device id, in characters. Bounded like a token, and for the same reason. */
const MAX_DEVICE_ID_LENGTH = 200

/** Devices one room may register. Generous for a household, bounded for a script. */
const MAX_DEVICES_PER_ROOM = 16

/**
 * Narrow a registration body.
 *
 * @param value - the decoded JSON body.
 * @returns the device, or `null` when it is unusable.
 */
export function readDevice(value: unknown): Omit<PushDevice, 'registeredAt'> | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const deviceId = record['deviceId']
  const token = record['token']
  if (typeof deviceId !== 'string' || deviceId === '' || deviceId.length > MAX_DEVICE_ID_LENGTH) {
    return null
  }
  if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN_LENGTH) return null
  // Tokens are hex. Checking is not paranoia: a token with a slash in it would
  // be interpolated straight into the APNs request path.
  if (!/^[0-9a-fA-F]+$/.test(token)) return null
  return {
    deviceId,
    token,
    environment: record['environment'] === 'sandbox' ? 'sandbox' : 'production',
    locale: typeof record['locale'] === 'string' ? record['locale'].slice(0, 32) : 'en',
  }
}

/**
 * Narrow a notification body.
 *
 * @param value - the decoded JSON body.
 * @returns the request, or `null` when it is unusable.
 */
export function readNotification(value: unknown): PushRequest | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const title = record['title']
  const body = record['body']
  if (typeof title !== 'string' || title === '') return null
  if (typeof body !== 'string') return null
  const sessionId = record['sessionId']
  return {
    kind: typeof record['kind'] === 'string' ? record['kind'].slice(0, 32) : 'unknown',
    title: title.slice(0, 200),
    body: body.slice(0, 400),
    sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId.slice(0, 200) : null,
    threadId: typeof record['threadId'] === 'string' ? record['threadId'].slice(0, 200) : 'mizar',
    collapseId: typeof record['collapseId'] === 'string' ? record['collapseId'].slice(0, 64) : '',
    timeSensitive: record['timeSensitive'] === true,
    exceptDeviceIds: readExceptDeviceIds(record['exceptDeviceIds']),
  }
}

/**
 * Narrow the list of devices a notification must not go to.
 *
 * Anything that is not an array of strings is treated as absent rather than as
 * an error, because this is a suppression hint: a plugin that mangles it should
 * produce a notification somebody did not need, never a notification nobody
 * gets. Each id is capped at the length a real one can have and the list at the
 * number of devices a room may hold, so a hostile or simply broken body cannot
 * make the relay walk something proportional to its size -- the sixty-kilobyte
 * body cap alone still allows thousands of entries.
 *
 * @param value - the field as it arrived.
 * @returns the ids to skip, deduplicated, or an empty list.
 */
function readExceptDeviceIds(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  const ids = new Set<string>()
  for (const entry of value) {
    if (typeof entry !== 'string' || entry === '') continue
    ids.add(entry.slice(0, MAX_DEVICE_ID_LENGTH))
    if (ids.size >= MAX_DEVICES_PER_ROOM) break
  }
  return [...ids]
}

/** Every room's registered devices. */
export class PushRegistry {
  readonly #rooms = new Map<string, Map<string, PushDevice>>()

  /**
   * Record one device.
   * @param room - the room the credential derives.
   * @param device - the device and its token.
   * @returns whether it was stored, or `false` when the room is full.
   */
  register(room: string, device: Omit<PushDevice, 'registeredAt'>): boolean {
    let devices = this.#rooms.get(room)
    if (devices === undefined) {
      devices = new Map()
      this.#rooms.set(room, devices)
    }
    if (!devices.has(device.deviceId) && devices.size >= MAX_DEVICES_PER_ROOM) return false
    devices.set(device.deviceId, { ...device, registeredAt: Date.now() })
    return true
  }

  /**
   * Forget one device.
   * @param room - the room.
   * @param deviceId - the device.
   * @returns whether it was there.
   */
  unregister(room: string, deviceId: string): boolean {
    const devices = this.#rooms.get(room)
    if (devices === undefined) return false
    const removed = devices.delete(deviceId)
    if (devices.size === 0) this.#rooms.delete(room)
    return removed
  }

  /**
   * Forget every device holding one token.
   *
   * Used when Apple retires a token: leaving it registered means every future
   * notification pays a round trip to be told the same thing again.
   *
   * @param room - the room.
   * @param token - the retired token.
   * @returns how many records were dropped.
   */
  forgetToken(room: string, token: string): number {
    const devices = this.#rooms.get(room)
    if (devices === undefined) return 0
    let dropped = 0
    for (const [deviceId, device] of [...devices]) {
      if (device.token !== token) continue
      devices.delete(deviceId)
      dropped += 1
    }
    if (devices.size === 0) this.#rooms.delete(room)
    return dropped
  }

  /**
   * Every device registered for a room.
   * @param room - the room.
   * @returns the devices.
   */
  devices(room: string): PushDevice[] {
    return [...(this.#rooms.get(room)?.values() ?? [])]
  }

  /** How many rooms have at least one device. */
  get roomCount(): number {
    return this.#rooms.size
  }

  /** Total registered devices, for the health endpoint. */
  get deviceCount(): number {
    let total = 0
    for (const devices of this.#rooms.values()) total += devices.size
    return total
  }
}

/**
 * Deliver one notification to every device in a room.
 *
 * The room's devices are sent to together rather than in sequence. Sequencing
 * looked free -- one `ClientHttp2Session` multiplexes the requests anyway -- but
 * a device Apple cannot reach costs a full request timeout, and a session Apple
 * closed without telling anybody, a wiped phone or a stalled network all produce
 * exactly that: the first such device pushed the plugin's own ten-second client
 * timeout past its limit while the rest were still being sent, so the Mac logged
 * a failed notification for one that had in fact gone out. Sending together
 * bounds the wall clock at one request. The fan-out is bounded by
 * {@link MAX_DEVICES_PER_ROOM}, which is what makes `Promise.all` safe here, and
 * the per-device accounting is unchanged: each send reports its own outcome and
 * the tallies are summed.
 *
 * @param options - the registry, the client and the log.
 * @param room - the room to notify.
 * @param request - what to say.
 * @returns what happened.
 */
export async function deliver(
  options: {
    readonly registry: PushRegistry
    readonly client: ApnsClient | null
    readonly log: (message: string) => void
  },
  room: string,
  request: PushRequest,
): Promise<PushOutcome> {
  const devices = options.registry.devices(room)
  if (options.client === null) {
    options.log(
      `push: nothing to send with — ${devices.length} device(s) registered for room ${room} and no APNs key configured`,
    )
    return { sent: 0, failed: 0, dropped: 0, enabled: false }
  }
  if (devices.length === 0) return { sent: 0, failed: 0, dropped: 0, enabled: true }

  const excluded = new Set(request.exceptDeviceIds)
  const client = options.client
  // Each task adds its own result the moment its send settles, and nothing
  // awaits between reading a counter and writing it -- so the tallies need no
  // more coordination than that, and they are the same three numbers the
  // sequential loop kept.
  const tally = { sent: 0, failed: 0, dropped: 0 }
  await Promise.all(
    devices
      .filter((device) => !excluded.has(device.deviceId))
      .map(async (device): Promise<void> => {
        const notification: ApnsNotification = {
          deviceToken: device.token,
          // Each device's own environment, because one room holds phones that
          // disagree about which Apple minted their token.
          environment: device.environment,
          title: request.title,
          body: request.body,
          threadId: request.threadId,
          collapseId: request.collapseId,
          // An approval or a question is blocking a turn, and the operator waking
          // up to it late is the same as not being told.
          urgent: request.kind === 'approval' || request.kind === 'question' || request.timeSensitive,
          sessionId: request.sessionId,
          kind: request.kind,
        }
        const result: ApnsResult = await client.send(notification)
        if (result.delivered) {
          tally.sent += 1
          return
        }
        if (result.unregistered) {
          tally.dropped += options.registry.forgetToken(room, device.token)
          options.log(
            `push: retired token for ${device.deviceId} in room ${room} (${result.status} ${result.reason ?? ''})`.trim(),
          )
          return
        }
        tally.failed += 1
        options.log(
          `push: ${device.deviceId} in room ${room} refused (${result.status} ${result.reason ?? 'no reason'})`,
        )
      }),
  )

  return { ...tally, enabled: true }
}
