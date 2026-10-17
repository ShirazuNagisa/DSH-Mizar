/**
 * Tests for the bridge's wire contract and failure translation.
 *
 * The gateway validates arguments at runtime, so a misspelled wire argument —
 * `session/list` takes `_request` while every other session method takes
 * `request` — is a runtime failure, not a compile error. These tests assert the
 * exact argument objects the bridge sends, which is the only place that mistake
 * can be caught before a phone hits it.
 *
 * @module dsh-mizar/test/bridge
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/dsh.js'
import { toMethodError } from '../src/bridge/errors.js'
import { listWorkspaces } from '../src/bridge/workspaces.js'
import {
  MethodError,
  optionalObject,
  optionalString,
  requireObject,
  requireString,
} from '../src/bridge/method-error.js'
import { createMethodTable } from '../src/bridge/index.js'
import { InteractionBroker } from '../src/bridge/interactions.js'
import { modelCatalog, selectModel } from '../src/bridge/models.js'
import { permissionCatalog, setPermissionPreset } from '../src/bridge/permissions.js'
import {
  cancelSession,
  createSession,
  listSessions,
  promptSession,
  renameSession,
  sessionStats,
} from '../src/bridge/sessions.js'

/** A gateway invocation as the bridge issues it. */
interface Invocation {
  namespace: string
  method: string
  args: Record<string, unknown>
}

/**
 * Build a context whose gateway records calls and returns a scripted result.
 *
 * Only the wire-contract fields are recorded — the real request also carries an
 * `AbortSignal`, which would make every exact comparison fail for no reason.
 * @param result - the value to return, or a function producing it.
 * @returns the fake context and the recorded invocations.
 */
function fakeContext(result: unknown | ((request: Invocation) => unknown)): {
  ctx: Context
  calls: Invocation[]
} {
  const calls: Invocation[] = []
  const ctx = {
    typertGateway: {
      invoke: async (request: Invocation) => {
        calls.push({
          namespace: request.namespace,
          method: request.method,
          args: request.args,
        })
        return typeof result === 'function' ? (result as (r: Invocation) => unknown)(request) : result
      },
    },
    // The gateway helper registers the Peer's disposal through the context
    // fiber; a double has none, and the Peer is a process-lifetime singleton
    // here anyway.
    effect: () => () => {},
  } as unknown as Context
  return { ctx, calls }
}

/** A fake context whose `workspace/follow` yields the frames given. */
function streamContext(frames: unknown[], options: { throwOnStream?: boolean } = {}): Context {
  return {
    typertGateway: {
      stream: async () => {
        if (options.throwOnStream === true) throw new Error('gateway/invocation-unavailable')
        let index = 0
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => (index < frames.length
              ? { value: frames[index++], done: false }
              : { value: undefined, done: true }),
            // Recorded so a test can prove the stream is closed; one open
            // subscription per refresh is a leak that only shows up after an
            // hour of use.
            return: async () => {
              closed += 1
              return { value: undefined, done: true }
            },
          }),
        }
      },
      invoke: async () => {
        throw new Error('not used')
      },
    },
    effect: () => () => {},
  } as unknown as Context
}

let closed = 0

