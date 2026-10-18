/**
 * The notification policy and the way it leaves this machine.
 *
 * Three things are being pinned down, and each is a decision rather than a
 * mechanism:
 *
 *   - **What is worth waking somebody for.** A notification that arrives for
 *     everything is one nobody reads, so the debounce on a finished turn and
 *     the refusal to announce a session that has merely *paused between turns*
 *     are the feature, not the plumbing.
 *   - **That a foreground app suppresses only the device that is looking.**
 *     Pushing about a screen the operator is already looking at is noise with a
 *     system banner around it, but the iPhone in a pocket is not the iPad left
 *     open on a desk.
 *   - **That nothing here can fail the thing it is announcing.** An approval
 *     must not be able to fail because a relay is down.
 *
 * @module dsh-mizar/test/push
 */
import { createServer, type Server } from 'node:http'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPushBinding } from '../src/push/binding.js'
import { languageOf, PushNotifier, turnWording } from '../src/push/notifier.js'
import { anyNotifiableSessionRunning, isNotifiable } from '../src/push/scope.js'
import {
  NoopTransport,
  RelayTransport,
  type PushMessage,
  type PushRegistration,
  type PushTransport,
} from '../src/push/transport.js'
import { MizarStore } from '../src/auth/store.js'

/** A transport that remembers what it was asked to do. */
class RecordingTransport implements PushTransport {
  readonly registrations: PushRegistration[] = []
  readonly removed: string[] = []
  readonly messages: PushMessage[] = []
  /** Answers `send` with this. */
  sent = 1
  /** Thrown by every method, when set. */
  failure: Error | null = null

  /** What the transport answers: a relay that refuses says so. */
  accepts = true

  async register(registration: PushRegistration): Promise<boolean> {
    if (this.failure !== null) throw this.failure
    this.registrations.push(registration)
    return this.accepts
  }

  async unregister(deviceId: string): Promise<void> {
    if (this.failure !== null) throw this.failure
    this.removed.push(deviceId)
  }

  async send(message: PushMessage): Promise<number> {
    if (this.failure !== null) throw this.failure
    this.messages.push(message)
    return this.sent
  }
}