describe('workspaces', () => {
  beforeEach(() => {
    closed = 0
  })

  it('reads the list out of the follow baseline', async () => {
    // The fallback path, for a composition with no workspace registry: the list
    // is published through a stream whose first frame is a complete baseline.
    const ctx = streamContext([
      {
        type: 'baseline',
        value: {
          items: [
            { workspaceId: 'w1', path: '/a', title: 'A', sessionIds: ['s1'], createdAt: '', updatedAt: '' },
            { workspaceId: 'w2', path: '/b', title: 'B', sessionIds: [], createdAt: '', updatedAt: '' },
          ],
          archivedSessionIds: [],
          pinnedSessionIds: [],
        },
      },
    ])
    const result = await listWorkspaces(ctx)
    expect(result.items.map((row) => row.path)).toEqual(['/a', '/b'])
    expect(result.items.map((row) => row.title)).toEqual(['A', 'B'])
    // A baseline is the whole list, so the phone is allowed to drop what it
    // holds in favour of it.
    expect(result.complete).toBe(true)
  })

  it('carries each workspace the sessions DSH filed under it', async () => {
    // Membership is not derivable from the session list -- a session created
    // with a bare directory is in none -- so it has to come with the workspace.
    const ctx = streamContext([
      {
        type: 'baseline',
        value: {
          items: [{ workspaceId: 'w1', path: '/a', title: 'A', sessionIds: ['s1', 's2'] }],
        },
      },
    ])
    expect((await listWorkspaces(ctx)).items[0]?.sessionIds).toEqual(['s1', 's2'])
  })

  it('omits membership the source did not carry, rather than sending an empty list', async () => {
    // The phone tells the two apart: an empty list is DSH saying nothing is
    // filed here, and no list is DSH saying nothing, which leaves it matching on
    // the path. Sending `[]` for both is how a recreated workspace adopts the
    // sessions of the deleted one that used to live at the same directory.
    const ctx = streamContext([
      { type: 'baseline', value: { items: [{ workspaceId: 'w1', path: '/a', title: 'A' }] } },
    ])
    const row = (await listWorkspaces(ctx)).items[0]
    expect(row).toEqual({ workspaceId: 'w1', path: '/a', title: 'A' })
    expect('sessionIds' in (row ?? {})).toBe(false)
  })

  it('closes the stream it opened', async () => {
    const ctx = streamContext([{ type: 'baseline', value: { items: [] } }])
    await listWorkspaces(ctx)
    expect(closed).toBe(1)
  })

  it('refuses a list built from a delta', async () => {
    // An `upsert` first means the stream started mid-change. Building the list
    // out of deltas is how a workspace silently disappears from the phone, so
    // anything but a baseline is reported as no answer at all.
    const ctx = streamContext([
      { type: 'upsert', workspace: { workspaceId: 'w1', path: '/a', title: 'A', sessionIds: [], createdAt: '', updatedAt: '' } },
    ])
    expect((await listWorkspaces(ctx)).items).toEqual([])
  })

  it('answers empty rather than throwing when the gateway refuses', async () => {
    // Empty and incomplete means "the host did not say", and the screen keeps
    // grouping on the working directory. A failure here must not be able to
    // remove a workspace somebody is using.
    const ctx = streamContext([], { throwOnStream: true })
    await expect(listWorkspaces(ctx)).resolves.toEqual({ items: [], complete: false })
  })

  it('reports an unreadable entry as no answer rather than a shorter list', async () => {
    // The rows are handed over as *complete*, and the phone deletes rows on the
    // strength of that. Dropping one it cannot parse would take a real workspace
    // off both screens and out of the new-session picker -- so one bad entry
    // costs the whole answer, and the phone falls back to what it had.
    const ctx = streamContext([
      {
        type: 'baseline',
        value: {
          items: [
            { workspaceId: 'w1', path: '/a', title: 'A' },
            { path: '/no-id' },
          ],
        },
      },
    ])
    await expect(listWorkspaces(ctx)).resolves.toEqual({ items: [], complete: false })
  })
})

describe('wire argument names', () => {
  it('session.list sends _request, not request', async () => {
    // The one endpoint with a leading-underscore argument name.
    const { ctx, calls } = fakeContext({ items: [] })
    await listSessions(ctx)
    expect(calls).toEqual([{ namespace: 'session', method: 'list', args: { _request: {} } }])
  })

  it('session.stats sends request.sessionId', async () => {
    const { ctx, calls } = fakeContext({ asOfSeq: 3, values: {} })
    await sessionStats(ctx, 's1')
    expect(calls[0]).toMatchObject({
      namespace: 'session',
      method: 'projections',
      args: { request: { sessionId: 's1' } },
    })
  })

  it('session.create omits absent options instead of sending undefined', async () => {
    const { ctx, calls } = fakeContext({ sessionId: 'new' })
    await createSession(ctx, { cwd: '/tmp/work' })
    expect(calls[0]?.args).toEqual({ request: { cwd: '/tmp/work' } })
    expect(JSON.stringify(calls[0]?.args)).not.toContain('undefined')
  })

  it('session.cancel and session.rename use request', async () => {
    const cancel = fakeContext({})
    await cancelSession(cancel.ctx, 's1')
    expect(cancel.calls[0]?.args).toEqual({ request: { sessionId: 's1' } })

    const rename = fakeContext({})
    await renameSession(rename.ctx, 's1', 'New title')
    expect(rename.calls[0]?.args).toEqual({ request: { sessionId: 's1', title: 'New title' } })
  })

  it('permissions.catalog uses the permissionPresets namespace', async () => {
    const { ctx, calls } = fakeContext({ options: [], defaultOptions: [], defaultPreset: 'x' })
    await permissionCatalog(ctx)
    expect(calls[0]).toEqual({ namespace: 'permissionPresets', method: 'catalog', args: {} })
  })

  it('session.permission.set drives the /permission command with a lookup id', async () => {
    const { ctx, calls } = fakeContext({ result: { kind: 'success' } })
    await setPermissionPreset(ctx, { sessionId: 's1', preset: 'workspace-write' })
    expect(calls[0]).toEqual({
      namespace: 'commands',
      method: 'execute',
      args: {
        // `agentId` is a lookup parameter; a SessionId is what travels.
        agentId: 's1',
        line: '/permission workspace-write',
        submittedAttachments: [],
      },
    })
  })

  it('session.model.set sends the reasoning effort only when chosen', async () => {
    const withEffort = fakeContext({ selected: { provider: 'p', model: 'm', reasoningEffort: 'max' } })
    await selectModel(withEffort.ctx, {
      sessionId: 's1',
      provider: 'p',
      model: 'm',
      reasoningEffort: 'max',
    })
    expect(withEffort.calls[0]?.args).toEqual({
      request: { sessionId: 's1', provider: 'p', model: 'm', reasoningEffort: 'max' },
    })

    const without = fakeContext({ selected: { provider: 'p', model: 'm' } })
    await selectModel(without.ctx, { sessionId: 's1', provider: 'p', model: 'm' })
    expect(without.calls[0]?.args).toEqual({ request: { sessionId: 's1', provider: 'p', model: 'm' } })
  })
})