/** A notifier over a recording transport. */
function notifier(options: {
  transport: PushTransport
  locale?: string
  title?: string | null
  settleMs?: number
  describeFails?: boolean
  anySessionRunning?: () => Promise<boolean>
  log?: (message: string) => void
}): PushNotifier {
  return new PushNotifier({
    transport: options.transport,
    describeSession: async (sessionId) => {
      if (options.describeFails === true) throw new Error('the host did not answer')
      return options.title === undefined ? 'Mock session' : options.title
    },
    locale: () => options.locale ?? 'en',
    log: options.log ?? (() => {}),
    ...(options.settleMs === undefined ? {} : { settleMs: options.settleMs }),
    ...(options.anySessionRunning === undefined
      ? {}
      : { anySessionRunning: options.anySessionRunning }),
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('the language of a notification', () => {
  it('writes Simplified Chinese only where it is unambiguous', () => {
    expect(languageOf('zh-Hans')).toBe('zh-Hans')
    expect(languageOf('zh-CN')).toBe('zh-Hans')
    expect(languageOf('zh')).toBe('zh-Hans')
    // Traditional Chinese readers read English far more often than Simplified,
    // so a Traditional locale gets English rather than the wrong Chinese.
    expect(languageOf('zh-Hant')).toBe('en')
    expect(languageOf('zh-TW')).toBe('en')
    expect(languageOf('zh-HK')).toBe('en')
    expect(languageOf('zh-MO')).toBe('en')
    expect(languageOf('en-US')).toBe('en')
    expect(languageOf('')).toBe('en')
  })
})

describe('what a finished turn is called', () => {
  it('does not call a failure a completion', () => {
    // The distinction the whole notification exists for: telling an operator
    // their agent finished when it stopped on an error is worse than silence.
    expect(turnWording('completed', 'demo', 'en').title).toBe('Task complete')
    expect(turnWording('error', 'demo', 'en').title).toBe('Task failed')
    // Cancelled, blocked, out of context, crash-orphaned: all stopped.
    for (const kind of ['aborted', 'blocked', 'max-tokens', 'interrupted', 'forked']) {
      expect(turnWording(kind, 'demo', 'en').title).toBe('Task stopped')
    }
    // A settle timer that fired without a reason still says something true.
    expect(turnWording(null, 'demo', 'en').title).toBe('Task finished')
  })

  it('says the same things in Chinese', () => {
    expect(turnWording('completed', 'demo', 'zh-Hans').title).toBe('任务完成')
    expect(turnWording('error', 'demo', 'zh-Hans').title).toBe('任务出错')
    expect(turnWording('aborted', 'demo', 'zh-Hans').title).toBe('任务已停止')
    expect(turnWording('completed', 'demo', 'zh-Hans').body).toBe('demo')
  })
})

describe('announcing an interaction', () => {
  it('names the tool and the session, and asks to break through Focus', async () => {
    const transport = new RecordingTransport()
    await notifier({ transport, title: 'Refactor the parser' }).approvalNeeded({
      sessionId: 's1',
      toolName: 'write_file',
      reason: 'Writing outside the workspace',
    })

    expect(transport.messages).toHaveLength(1)
    expect(transport.messages[0]).toMatchObject({
      kind: 'approval',
      title: 'Permission needed',
      body: 'Writing outside the workspace · Refactor the parser',
      sessionId: 's1',
      timeSensitive: true,
    })
  })

  it('falls back to the tool name when the host gave no reason', async () => {
    const transport = new RecordingTransport()
    await notifier({ transport }).approvalNeeded({ sessionId: 's1', toolName: 'bash' })
    expect(transport.messages[0]?.body).toBe('bash · Mock session')
  })

  it('carries the question being asked', async () => {
    const transport = new RecordingTransport()
    await notifier({ transport }).questionAsked({
      sessionId: 's1',
      callId: 'call-1',
      questions: [
        { id: 'q1', question: 'Which database?', options: [], multiSelect: false, intent: null },
      ],
    })
    expect(transport.messages[0]).toMatchObject({
      kind: 'question',
      body: 'Which database? · Mock session',
      collapseId: 'question-call-1',
      timeSensitive: true,
    })
  })

  it('writes in the phone\'s language', async () => {
    const transport = new RecordingTransport()
    await notifier({ transport, locale: 'zh-Hans' }).approvalNeeded({
      sessionId: 's1',
      toolName: 'bash',
    })
    expect(transport.messages[0]?.title).toBe('需要你的许可')
  })

  it('names a session by its id when the host will not say', async () => {
    const transport = new RecordingTransport()
    await notifier({ transport, describeFails: true }).approvalNeeded({
      sessionId: 'session-9',
      toolName: 'bash',
    })
    expect(transport.messages[0]?.body).toBe('bash · session-9')
  })

  it('names a sessionless request in the language the rest of it is written in', async () => {
    // `languageOf` sends Traditional Chinese to English, so a zh-Hant phone gets
    // an English title -- but the placeholder for "no session" asked a different
    // question (`startsWith('zh')`) and answered in Chinese, giving one
    // notification in two languages.
    const transport = new RecordingTransport()
    await notifier({ transport, locale: 'zh-Hant' }).approvalNeeded({
      sessionId: null,
      toolName: 'bash',
    })
    expect(transport.messages[0]?.title).toBe('Permission needed')
    expect(transport.messages[0]?.body).toBe('bash · a session')
  })

  it('skips the device that is looking, and still sends to the others', async () => {
    const transport = new RecordingTransport()
    const push = notifier({ transport })
    push.setForeground('phone-1', true)
    await push.approvalNeeded({ sessionId: 's1', toolName: 'bash' })

    // What the relay does with the list, written out here because "sent with an
    // exclusion" only means anything if something acts on it: every device
    // except the one whose app reported itself on screen.
    const reached = (message: PushMessage | undefined): string[] =>
      ['phone-1', 'phone-2'].filter(
        (deviceId) => !(message?.exceptDeviceIds ?? []).includes(deviceId),
      )

    // The message still goes out. A single global flag used to mean an iPad left
    // open on a session silenced the pocketed iPhone as well.
    expect(transport.messages).toHaveLength(1)
    expect(reached(transport.messages[0])).toEqual(['phone-2'])

    // And it follows the app rather than the moment: the second device is the
    // one looking now, so the first is the one that gets it.
    push.setForeground('phone-2', true)
    push.setForeground('phone-1', false)
    await push.approvalNeeded({ sessionId: 's1', toolName: 'bash' })
    expect(reached(transport.messages[1])).toEqual(['phone-1'])
  })

  it('stops excluding a device once it is forgotten', async () => {
    const transport = new RecordingTransport()
    const push = notifier({ transport })
    push.setForeground('phone-1', true)
    // What a revocation does: a device that was on screen when it was revoked
    // never reports a `false` again, so forgetting it is the only thing that
    // stops it being named in every later exclusion list.
    push.forget('phone-1')
    await push.approvalNeeded({ sessionId: 's1', toolName: 'bash' })
    expect(transport.messages[0]?.exceptDeviceIds).toEqual([])
  })

  it('never throws when the transport is broken', async () => {
    const transport = new RecordingTransport()
    transport.failure = new Error('the relay is down')
    // Not a nicety: this runs inside the approval waterfall, where a throw is
    // an approval that fails because a notification could not be sent.
    await expect(
      notifier({ transport }).approvalNeeded({ sessionId: 's1', toolName: 'bash' }),
    ).resolves.toBeUndefined()
  })
})

describe('announcing that a session stopped', () => {
  it('waits for quiet, then says so', async () => {
    vi.useFakeTimers()
    const transport = new RecordingTransport()
    const push = notifier({ transport, settleMs: 1000, title: 'demo' })

    push.turnEnded('s1', 'completed')
    expect(push.settlingCount).toBe(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(transport.messages).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    expect(transport.messages).toHaveLength(1)
    expect(transport.messages[0]).toMatchObject({
      kind: 'turn-complete',
      title: 'Task complete',
      body: 'demo',
      threadId: 's1',
    })
    expect(push.settlingCount).toBe(0)
  })

  it('stays quiet when the agent carries straight on', async () => {
    // Measured on a real session: long runs of consecutive `turn/start` with no
    // `user/message` between them. Announcing each one would be three
    // notifications for one instruction, which teaches the operator to ignore
    // all of them.
    vi.useFakeTimers()
    const transport = new RecordingTransport()
    const push = notifier({ transport, settleMs: 1000 })

    push.turnEnded('s1', 'completed')
    await vi.advanceTimersByTimeAsync(500)
    push.noteActivity('s1', 'turn/start')
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.messages).toHaveLength(0)
    expect(push.settlingCount).toBe(0)
  })

  it('cancels for work, and not for the bookkeeping around it', async () => {
    vi.useFakeTimers()
    const transport = new RecordingTransport()
    const push = notifier({ transport, settleMs: 1000 })

    // A title written by the title model, a rename from the desktop GUI, a todo
    // snapshot: each of them lands in the log inside the quiet window and none
    // of them means the agent is working again. Treating them as activity
    // swallowed the announcement the operator was waiting for, so the record
    // that arrives has to be one of the ones that mean work.
    push.turnEnded('s1', 'completed')
    push.noteActivity('s1', 'session/title')
    push.noteActivity('s1', 'todo/write')
    expect(push.settlingCount).toBe(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.messages).toHaveLength(1)

    // The other direction, so the allowlist cannot be satisfied by cancelling
    // nothing at all: a turn starting again is the silence not being the end.
    transport.messages.length = 0
    push.turnEnded('s1', 'completed')
    push.noteActivity('s1', 'turn/start')
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.messages).toHaveLength(0)
    expect(push.settlingCount).toBe(0)
  })

  it('announces once when the agent stops for good', async () => {
    vi.useFakeTimers()
    const transport = new RecordingTransport()
    const push = notifier({ transport, settleMs: 1000 })

    push.turnEnded('s1', 'completed')
    await vi.advanceTimersByTimeAsync(400)
    push.noteActivity('s1', 'assistant/message')
    push.turnEnded('s1', 'completed')
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.messages).toHaveLength(1)
  })

  it('keeps one session\'s silence out of another\'s', async () => {
    vi.useFakeTimers()
    const transport = new RecordingTransport()
    const push = notifier({ transport, settleMs: 1000 })

    push.turnEnded('s1', 'completed')
    push.turnEnded('s2', 'completed')
    push.noteActivity('s1', 'step/start')
    await vi.advanceTimersByTimeAsync(1000)
    expect(transport.messages.map((message) => message.sessionId)).toEqual(['s2'])
  })

  it('says the turn failed when it did', async () => {
    vi.useFakeTimers()
    const transport = new RecordingTransport()
    const push = notifier({ transport, settleMs: 10, title: 'demo' })
    push.turnEnded('s1', 'error')
    await vi.advanceTimersByTimeAsync(10)
    expect(transport.messages[0]?.title).toBe('Task failed')
  })

  it('collapses repeat announcements about one session', async () => {
    vi.useFakeTimers()
    const transport = new RecordingTransport()
    const push = notifier({ transport, settleMs: 10 })
    push.turnEnded('s1', 'completed')
    await vi.advanceTimersByTimeAsync(10)
    push.turnEnded('s1', 'completed')
    await vi.advanceTimersByTimeAsync(10)
    expect(transport.messages).toHaveLength(2)
    // Same id, so the phone replaces one with the other rather than stacking
    // two "task complete" cards for one session.
    expect(transport.messages[0]?.collapseId).toBe(transport.messages[1]?.collapseId)
  })

  it('drops everything pending when the plugin unloads', async () => {
    vi.useFakeTimers()
    const transport = new RecordingTransport()
    const push = notifier({ transport, settleMs: 1000 })
    push.turnEnded('s1', 'completed')
    push.dispose()
    await vi.advanceTimersByTimeAsync(5000)
    expect(transport.messages).toHaveLength(0)
    expect(push.settlingCount).toBe(0)
  })
})

describe('ending the Live Activity', () => {
  it('asks the relay to end it when the finished session was the last one working', async () => {
    vi.useFakeTimers()
    const transport = new RecordingTransport()
    const push = notifier({ transport, settleMs: 10, anySessionRunning: async () => false })

    push.turnEnded('s1', 'completed')
    await vi.advanceTimersByTimeAsync(10)

    // The whole point: the countdown on the lock screen has to stop when the
    // work does, and the app that would normally end it is suspended.
    expect(transport.messages[0]).toMatchObject({ kind: 'turn-complete', endLiveActivity: true })
  })

  it('leaves it up while another session is still working', async () => {
    vi.useFakeTimers()
    const transport = new RecordingTransport()
    const push = notifier({ transport, settleMs: 10, anySessionRunning: async () => true })

    push.turnEnded('s1', 'completed')
    await vi.advanceTimersByTimeAsync(10)

    // The phone is showing an island for the work that is still going. Ending
    // it because one session finished would take away the countdown the
    // operator is actually watching.
    expect(transport.messages[0]?.endLiveActivity).toBeUndefined()
    expect('endLiveActivity' in (transport.messages[0] ?? {})).toBe(false)
  })

  it('never ends it on an approval or a question', async () => {
    const transport = new RecordingTransport()
    let asked = 0
    const push = notifier({
      transport,
      anySessionRunning: async () => {
        asked += 1
        return false
      },
    })

    // Both mean an agent is blocked rather than finished, so ending a running
    // countdown here would be a lie about what the phone is showing.
    await push.approvalNeeded({ sessionId: 's1', toolName: 'bash' })
    await push.questionAsked({
      sessionId: 's1',
      callId: 'call-1',
      questions: [{ id: 'q1', question: 'Which one?', options: [], multiSelect: false, intent: null }],
    })

    expect(transport.messages).toHaveLength(2)
    expect(transport.messages[0]?.endLiveActivity).toBeUndefined()
    expect(transport.messages[1]?.endLiveActivity).toBeUndefined()
    // And the check is not even asked: an interaction is not a settle, so
    // there is nothing to decide.
    expect(asked).toBe(0)
  })

  it('does not end it when nothing can say whether a session is running', async () => {
    vi.useFakeTimers()
    const transport = new RecordingTransport()
    // The callback is optional: a host with no session service still notifies.
    const push = notifier({ transport, settleMs: 10 })

    push.turnEnded('s1', 'completed')
    await vi.advanceTimersByTimeAsync(10)

    expect(transport.messages).toHaveLength(1)
    expect(transport.messages[0]?.endLiveActivity).toBeUndefined()
  })

  it('does not end it, and says so once, when the check itself fails', async () => {
    vi.useFakeTimers()
    const transport = new RecordingTransport()
    const lines: string[] = []
    let checks = 0
    const push = notifier({
      transport,
      settleMs: 10,
      log: (line) => lines.push(line),
      anySessionRunning: async () => {
        checks += 1
        throw new Error('the gateway did not answer')
      },
    })

    // A failed read of the session list is not evidence that everything has
    // stopped. Leaving the island up is the safe direction: a stale countdown
    // is wrong, but one that vanishes mid-work is wrong *and* loses the screen
    // the operator was using to see it.
    push.turnEnded('s1', 'completed')
    await vi.advanceTimersByTimeAsync(10)
    push.turnEnded('s1', 'completed')
    await vi.advanceTimersByTimeAsync(10)

    expect(checks).toBe(2)
    expect(transport.messages).toHaveLength(2)
    expect(transport.messages[0]?.endLiveActivity).toBeUndefined()
    expect(transport.messages[1]?.endLiveActivity).toBeUndefined()
    // Once, not once per announcement: a gateway that is down would otherwise
    // write a line for every session that finishes.
    expect(lines.filter((line) => line.includes('live activity'))).toHaveLength(1)
  })
})

describe('the roster', () => {
  let dir = ''
  afterEach(async () => {
    if (dir !== '') await rm(dir, { recursive: true, force: true })
    dir = ''
  })

  /** A store with one paired device. */
  async function storeWithDevice(deviceId = 'phone-1'): Promise<MizarStore> {
    dir = await mkdtemp(join(tmpdir(), 'mizar-push-'))
    const store = await MizarStore.open(dir)
    await store.mutate((state) => ({
      ...state,
      devices: [
        {
          deviceId,
          name: 'iPhone',
          tokenHash: 'hash',
          tokenPrefix: 'mz_ab',
          createdAt: 1,
          lastSeenAt: 1,
        },
      ],
    }))
    for (const device of store.state.devices.slice(1)) void device
    return store
  }

  it('records a token on the device and hands it to the transport', async () => {
    const store = await storeWithDevice()
    const transport = new RecordingTransport()
    const binding = createPushBinding({
      store,
      notifier: notifier({ transport }),
      transport,
      log: () => {},
    })

    expect(
      await binding.register('phone-1', {
        token: 'deadbeef',
        platform: 'ios',
        environment: 'sandbox',
        locale: 'zh-Hans',
        liveActivityToken: null,
      }),
    ).toBe(true)
    expect(transport.registrations).toHaveLength(1)
    expect(transport.registrations[0]).toMatchObject({
      deviceId: 'phone-1',
      token: 'deadbeef',
      platform: 'ios',
      environment: 'sandbox',
    })
    // Stored, so the relay can be told again after it restarts.
    expect(store.state.devices[0]?.push?.token).toBe('deadbeef')
    expect(store.state.devices[0]?.push?.environment).toBe('sandbox')
    expect(store.state.devices[0]?.push?.platform).toBe('ios')
    // And when the relay refuses the token -- an older relay answers 404 for
    // this path -- the phone is told so. Answering "registered" regardless is
    // how the operator ends up debugging a phone that was never going to be
    // woken.
    transport.accepts = false
    await expect(
      binding.register('phone-1', {
        token: 'aa'.repeat(32),
        platform: 'ios',
        environment: 'sandbox',
        locale: 'zh-Hans',
        liveActivityToken: null,
      }),
    ).resolves.toBe(false)
  })


  it('carries an Android registration through, environment and all', async () => {
    const store = await storeWithDevice('android-phone')
    const transport = new RecordingTransport()
    const lines: string[] = []
    const binding = createPushBinding({
      store,
      notifier: notifier({ transport }),
      transport,
      log: (line) => lines.push(line),
    })

    // An FCM registration token, which is not hex, and `null` for the
    // environment it does not have. Both facts have to survive the trip to the
    // relay: the token shape is what decides the route, and an environment
    // invented here would be a lie the status endpoint repeats.
    const token = 'dGhpc2lzOm5vdC1oZXg_APA91b'
    expect(
      await binding.register('android-phone', {
        token,
        platform: 'android',
        environment: null,
        locale: 'zh-Hans',
        liveActivityToken: null,
      }),
    ).toBe(true)
    expect(transport.registrations[0]).toEqual({
      deviceId: 'android-phone',
      token,
      platform: 'android',
      environment: null,
      locale: 'zh-Hans',
    })
    expect(store.state.devices[0]?.push).toMatchObject({
      token,
      platform: 'android',
      environment: null,
    })
    expect(lines.join('\n')).toContain('android')

    // And a reconnect re-announces all of it, which is the path a relay restart
    // depends on.
    transport.registrations.length = 0
    expect(await binding.republish()).toBe(1)
    expect(transport.registrations[0]).toMatchObject({
      platform: 'android',
      environment: null,
    })
  })

  it('loads a state file written before platform existed', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mizar-push-'))
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        hostSecret: 'A'.repeat(43),
        hostId: '00000000-0000-0000-0000-000000000000',
        createdAt: 1,
        pairing: null,
        devices: [
          {
            deviceId: 'phone-1',
            name: 'iPhone',
            tokenHash: 'hash',
            tokenPrefix: 'mz_ab',
            createdAt: 1,
            lastSeenAt: 1,
            push: { token: 'deadbeef', environment: 'sandbox', locale: 'en', updatedAt: 2 },
          },
        ],
      }),
      'utf8',
    )
    const store = await MizarStore.open(dir)

    // Defaulted, not dropped. An existing record can only be an iOS one, and
    // dropping the endpoint would silently stop notifying a phone that is still
    // paired -- which the operator would only discover from a notification that
    // never arrived.
    expect(store.state.devices[0]?.push).toMatchObject({
      platform: 'ios',
      environment: 'sandbox',
    })
    // A record from before Live Activities existed holds no activity token,
    // which is exactly the state of a phone whose app cannot show one.
    expect(store.state.devices[0]?.push?.liveActivityToken).toBeUndefined()

    // And it re-announces with the platform filled in, which is the path a
    // plugin upgrade takes: the relay is told again on the next reconnect.
    const transport = new RecordingTransport()
    const binding = createPushBinding({
      store,
      notifier: notifier({ transport }),
      transport,
      log: () => {},
    })
    expect(await binding.republish()).toBe(1)
    expect(transport.registrations[0]).toMatchObject({
      deviceId: 'phone-1',
      platform: 'ios',
      environment: 'sandbox',
    })
    expect(transport.registrations[0]).not.toHaveProperty('liveActivityToken')
  })

  it('stores a Live Activity token, clears it when none is up, and never logs it', async () => {
    const store = await storeWithDevice()
    const transport = new RecordingTransport()
    const lines: string[] = []
    const binding = createPushBinding({
      store,
      notifier: notifier({ transport }),
      transport,
      log: (line) => lines.push(line),
    })

    // The token outlives the process: the relay is told again on reconnect, and
    // a token only held in memory would be lost at the exact moment a restart
    // is what paused the app.
    await binding.register('phone-1', {
      token: 'deadbeef',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
      liveActivityToken: 'ab12cd34ef',
    })
    expect(store.state.devices[0]?.push?.liveActivityToken).toBe('ab12cd34ef')
    expect(transport.registrations[0]?.liveActivityToken).toBe('ab12cd34ef')

    // The log says whether one is held. It must not say which one: a Live
    // Activity push token is a notification credential, and this log is read
    // into support requests.
    expect(lines.join('\n')).toContain('live-activity token: held')
    expect(lines.join('\n')).not.toContain('ab12cd34ef')

    // A later registration with no token says the Live Activity is down now:
    // the stored one is cleared, so a reconnect cannot re-announce a token whose
    // countdown is already gone.
    transport.registrations.length = 0
    await binding.register('phone-1', {
      token: 'deadbeef',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
      liveActivityToken: null,
    })
    expect(store.state.devices[0]?.push?.liveActivityToken).toBeUndefined()
    expect(transport.registrations[0]).not.toHaveProperty('liveActivityToken')
    expect(lines[lines.length - 1]).toContain('live-activity token: none')
    expect(lines[lines.length - 1]).not.toContain('live-activity token: held')

    // And a reconnect re-announces what is actually stored -- which is nothing,
    // after the clear.
    transport.registrations.length = 0
    expect(await binding.republish()).toBe(1)
    expect(transport.registrations[0]).not.toHaveProperty('liveActivityToken')
  })

  it('keeps a Live Activity token across a relaunch, and drops only that field when corrupt', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mizar-push-'))
    const store = await MizarStore.open(dir)
    await store.mutate((state) => ({
      ...state,
      devices: [
        {
          deviceId: 'phone-1',
          name: 'iPhone',
          tokenHash: 'hash',
          tokenPrefix: 'mz_ab',
          createdAt: 1,
          lastSeenAt: 1,
        },
      ],
    }))
    await store.setDevicePush('phone-1', {
      token: 'deadbeef',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
      updatedAt: 2,
      liveActivityToken: 'ab12cd34ef',
    })

    // Reopened from disk: the token survives, which is the whole reason it is
    // stored on the device record rather than kept with the live registration.
    const reopened = await MizarStore.open(dir)
    expect(reopened.state.devices[0]?.push?.liveActivityToken).toBe('ab12cd34ef')

    // A corrupt token in the file costs the activity token and nothing else.
    // Dropping the whole push record would cost notifications; failing the load
    // would cost the pairing. The app re-registers on its next launch anyway.
    dir = await mkdtemp(join(tmpdir(), 'mizar-push-'))
    await writeFile(
      join(dir, 'state.json'),
      JSON.stringify({
        version: 1,
        hostSecret: 'A'.repeat(43),
        hostId: '00000000-0000-0000-0000-000000000000',
        createdAt: 1,
        pairing: null,
        devices: [
          {
            deviceId: 'phone-1',
            name: 'iPhone',
            tokenHash: 'hash',
            tokenPrefix: 'mz_ab',
            createdAt: 1,
            lastSeenAt: 1,
            push: {
              token: 'deadbeef',
              platform: 'ios',
              environment: 'sandbox',
              locale: 'en',
              updatedAt: 2,
              liveActivityToken: 'NOT-HEX',
            },
          },
        ],
      }),
      'utf8',
    )
    const recovered = await MizarStore.open(dir)
    expect(recovered.state.devices[0]?.push).toMatchObject({
      token: 'deadbeef',
      platform: 'ios',
      environment: 'sandbox',
    })
    expect(recovered.state.devices[0]?.push?.liveActivityToken).toBeUndefined()
  })

  it('refuses a device that is not on the roster', async () => {
    const store = await storeWithDevice()
    const transport = new RecordingTransport()
    const lines: string[] = []
    const binding = createPushBinding({
      store,
      notifier: notifier({ transport }),
      transport,
      log: (line) => lines.push(line),
    })

    expect(
      await binding.register('somebody-else', {
        token: 'deadbeef',
        platform: 'ios',
        environment: 'production',
        locale: 'en',
        liveActivityToken: null,
      }),
    ).toBe(false)
    expect(transport.registrations).toHaveLength(0)
    expect(lines.join('\n')).toContain('not on the roster')
  })

  it('re-announces every stored token, and only the live ones', async () => {
    const store = await storeWithDevice()
    const transport = new RecordingTransport()
    const binding = createPushBinding({
      store,
      notifier: notifier({ transport }),
      transport,
      log: () => {},
    })
    await binding.register('phone-1', {
      token: 'deadbeef',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
      liveActivityToken: null,
    })
    transport.registrations.length = 0

    // A second device that never registered, and a revoked one that did: the
    // first has no token to send and the second must not be woken.
    await store.mutate((state) => ({
      ...state,
      devices: [
        ...state.devices,
        {
          deviceId: 'phone-2',
          name: 'iPad',
          tokenHash: 'hash2',
          tokenPrefix: 'mz_cd',
          createdAt: 2,
          lastSeenAt: 2,
        },
        {
          deviceId: 'phone-3',
          name: 'old',
          tokenHash: 'hash3',
          tokenPrefix: 'mz_ef',
          createdAt: 3,
          lastSeenAt: 3,
          revokedAt: 4,
          push: { token: 'cafe', platform: 'ios', environment: 'production', locale: 'en', updatedAt: 4 },
        },
      ],
    }))

    expect(await binding.republish()).toBe(1)
    expect(transport.registrations.map((entry) => entry.deviceId)).toEqual(['phone-1'])
  })

  it('forgets a token here and at the relay', async () => {
    const store = await storeWithDevice()
    const transport = new RecordingTransport()
    const push = notifier({ transport })
    const binding = createPushBinding({ store, notifier: push, transport, log: () => {} })
    await binding.register('phone-1', {
      token: 'deadbeef',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
      liveActivityToken: null,
    })

    // A device that was on screen when it unregistered must not keep
    // suppressing notifications for everybody else.
    push.setForeground('phone-1', true)
    expect(push.isForeground()).toBe(true)

    expect(await binding.unregister('phone-1')).toBe(true)
    expect(store.state.devices[0]?.push).toBeUndefined()
    expect(transport.removed).toEqual(['phone-1'])
    expect(push.isForeground()).toBe(false)
  })

  it('tracks presence without touching the relay', async () => {
    const store = await storeWithDevice()
    const transport = new RecordingTransport()
    const push = notifier({ transport })
    const binding = createPushBinding({ store, notifier: push, transport, log: () => {} })
    await binding.register('phone-1', {
      token: 'deadbeef',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
      liveActivityToken: null,
    })
    transport.registrations.length = 0

    binding.presence('phone-1', true)
    expect(push.isForeground()).toBe(true)
    binding.presence('phone-1', false)
    expect(push.isForeground()).toBe(false)
    // Registration is what tells the relay where the device is; presence is a
    // fact only this process needs, and it happens on every app switch.
    expect(transport.registrations).toHaveLength(0)
  })
})