describe('prompt idempotency', () => {
  it('mints a requestId when the client does not supply one', async () => {
    const { ctx, calls } = fakeContext({})
    const result = await promptSession(ctx, { sessionId: 's1', text: 'hello' })
    const request = (calls[0]?.args as { request: Record<string, unknown> }).request
    expect(typeof request['requestId']).toBe('string')
    expect(request['requestId']).toBe(result.requestId)
  })

  it('reuses a client-supplied requestId so a retry cannot double-send', async () => {
    const { ctx, calls } = fakeContext({})
    const result = await promptSession(ctx, { sessionId: 's1', text: 'hello', requestId: 'keep-me' })
    const request = (calls[0]?.args as { request: Record<string, unknown> }).request
    expect(request['requestId']).toBe('keep-me')
    expect(result.requestId).toBe('keep-me')
  })

  it('wraps the text as a single text content part', async () => {
    const { ctx, calls } = fakeContext({})
    await promptSession(ctx, { sessionId: 's1', text: 'hello' })
    const request = (calls[0]?.args as { request: Record<string, unknown> }).request
    expect(request['content']).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('defaults the delivery mode to queue', async () => {
    const { ctx, calls } = fakeContext({})
    await promptSession(ctx, { sessionId: 's1', text: 'hi' })
    const request = (calls[0]?.args as { request: Record<string, unknown> }).request
    expect(request['mode']).toBe('queue')
  })

  it('passes steer through unchanged', async () => {
    const { ctx, calls } = fakeContext({})
    await promptSession(ctx, { sessionId: 's1', text: 'hi', mode: 'steer' })
    const request = (calls[0]?.args as { request: Record<string, unknown> }).request
    expect(request['mode']).toBe('steer')
  })

  it('forwards the client time zone when given', async () => {
    const { ctx, calls } = fakeContext({})
    await promptSession(ctx, { sessionId: 's1', text: 'hi', clientTimeZone: 'Asia/Shanghai' })
    const request = (calls[0]?.args as { request: Record<string, unknown> }).request
    expect(request['clientTimeZone']).toBe('Asia/Shanghai')
  })
})

describe('session.create', () => {
  it('rejects a response with no session id', async () => {
    const { ctx } = fakeContext({})
    await expect(createSession(ctx, {})).rejects.toThrow(MethodError)
  })

  it('reports the agent preset when the host supplied one', async () => {
    const { ctx } = fakeContext({ sessionId: 's1', agentPreset: 'standard' })
    await expect(createSession(ctx, {})).resolves.toEqual({ sessionId: 's1', agentPreset: 'standard' })
  })

  it('reports a missing preset as null', async () => {
    const { ctx } = fakeContext({ sessionId: 's1' })
    await expect(createSession(ctx, {})).resolves.toEqual({ sessionId: 's1', agentPreset: null })
  })
})

describe('model catalog normalisation', () => {
  it('reads reasoning levels and the default effort', async () => {
    const { ctx } = fakeContext({
      default: { provider: 'deepseek-official', model: 'deepseek-flash' },
      groups: [
        {
          id: 'deepseek-official',
          name: 'DeepSeek',
          models: [
            {
              id: 'deepseek-flash',
              name: 'DeepSeek Flash',
              description: 'fast',
              reasoning: {
                efforts: [
                  { id: 'off', name: 'Off' },
                  { id: 'low', name: 'Low' },
                  { id: 'high', name: 'High', description: 'more thinking' },
                  { id: 'max', name: 'Max' },
                ],
                defaultEffort: 'high',
              },
            },
          ],
        },
      ],
    })

    const catalog = await modelCatalog(ctx)
    expect(catalog.default).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(catalog.providers).toHaveLength(1)
    const model = catalog.providers[0]?.models[0]
    expect(model?.efforts.map((effort) => effort.id)).toEqual(['off', 'low', 'high', 'max'])
    expect(model?.defaultEffort).toBe('high')
    expect(model?.efforts[2]?.description).toBe('more thinking')
  })

  it('reports a model with no reasoning levels as an empty list', async () => {
    const { ctx } = fakeContext({
      groups: [{ id: 'p', name: 'P', models: [{ id: 'm', name: 'M' }] }],
    })
    const catalog = await modelCatalog(ctx)
    expect(catalog.providers[0]?.models[0]?.efforts).toEqual([])
    expect(catalog.providers[0]?.models[0]?.defaultEffort).toBeUndefined()
  })

  it('surfaces provider failures rather than hiding them', async () => {
    const { ctx } = fakeContext({
      groups: [],
      failures: [{ id: 'broken', name: 'Broken', message: 'no credentials' }],
    })
    const catalog = await modelCatalog(ctx)
    expect(catalog.failures).toEqual([{ id: 'broken', name: 'Broken', message: 'no credentials' }])
  })

  it('survives a catalog with unusable rows', async () => {
    const { ctx } = fakeContext({
      default: { provider: 'p' },
      groups: [null, { name: 'no id' }, { id: 'p', models: [null, { name: 'no id' }] }],
      failures: [null, { name: 'no id' }],
    })
    const catalog = await modelCatalog(ctx)
    expect(catalog.default).toBeNull()
    expect(catalog.providers).toEqual([{ id: 'p', name: 'p', models: [] }])
    expect(catalog.failures).toEqual([])
  })

  it('reads back the selection the host confirmed', async () => {
    const { ctx } = fakeContext({
      selected: { provider: 'p', model: 'm', reasoningEffort: 'max' },
    })
    await expect(
      selectModel(ctx, { sessionId: 's1', provider: 'p', model: 'm', reasoningEffort: 'max' }),
    ).resolves.toEqual({
      sessionId: 's1',
      selected: { provider: 'p', model: 'm', reasoningEffort: 'max' },
    })
  })

  it('rejects an unusable selection response', async () => {
    const { ctx } = fakeContext({ selected: { provider: 'p' } })
    await expect(selectModel(ctx, { sessionId: 's1', provider: 'p', model: 'm' })).rejects.toThrow(MethodError)
  })
})

describe('permission catalog normalisation', () => {
  it('reads options, defaults and the default preset', async () => {
    const { ctx } = fakeContext({
      options: [
        { value: 'read-only', name: 'Read Only' },
        { value: 'workspace-write', name: 'Workspace Write', description: 'edits the workspace' },
      ],
      defaultOptions: [{ value: 'workspace-write', name: 'Workspace Write' }],
      defaultPreset: 'workspace-write',
    })

    const catalog = await permissionCatalog(ctx)
    expect(catalog.options.map((option) => option.value)).toEqual(['read-only', 'workspace-write'])
    expect(catalog.options[1]?.description).toBe('edits the workspace')
    expect(catalog.defaults).toHaveLength(1)
    expect(catalog.defaultPreset).toBe('workspace-write')
  })

  it('drops options without a value and survives an empty catalog', async () => {
    const { ctx } = fakeContext({ options: [null, { name: 'no value' }] })
    const catalog = await permissionCatalog(ctx)
    expect(catalog.options).toEqual([])
    expect(catalog.defaultPreset).toBe('')
  })
})

describe('permission switching', () => {
  it('treats an error result as a failure, not a silent success', async () => {
    // commands.execute reports failure in its *result*, not by throwing, so a
    // caller that only checks for a throw would report success.
    const { ctx } = fakeContext({ result: { kind: 'error', text: 'unknown preset' } })
    await expect(setPermissionPreset(ctx, { sessionId: 's1', preset: 'nope' })).rejects.toThrow(
      'unknown preset',
    )
  })

  it('returns the command report on success', async () => {
    const { ctx } = fakeContext({ result: { kind: 'success', text: 'switched' } })
    await expect(setPermissionPreset(ctx, { sessionId: 's1', preset: 'read-only' })).resolves.toEqual({
      commandResult: { kind: 'success', text: 'switched' },
    })
  })

  it('rejects a result with no usable kind', async () => {
    const { ctx } = fakeContext({ result: {} })
    await expect(setPermissionPreset(ctx, { sessionId: 's1', preset: 'x' })).rejects.toThrow(MethodError)
  })
})

describe('toMethodError', () => {
  it('passes an existing MethodError through unchanged', () => {
    const original = new MethodError('MALFORMED_FRAME', 'bad')
    expect(toMethodError(original)).toBe(original)
  })

  it('maps writer contention to WRITER_HELD', () => {
    // The app retries on this specific code, so it must not be folded away.
    const error = Object.assign(new Error('held'), { code: 'session/writer-held' })
    expect(toMethodError(error).code).toBe('WRITER_HELD')
  })

  it('maps an unavailable model to MODEL_UNAVAILABLE', () => {
    expect(toMethodError(Object.assign(new Error('nope'), { code: 'session/model-unavailable' })).code).toBe(
      'MODEL_UNAVAILABLE',
    )
    expect(
      toMethodError(Object.assign(new Error('none'), { code: 'session/provider-models-unavailable' })).code,
    ).toBe('MODEL_UNAVAILABLE')
  })

  it('folds an unclassified upstream code into REMOTE_ERROR but keeps the code', () => {
    const error = Object.assign(new Error('boom'), { code: 'gateway/uplink-overflow' })
    const mapped = toMethodError(error)
    expect(mapped.code).toBe('REMOTE_ERROR')
    expect(mapped.message).toContain('gateway/uplink-overflow')
  })

  it('handles a thrown non-object', () => {
    const mapped = toMethodError('something went wrong')
    expect(mapped.code).toBe('REMOTE_ERROR')
    expect(mapped.message).toBe('something went wrong')
  })

  it('preserves the upstream failure as the cause', () => {
    const error = Object.assign(new Error('boom'), { code: 'session/writer-held' })
    expect(toMethodError(error).cause).toBe(error)
  })
})

describe('method table', () => {
  const context = { deviceId: 'd1', deviceName: 'iPhone', remote: '127.0.0.1' }
  const facts = { hostId: 'h1', hostName: 'mac', home: '/home', protocolVersion: 1 }

  it('rejects a non-object payload for an all-optional method without side effects', async () => {
    // Found by the live smoke test: a string payload used to degrade to "create
    // with defaults" and actually created a session.
    const { ctx, calls } = fakeContext({ sessionId: 's1' })
    const table = createMethodTable(ctx, facts, new InteractionBroker())
    await expect(table['session.create']?.('not an object', context)).rejects.toMatchObject({
      code: 'MALFORMED_FRAME',
    })
    expect(calls).toHaveLength(0)
  })

  it('treats an absent payload as a defaults call', async () => {
    const { ctx, calls } = fakeContext({ sessionId: 's1' })
    const table = createMethodTable(ctx, facts, new InteractionBroker())
    await expect(table['session.create']?.(undefined, context)).resolves.toEqual({
      sessionId: 's1',
      agentPreset: null,
    })
    expect(calls).toHaveLength(1)
  })

  it('translates an upstream failure into a wire-coded error through the guard', async () => {
    const ctx = {
      typertGateway: {
        invoke: vi.fn().mockRejectedValue(
          Object.assign(new Error('busy'), { code: 'session/writer-held' }),
        ),
      },
      effect: () => () => {},
    } as unknown as Context
    const table = createMethodTable(ctx, facts, new InteractionBroker())
    await expect(
      table['session.create']?.({ sessionId: 's1' }, context),
    ).rejects.toMatchObject({ code: 'WRITER_HELD' })
  })

  it('exposes every documented method', () => {
    const { ctx } = fakeContext({})
    expect(Object.keys(createMethodTable(ctx, facts, new InteractionBroker())).sort()).toEqual(
      [
        'approval.answer',
        'host.info',
        'interactions.pending',
        'model.catalog',
        'permissions.catalog',
        'push.presence',
        'push.register',
        'push.unregister',
        'session.cancel',
        'session.create',
        'session.list',
        'session.model.set',
        'session.permission.set',
        'session.prompt',
        'session.rename',
        'question.answer',
        'session.messages',
        'session.stats',
        'workspace.list',
      ].sort(),
    )
  })

  it('hands push registrations to the binding, and the device id with them', async () => {
    const { ctx } = fakeContext({})
    const calls: unknown[] = []
    const push = {
      register: async (deviceId: string, input: unknown) => {
        calls.push(['register', deviceId, input])
        return true
      },
      presence: (deviceId: string, foreground: boolean) => {
        calls.push(['presence', deviceId, foreground])
      },
      unregister: async (deviceId: string) => {
        calls.push(['unregister', deviceId])
        return true
      },
      republish: async () => 0,
    }
    const table = createMethodTable(ctx, facts, new InteractionBroker(), push)

    // The device id comes from the authenticated connection, never from the
    // payload: a caller must not be able to register a token against somebody
    // else's phone.
    expect(
      await table['push.register']?.(
        { token: 'deadbeef', environment: 'sandbox', locale: 'zh-Hans', deviceId: 'somebody-else' },
        context,
      ),
    ).toEqual({ registered: true })
    expect(calls[0]).toEqual([
      'register',
      context.deviceId,
      // `platform` is added by the reader rather than by the client: an app
      // build that predates the field is an iOS one, and defaulting here is what
      // lets it keep registering unchanged.
      {
        token: 'deadbeef',
        platform: 'ios',
        environment: 'sandbox',
        locale: 'zh-Hans',
        liveActivityToken: null,
      },
    ])

    expect(await table['push.presence']?.({ foreground: true }, context)).toEqual({ accepted: true })
    expect(calls[1]).toEqual(['presence', context.deviceId, true])
    expect(await table['push.unregister']?.({}, context)).toEqual({ unregistered: true })
    expect(calls[2]).toEqual(['unregister', context.deviceId])
  })

  it('requires an environment on a push registration', async () => {
    const { ctx } = fakeContext({})
    const table = createMethodTable(ctx, facts, new InteractionBroker(), {
      register: async () => true,
      presence: () => {},
      unregister: async () => true,
      republish: async () => 0,
    })
    // Not defaulted. A sandbox token sent to the production host is refused by
    // Apple with `BadDeviceToken`, which says nothing about the real mistake --
    // so guessing here turns a clear client bug into an unexplained silence.
    await expect(table['push.register']?.({ token: 'aa' }, context)).rejects.toMatchObject({
      code: 'MALFORMED_FRAME',
    })
    await expect(table['push.presence']?.({}, context)).rejects.toMatchObject({
      code: 'MALFORMED_FRAME',
    })
    // And still required when the client says which platform it is: the rule is
    // about iOS, and saying so explicitly does not change it.
    await expect(
      table['push.register']?.({ token: 'aa', platform: 'ios' }, context),
    ).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
  })

  it('takes an Android registration with no environment, and one with', async () => {
    const { ctx } = fakeContext({})
    const calls: unknown[] = []
    const push = {
      register: async (deviceId: string, input: unknown) => {
        calls.push(['register', deviceId, input])
        return true
      },
      presence: () => {},
      unregister: async () => true,
      republish: async () => 0,
    }
    const table = createMethodTable(ctx, facts, new InteractionBroker(), push)

    // An FCM registration token: not hex, and with no APNs environment to give.
    // Before `platform` existed this payload could not be expressed at all, and
    // the token itself was refused as malformed by the relay.
    expect(
      await table['push.register']?.(
        { token: 'dGhpc2lzOm5vdC1oZXg_APA91b', platform: 'android' },
        context,
      ),
    ).toEqual({ registered: true })
    expect(calls[0]).toEqual([
      'register',
      context.deviceId,
      {
        token: 'dGhpc2lzOm5vdC1oZXg_APA91b',
        platform: 'android',
        environment: null,
        locale: 'en',
        liveActivityToken: null,
      },
    ])

    // Android has one service, so a stray environment is dropped rather than
    // refused: rejecting it would make one client version unable to register for
    // a reason that cannot be true.
    expect(
      await table['push.register']?.(
        { token: 'dGhpc2lzOm5vdC1oZXg_APA91b', platform: 'android', environment: 'sandbox' },
        context,
      ),
    ).toEqual({ registered: true })
    expect(calls[1]).toEqual([
      'register',
      context.deviceId,
      {
        token: 'dGhpc2lzOm5vdC1oZXg_APA91b',
        platform: 'android',
        environment: null,
        locale: 'en',
        liveActivityToken: null,
      },
    ])
  })

  it('defaults a registration with no platform to iOS, exactly as before', async () => {
    const { ctx } = fakeContext({})
    const calls: unknown[] = []
    const table = createMethodTable(ctx, facts, new InteractionBroker(), {
      register: async (deviceId: string, input: unknown) => {
        calls.push(['register', deviceId, input])
        return true
      },
      presence: () => {},
      unregister: async () => true,
      republish: async () => 0,
    })

    // What every shipped iOS build sends. Nothing about it may change: this is
    // the payload the app in somebody's pocket is sending right now.
    expect(
      await table['push.register']?.(
        { token: 'deadbeef', environment: 'sandbox', locale: 'zh-Hans' },
        context,
      ),
    ).toEqual({ registered: true })
    expect(calls[0]).toEqual([
      'register',
      context.deviceId,
      {
        token: 'deadbeef',
        platform: 'ios',
        environment: 'sandbox',
        locale: 'zh-Hans',
        liveActivityToken: null,
      },
    ])
  })

  it('carries a Live Activity token, and reads its absence as "none is up"', async () => {
    const { ctx } = fakeContext({})
    const calls: unknown[] = []
    const table = createMethodTable(ctx, facts, new InteractionBroker(), {
      register: async (deviceId: string, input: unknown) => {
        calls.push(['register', deviceId, input])
        return true
      },
      presence: () => {},
      unregister: async () => true,
      republish: async () => 0,
    })

    // An APNs Live Activity push token: lowercase hex, and the only thing that
    // lets the relay end a countdown which would otherwise tick on after the app
    // is suspended.
    expect(
      await table['push.register']?.(
        { token: 'deadbeef', environment: 'sandbox', liveActivityToken: 'ab12cd34ef' },
        context,
      ),
    ).toEqual({ registered: true })
    expect((calls[0] as [string, string, Record<string, unknown>])[2]['liveActivityToken']).toBe(
      'ab12cd34ef',
    )

    // Absent is not "nothing changed": it says no Live Activity is up now, so
    // the stored one must be cleared. `null` is how the binding is told to clear.
    await table['push.register']?.({ token: 'deadbeef', environment: 'sandbox' }, context)
    expect((calls[1] as [string, string, Record<string, unknown>])[2]['liveActivityToken']).toBeNull()

    // Android has no Live Activity at all. A stray value is dropped rather than
    // refused, for the same reason a stray `environment` is: FCM has one service
    // and nothing to give this field.
    await table['push.register']?.(
      { token: 'not-hex-fcm', platform: 'android', liveActivityToken: 'ab12cd34ef' },
      context,
    )
    expect((calls[2] as [string, string, Record<string, unknown>])[2]['liveActivityToken']).toBeNull()
  })

  it('refuses a Live Activity token that is not lowercase hex of a sane length', async () => {
    const { ctx } = fakeContext({})
    const calls: unknown[] = []
    const table = createMethodTable(ctx, facts, new InteractionBroker(), {
      register: async (deviceId: string, input: unknown) => {
        calls.push(['register', deviceId, input])
        return true
      },
      presence: () => {},
      unregister: async () => true,
      republish: async () => 0,
    })

    // Not defaulted and not silently cleared: a client that meant to register a
    // Live Activity token but got the format wrong would otherwise believe the
    // countdown can be ended, and find out it cannot only once the app is
    // suspended. Absence is the one way to say "none is up".
    for (const value of ['', 'AB12CD', 'ab12zz', 'a'.repeat(201), 42, null]) {
      await expect(
        table['push.register']?.(
          { token: 'deadbeef', environment: 'sandbox', liveActivityToken: value },
          context,
        ),
        `liveActivityToken ${JSON.stringify(value)} was accepted`,
      ).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
    }
    expect(calls).toHaveLength(0)
  })

  it('refuses a platform it does not know', async () => {
    const { ctx } = fakeContext({})
    const table = createMethodTable(ctx, facts, new InteractionBroker(), {
      register: async () => true,
      presence: () => {},
      unregister: async () => true,
      republish: async () => 0,
    })
    // Not treated as iOS: a client that says "windows", or "Android" with the
    // wrong case, has a bug, and silently registering its token against APNs is
    // how that bug becomes an unexplained silence.
    await expect(
      table['push.register']?.(
        { token: 'deadbeef', platform: 'windows', environment: 'sandbox' },
        context,
      ),
    ).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
    await expect(
      table['push.register']?.(
        { token: 'deadbeef', platform: 'android ', environment: 'sandbox' },
        context,
      ),
    ).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
  })

  it('answers push calls cleanly when the host has no push at all', async () => {
    const { ctx } = fakeContext({})
    const table = createMethodTable(ctx, facts, new InteractionBroker())
    // A composition without a relay still has to answer. An error here would be
    // a phone that has to know which plugin build it is talking to.
    expect(await table['push.register']?.({ token: 'aa', environment: 'production' }, context)).toEqual(
      { registered: false },
    )
    expect(await table['push.presence']?.({ foreground: false }, context)).toEqual({ accepted: true })
    expect(await table['push.unregister']?.({}, context)).toEqual({ unregistered: false })
  })
})

describe('payload helpers', () => {
  it('requires an object payload', () => {
    expect(() => requireObject(null, 'm')).toThrow(MethodError)
    expect(() => requireObject([], 'm')).toThrow(MethodError)
    expect(() => requireObject('x', 'm')).toThrow(MethodError)
    expect(requireObject({ a: 1 }, 'm')).toEqual({ a: 1 })
  })

  it('requires a non-empty string field', () => {
    expect(() => requireString({}, 'sessionId', 'm')).toThrow(MethodError)
    expect(() => requireString({ sessionId: '' }, 'sessionId', 'm')).toThrow(MethodError)
    expect(() => requireString({ sessionId: 7 }, 'sessionId', 'm')).toThrow(MethodError)
    expect(requireString({ sessionId: 's' }, 'sessionId', 'm')).toBe('s')
  })

  it('names the offending method and field in the message', () => {
    expect(() => requireString({}, 'sessionId', 'session.prompt')).toThrow(/session\.prompt.*sessionId/)
  })

  it('accepts an absent payload but rejects a wrongly typed one', () => {
    expect(optionalObject(undefined, 'm')).toEqual({})
    expect(optionalObject(null, 'm')).toEqual({})
    expect(optionalObject({ a: 1 }, 'm')).toEqual({ a: 1 })
    expect(() => optionalObject('x', 'm')).toThrow(MethodError)
    expect(() => optionalObject([], 'm')).toThrow(MethodError)
    expect(() => optionalObject(7, 'm')).toThrow(MethodError)
  })

  it('treats an absent or empty optional string as absent', () => {
    expect(optionalString({}, 'x')).toBeUndefined()
    expect(optionalString({ x: '' }, 'x')).toBeUndefined()
    expect(optionalString({ x: 1 }, 'x')).toBeUndefined()
    expect(optionalString({ x: 'v' }, 'x')).toBe('v')
  })
})

describe('error propagation end to end', () => {
  it('turns a gateway failure into a wire-coded error', async () => {
    const ctx = {
      typertGateway: {
        invoke: vi.fn().mockRejectedValue(
          Object.assign(new Error('session is busy'), { code: 'session/writer-held' }),
        ),
      },
      effect: () => () => {},
    } as unknown as Context

    // The bridge itself throws the upstream error; the method table's guard is
    // what translates it, so assert through the same path.
    await expect(createSession(ctx, { sessionId: 's1' })).rejects.toMatchObject({
      code: 'session/writer-held',
    })
    expect(toMethodError(await capture(() => createSession(ctx, { sessionId: 's1' }))).code).toBe(
      'WRITER_HELD',
    )
  })
})

/**
 * Run a thunk and return whatever it threw.
 * @param thunk - the operation expected to fail.
 * @returns the thrown value.
 */
async function capture(thunk: () => Promise<unknown>): Promise<unknown> {
  try {
    await thunk()
    throw new Error('expected the thunk to throw')
  } catch (error) {
    return error
  }
}