describe('the relay transport', () => {
  let server: Server | undefined
  let received: Array<{ path: string; authorization: string; body: unknown }> = []
  let status = 200
  let reply: unknown = { sent: 2 }

  afterEach(async () => {
    if (server === undefined) return
    const closing = server
    server = undefined
    await new Promise<void>((resolve) => closing.close(() => resolve()))
  })

  /** Start a fake relay and return its base URL. */
  async function startRelay(): Promise<string> {
    received = []
    status = 200
    reply = { sent: 2 }
    const created = createServer((request, response) => {
      let raw = ''
      request.on('data', (chunk) => {
        raw += String(chunk)
      })
      request.on('end', () => {
        received.push({
          path: request.url ?? '',
          authorization: String(request.headers['authorization'] ?? ''),
          body: raw === '' ? null : JSON.parse(raw),
        })
        response.writeHead(status, { 'content-type': 'application/json' })
        response.end(JSON.stringify(reply))
      })
    })
    const port = await new Promise<number>((resolve) => {
      created.listen(0, '127.0.0.1', () => {
        const address = created.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
    server = created
    return `http://127.0.0.1:${port}`
  }

  it('posts to the three endpoints with the tunnel credential', async () => {
    const base = await startRelay()
    const transport = new RelayTransport({ baseURL: base, token: 'mac-secret', log: () => {} })

    await transport.register({
      deviceId: 'phone-1',
      token: 'deadbeef',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'zh-Hans',
    })
    expect(await transport.send({
      kind: 'approval',
      title: 't',
      body: 'b',
      sessionId: 's1',
      threadId: 's1',
      collapseId: 'c',
      timeSensitive: true,
      exceptDeviceIds: [],
    })).toBe(2)
    await transport.unregister('phone-1')

    expect(received.map((entry) => entry.path)).toEqual([
      '/push/v1/register',
      '/push/v1/notify',
      '/push/v1/unregister',
    ])
    // The same secret the tunnel presents, which is how the relay knows which
    // room is being spoken for.
    expect(received.every((entry) => entry.authorization === 'Bearer mac-secret')).toBe(true)
    expect(received[0]?.body).toMatchObject({
      deviceId: 'phone-1',
      platform: 'ios',
      environment: 'sandbox',
    })
    // A registration from an app with no Live Activity sends no activity token,
    // and the body must not grow one: an old relay reads exactly what it always
    // did.
    expect(received[0]?.body).not.toHaveProperty('liveActivityToken')
  })

  it('carries the Live Activity token and the end flag in the JSON bodies', async () => {
    const base = await startRelay()
    const transport = new RelayTransport({ baseURL: base, token: 'mac-secret', log: () => {} })

    await transport.register({
      deviceId: 'phone-1',
      token: 'deadbeef',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
      liveActivityToken: 'ab12cd34ef',
    })
    await transport.send({
      kind: 'turn-complete',
      title: 't',
      body: 'b',
      sessionId: 's1',
      threadId: 's1',
      collapseId: 'c',
      timeSensitive: false,
      exceptDeviceIds: [],
      endLiveActivity: true,
    })

    // Both fields are additive JSON: a relay that does not know them ignores
    // them, which is what makes this deployable before the relay is updated.
    expect(received[0]?.body).toMatchObject({
      deviceId: 'phone-1',
      liveActivityToken: 'ab12cd34ef',
    })
    expect(received[1]?.body).toMatchObject({
      kind: 'turn-complete',
      endLiveActivity: true,
    })

    // And neither is sent when there is nothing to say, rather than sent as
    // false or null: "no token" and "do not end it" are the existing bodies,
    // unchanged.
    await transport.register({
      deviceId: 'phone-1',
      token: 'deadbeef',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
    })
    await transport.send({
      kind: 'approval',
      title: 't',
      body: 'b',
      sessionId: 's1',
      threadId: 's1',
      collapseId: 'c',
      timeSensitive: true,
      exceptDeviceIds: [],
    })
    expect(received[2]?.body).not.toHaveProperty('liveActivityToken')
    expect(received[3]?.body).not.toHaveProperty('endLiveActivity')
  })

  it('reports a relay with no push API once, not once per notification', async () => {
    const base = await startRelay()
    status = 404
    reply = { error: 'not found' }
    const lines: string[] = []
    const transport = new RelayTransport({ baseURL: base, token: 'mac-secret', log: (line) => lines.push(line) })

    await transport.send({
      kind: 'approval',
      title: 't',
      body: 'b',
      sessionId: null,
      threadId: 't',
      collapseId: '',
      timeSensitive: false,
      exceptDeviceIds: [],
    })
    await transport.send({
      kind: 'approval',
      title: 't',
      body: 'b',
      sessionId: null,
      threadId: 't',
      collapseId: '',
      timeSensitive: false,
      exceptDeviceIds: [],
    })
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('no push API')
  })

  it('treats an unreachable relay as no notification, not as a failure', async () => {
    // Port 1 has nothing on it. The point is that this resolves.
    const transport = new RelayTransport({
      baseURL: 'http://127.0.0.1:1',
      token: 'mac-secret',
      log: () => {},
      timeoutMs: 500,
    })
    await expect(
      transport.send({
        kind: 'turn-complete',
        title: 't',
        body: 'b',
        sessionId: null,
        threadId: 't',
        collapseId: '',
        timeSensitive: false,
        exceptDeviceIds: [],
      }),
    ).resolves.toBe(0)
  })

  it('is a no-op with nothing configured', async () => {
    // Typed as the interface rather than the class, so the message below is the
    // message a real transport is handed and the no-op has to remain a legal
    // implementation of it.
    const transport: PushTransport = new NoopTransport()
    await transport.register({
      deviceId: 'phone-1',
      token: 'aa',
      platform: 'ios',
      environment: 'sandbox',
      locale: 'en',
    })
    expect(
      await transport.send({
        kind: 'approval',
        title: 't',
        body: 'b',
        sessionId: null,
        threadId: 't',
        collapseId: '',
        timeSensitive: false,
        exceptDeviceIds: [],
      }),
    ).toBe(0)
    await transport.unregister('phone-1')
  })
})

describe('a relay that speaks the API but has no key', () => {
  it('says so once, rather than failing silently', async () => {
    // Everything looks configured -- a key id, a team id, a topic, a reachable
    // relay -- and nothing ever arrives. The one line that explains it has to
    // exist somewhere, and this is the only place that knows.
    const { createServer } = await import('node:http')
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, sent: 0, failed: 0, dropped: 0, enabled: false }))
    })
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
    const lines: string[] = []
    const transport = new RelayTransport({
      baseURL: `http://127.0.0.1:${port}`,
      token: 'mac-secret',
      log: (line) => lines.push(line),
    })
    const message = {
      kind: 'turn-complete' as const,
      title: 't',
      body: 'b',
      sessionId: null,
      threadId: 't',
      collapseId: '',
      timeSensitive: false,
      exceptDeviceIds: [],
    }
    expect(await transport.send(message)).toBe(0)
    expect(await transport.send(message)).toBe(0)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('no APNs key')
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })
})

describe('which sessions a notification may be about', () => {
  it('skips a delegated child, a fork, and nothing else', () => {
    // The test is "would the app draw a row for it", not "is it a subagent".
    // A delegated child carries `origin`; a fork carries `parentSession` and no
    // origin -- it is a session somebody deliberately branched -- but the app
    // treats either field as a child it hides, so a notification about it would
    // open the app onto a conversation with no row in the list.
    expect(isNotifiable({})).toBe(true)
    expect(isNotifiable({ origin: 'subagent' })).toBe(false)
    expect(isNotifiable({ parentSession: 'session-1' })).toBe(false)
    expect(isNotifiable({ origin: 'subagent', parentSession: 'session-1' })).toBe(false)
    // A header that is not there at all is not a session to be woken about.
    expect(isNotifiable(undefined)).toBe(false)
  })

  it('calls the computer idle only when no session the phone draws a row for is running', () => {
    // What decides whether a finished turn may end the Live Activity. The same
    // "would the app show a row" rule as above, over the session list's rows:
    // a hidden subagent still working does not mean the operator is waiting on
    // work they can see.
    const row = (overrides: {
      running?: boolean
      origin?: string | null
      parentSessionId?: string | null
    } = {}) => ({
      running: true,
      origin: null,
      parentSessionId: null,
      ...overrides,
    })

    expect(anyNotifiableSessionRunning([])).toBe(false)
    expect(anyNotifiableSessionRunning([row({ running: false })])).toBe(false)
    expect(anyNotifiableSessionRunning([row()])).toBe(true)
    expect(anyNotifiableSessionRunning([row({ origin: 'subagent' })])).toBe(false)
    expect(anyNotifiableSessionRunning([row({ parentSessionId: 'session-1' })])).toBe(false)
    // The interesting case: the visible session has stopped but a hidden child
    // is still running. The island belongs to the visible work, so it may end.
    expect(
      anyNotifiableSessionRunning([row({ running: false }), row({ origin: 'subagent' })]),
    ).toBe(false)
    // One visible session still working is enough to keep it up.
    expect(
      anyNotifiableSessionRunning([row({ running: false }), row()]),
    ).toBe(true)
  })
})
