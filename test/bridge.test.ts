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
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
import { UploadStore } from '../src/bridge/uploads.js'
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
 * @param options - services to expose through `ctx.get`; a service that is
 *   omitted leaves `ctx.get` itself absent, which is the old composition.
 * @returns the fake context and the recorded invocations.
 */
function fakeContext(
  result: unknown | ((request: Invocation) => unknown),
  options: { fileUploads?: unknown; workspaceRegistry?: unknown } = {},
): {
  ctx: Context
  calls: Invocation[]
} {
  const calls: Invocation[] = []
  const services: Record<string, unknown> = {}
  if (options.fileUploads !== undefined) services['fileUploads'] = options.fileUploads
  if (options.workspaceRegistry !== undefined) services['workspaceRegistry'] = options.workspaceRegistry
  const ctx = {
    // `get`, not a property read: the plugin reaches for these services without
    // declaring them in `inject`, so a composition that has one hands it over
    // and one that does not gets `undefined` rather than a failure.
    ...(Object.keys(services).length === 0 ? {} : { get: (name: string) => services[name] }),
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

  it('reads a delegated child through its parent, and a session as itself', async () => {
    // DSH will not address a child as a session -- it answers `session/agent-busy`
    // and refuses the read before touching the log -- so the parent the phone
    // learned from `session.list` has to survive the bridge intact.
    const { ctx, calls } = fakeContext((request: Invocation) =>
      request.method === 'projections'
        ? { asOfSeq: 5, values: {} }
        : { records: [], hasMore: false },
    )
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    await table['session.messages']?.({ sessionId: 'child', parentSessionId: 'parent' }, context)
    await table['session.messages']?.({ sessionId: 'top' }, context)

    const addresses = calls
      .filter((call) => call.method === 'page')
      .map((call) => (call.args['request'] as { address?: unknown }).address)
    expect(addresses).toEqual([
      { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode: 'unknown' },
      { kind: 'session', sessionId: 'top' },
    ])
  })

  it('exposes every documented method', () => {
    const { ctx } = fakeContext({})
    expect(Object.keys(createMethodTable(ctx, facts, new InteractionBroker())).sort()).toEqual(
      [
        'account.balance',
        'approval.answer',
        'host.info',
        'interactions.pending',
        'model.catalog',
        'permissions.catalog',
        'push.presence',
        'push.register',
        'push.unregister',
        'session.activity',
        'session.archive',
        'session.cancel',
        'session.create',
        'session.fork',
        'session.list',
        'session.model.set',
        'session.permission.set',
        'session.prompt',
        'session.rename',
        'question.answer',
        'upload.abort',
        'upload.begin',
        'upload.capabilities',
        'upload.chunk',
        'upload.finish',
        'session.messages',
        'session.stats',
        'workspace.list',
      ].sort(),
    )
  })

  it('reports every address the host is listening on when it can say', async () => {
    // The relay route tells the phone nothing about where the computer actually
    // is, so a direct dial from a relayed connection depends on this answer.
    const { ctx } = fakeContext({})
    const table = createMethodTable(
      ctx,
      { ...facts, authorities: () => ['192.168.1.10:19390', '127.0.0.1:19390'] },
      new InteractionBroker(),
    )
    await expect(table['host.info']?.(undefined, context)).resolves.toEqual({
      hostId: 'h1',
      hostName: 'mac',
      home: '/home',
      protocolVersion: 1,
      plugin: { id: 'dsh-mizar', capabilities: ['deepseek.balance.v1'] },
      addresses: ['192.168.1.10:19390', '127.0.0.1:19390'],
    })
  })

  it('leaves addresses out entirely when the host cannot say', async () => {
    // Absent and empty are different answers: absent is an old host, and the
    // phone falls back to the address pairing gave it. Sending `[]` would be a
    // claim that there is nowhere to dial.
    const { ctx } = fakeContext({})
    const info = (await createMethodTable(ctx, facts, new InteractionBroker())['host.info']?.(
      undefined,
      context,
    )) as Record<string, unknown>
    expect(info).toEqual({ hostId: 'h1', hostName: 'mac', home: '/home', protocolVersion: 1, plugin: { id: 'dsh-mizar', capabilities: ['deepseek.balance.v1'] } })
    expect('addresses' in info).toBe(false)
  })

  it('reads the addresses when host.info is answered, not when the table is built', async () => {
    // A rebind swaps the listener's addresses under a table that is already
    // built; a cached shape would name where the host used to listen.
    const { ctx } = fakeContext({})
    let bound: readonly string[] = ['127.0.0.1:19390']
    const table = createMethodTable(
      ctx,
      { ...facts, authorities: () => bound },
      new InteractionBroker(),
    )
    expect((await table['host.info']?.(undefined, context)) as { addresses?: string[] }).toMatchObject({
      addresses: ['127.0.0.1:19390'],
    })

    bound = ['127.0.0.1:19391', '192.168.1.10:19391']
    expect((await table['host.info']?.(undefined, context)) as { addresses?: string[] }).toMatchObject({
      addresses: ['127.0.0.1:19391', '192.168.1.10:19391'],
    })
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

describe('session.archive (method table)', () => {
  const context = { deviceId: 'd1', deviceName: 'iPhone', remote: '127.0.0.1' }
  const facts = { hostId: 'h1', hostName: 'mac', home: '/home', protocolVersion: 1 }

  /**
   * A registry that records what the bridge asked it to archive.
   * @param archive - what the registry does when asked.
   * @returns the fake service and the recorded calls.
   */
  function archivingRegistry(
    archive: (sessionId: string, options?: unknown) => Promise<void> = async () => {},
  ): { registry: Record<string, unknown>; calls: { sessionId: string; options: unknown }[] } {
    const calls: { sessionId: string; options: unknown }[] = []
    const registry = {
      // `registryOf` recognises the service by `create`; the archive path then
      // reaches for `archiveSession`.
      create: async () => ({ id: 'unused' }),
      archiveSession: async (sessionId: string, options?: unknown) => {
        calls.push({ sessionId, options })
        await archive(sessionId, options)
      },
    }
    return { registry, calls }
  }

  it('archives through the registry and answers {archived: true}', async () => {
    const { registry, calls } = archivingRegistry()
    const { ctx } = fakeContext({}, { workspaceRegistry: registry })
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    await expect(table['session.archive']?.({ sessionId: 's1' }, context)).resolves.toEqual({
      archived: true,
    })
    // No options when nothing asked to stop work: the registry then refuses a
    // running session, and refusing is the point of this gesture.
    expect(calls).toEqual([{ sessionId: 's1', options: undefined }])
  })

  it('forwards stopActivity only when the request asks for it', async () => {
    const { registry, calls } = archivingRegistry()
    const { ctx } = fakeContext({}, { workspaceRegistry: registry })
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    await table['session.archive']?.({ sessionId: 's1', stopActivity: true }, context)
    await table['session.archive']?.({ sessionId: 's2', stopActivity: false }, context)
    expect(calls).toEqual([
      { sessionId: 's1', options: { stopActivity: true } },
      { sessionId: 's2', options: undefined },
    ])
  })

  it('refuses a running session as an error the app can show', async () => {
    // What DSH throws when `stopActivity` was not asked for and the session is
    // still working. The wire answer is an error, never a success the next
    // refresh would contradict.
    const { registry } = archivingRegistry(async (sessionId) => {
      throw new Error(`cannot archive session '${sessionId}': the session is active (turn)`)
    })
    const { ctx } = fakeContext({}, { workspaceRegistry: registry })
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    await expect(table['session.archive']?.({ sessionId: 's1' }, context)).rejects.toMatchObject({
      code: 'REMOTE_ERROR',
      message: expect.stringContaining('the session is active'),
    })
  })

  it('refuses an unknown session the same way', async () => {
    const { registry } = archivingRegistry(async (sessionId) => {
      throw new Error(
        `cannot archive session '${sessionId}': live sessions and session persistence hold no such session`,
      )
    })
    const { ctx } = fakeContext({}, { workspaceRegistry: registry })
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    await expect(table['session.archive']?.({ sessionId: 'gone' }, context)).rejects.toMatchObject({
      code: 'REMOTE_ERROR',
      message: expect.stringContaining('no such session'),
    })
  })

  it('says so when the composition has no registry to archive in', async () => {
    // Answering `{archived: true}` would tell the phone to drop a row the
    // computer still has, and the next refresh would bring it back.
    const { ctx } = fakeContext({})
    const table = createMethodTable(ctx, facts, new InteractionBroker())
    await expect(table['session.archive']?.({ sessionId: 's1' }, context)).rejects.toMatchObject({
      code: 'REMOTE_ERROR',
    })
  })

  it('requires a session id and a boolean stopActivity', async () => {
    const { registry, calls } = archivingRegistry()
    const { ctx } = fakeContext({}, { workspaceRegistry: registry })
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    await expect(table['session.archive']?.({}, context)).rejects.toMatchObject({
      code: 'MALFORMED_FRAME',
    })
    // Present but not a boolean is a mistake rather than an omission: reading
    // `"yes"` as "do not stop" would turn a client bug into a refusal nobody can
    // explain, and reading it as `true` would kill a running turn.
    await expect(
      table['session.archive']?.({ sessionId: 's1', stopActivity: 'yes' }, context),
    ).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
    await expect(table['session.archive']?.('s1', context)).rejects.toMatchObject({
      code: 'MALFORMED_FRAME',
    })
    expect(calls).toHaveLength(0)
  })
})

describe('archived sessions (method table)', () => {
  const context = { deviceId: 'd1', deviceName: 'iPhone', remote: '127.0.0.1' }
  const facts = { hostId: 'h1', hostName: 'mac', home: '/home', protocolVersion: 1 }

  it('leaves archived sessions out of session.list, keeping activity order', async () => {
    // DSH's own `session/list` still returns them: the archive set is the
    // workspace registry's, and the computer's sidebar filters it itself. A
    // phone that drew the raw list would keep rows the operator put away.
    const { ctx } = fakeContext(
      {
        items: [
          { sessionId: 's-old', updatedAt: 1 },
          { sessionId: 's-archived', updatedAt: 3 },
          { sessionId: 's-new', updatedAt: 2 },
        ],
      },
      { workspaceRegistry: { create: async () => ({ id: 'unused' }), archivedSessionIds: ['s-archived'] } },
    )
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    const listed = (await table['session.list']?.({}, context)) as { items: { sessionId: string }[] }
    expect(listed.items.map((row) => row.sessionId)).toEqual(['s-new', 's-old'])
  })

  it('leaves session.list alone when the composition cannot answer the archive question', async () => {
    // A composition without a registry cannot archive either, so this is the
    // list it always had -- an old phone on an old host must not change.
    const { ctx } = fakeContext({
      items: [
        { sessionId: 's1', updatedAt: 1 },
        { sessionId: 's2', updatedAt: 2 },
      ],
    })
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    const listed = (await table['session.list']?.({}, context)) as { items: { sessionId: string }[] }
    expect(listed.items.map((row) => row.sessionId)).toEqual(['s2', 's1'])
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

/** Temporary directories the attachment tests created, removed after each test. */
const attachmentTempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    attachmentTempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

/**
 * A method table whose uploads live under a fresh temporary state directory.
 *
 * The real `createMethodTable` builds its own store under `facts.home`; passing
 * one in here is what lets the tests use a short chunk size and clean up.
 *
 * @param result - the scripted gateway answer.
 * @param options - a `fileUploads` service to expose, and the chunk size.
 * @returns the table, the recorded gateway calls and the temp directory.
 */
async function attachmentTable(
  result: unknown,
  options: { fileUploads?: unknown; chunkBytes?: number } = {},
): Promise<{
  table: ReturnType<typeof createMethodTable>
  calls: Invocation[]
  dir: string
}> {
  const dir = await mkdtemp(join(tmpdir(), 'mizar-bridge-uploads-'))
  attachmentTempDirs.push(dir)
  const { ctx, calls } = fakeContext(result, {
    ...(options.fileUploads === undefined ? {} : { fileUploads: options.fileUploads }),
  })
  const uploads = new UploadStore({
    root: join(dir, 'uploads'),
    attachmentsRoot: join(dir, 'attachments'),
    chunkBytes: options.chunkBytes ?? 8,
  })
  const table = createMethodTable(
    ctx,
    { hostId: 'h1', hostName: 'mac', home: dir, protocolVersion: 1 },
    new InteractionBroker(),
    undefined,
    undefined,
    uploads,
  )
  return { table, calls, dir }
}

/** The prompt request the gateway was last asked to run. */
function lastPromptRequest(calls: Invocation[]): Record<string, unknown> {
  const call = calls[calls.length - 1]
  if (call?.method !== 'prompt') throw new Error('no prompt call was recorded')
  return (call.args as { request: Record<string, unknown> }).request
}

/**
 * Upload a small attachment through the real method table.
 *
 * @param table - the method table.
 * @param device - the connection the frames arrive on.
 * @param request - what to upload.
 * @param bytes - the exact bytes, which must fit the table's chunk size.
 * @returns the finished attachment.
 */
async function uploadThroughTable(
  table: ReturnType<typeof createMethodTable>,
  device: { deviceId: string; deviceName: string; remote: string },
  request: {
    sessionId: string
    kind: 'image' | 'file'
    name: string
    mediaType: string
    byteSize: number
  },
  bytes: Buffer,
): Promise<{ attachmentId: string; kind: string; name: string; mediaType: string; byteSize: number }> {
  const begun = (await table['upload.begin']?.(request, device)) as {
    uploadId: string
    chunkBytes: number
  }
  expect(begun.chunkBytes).toBe(8)
  await table['upload.chunk']?.(
    { uploadId: begun.uploadId, index: 0, data: bytes.toString('base64') },
    device,
  )
  return (await table['upload.finish']?.({ uploadId: begun.uploadId }, device)) as {
    attachmentId: string
    kind: string
    name: string
    mediaType: string
    byteSize: number
  }
}

describe('attachment upload methods', () => {
  const device = { deviceId: 'd1', deviceName: 'iPhone', remote: '127.0.0.1' }
  const other = { deviceId: 'd2', deviceName: 'iPad', remote: '127.0.0.2' }

  it('runs begin, chunk and finish, and binds the upload to the connection device', async () => {
    const { table } = await attachmentTable({})
    const bytes = Buffer.from('abcdefgh')

    const begun = (await table['upload.begin']?.(
      { sessionId: 's1', kind: 'file', name: 'a.txt', mediaType: 'text/plain', byteSize: bytes.length },
      device,
    )) as { uploadId: string; chunkBytes: number }
    expect(begun.uploadId).toEqual(expect.any(String))
    expect(begun.chunkBytes).toBe(8)

    await expect(
      table['upload.chunk']?.(
        { uploadId: begun.uploadId, index: 0, data: bytes.toString('base64') },
        device,
      ),
    ).resolves.toEqual({ received: 1 })

    // The device id is the socket's, never the payload's: another connection
    // cannot finish somebody else's upload.
    await expect(
      table['upload.finish']?.({ uploadId: begun.uploadId, deviceId: other.deviceId }, other),
    ).rejects.toMatchObject({ code: 'UPLOAD_UNKNOWN' })

    await expect(
      table['upload.finish']?.({ uploadId: begun.uploadId }, device),
    ).resolves.toEqual({
      attachmentId: expect.any(String),
      kind: 'file',
      name: 'a.txt',
      mediaType: 'text/plain',
      byteSize: bytes.length,
    })
  })

  it('aborts a half-sent upload through the table', async () => {
    const { table } = await attachmentTable({})
    const begun = (await table['upload.begin']?.(
      { sessionId: 's1', kind: 'file', name: 'a.txt', mediaType: 'text/plain', byteSize: 8 },
      device,
    )) as { uploadId: string }
    await expect(table['upload.abort']?.({ uploadId: begun.uploadId }, device)).resolves.toEqual({
      aborted: true,
    })
    await expect(table['upload.abort']?.({ uploadId: begun.uploadId }, device)).rejects.toMatchObject({
      code: 'UPLOAD_UNKNOWN',
    })
  })

  it('refuses a begin whose kind or media type is not usable', async () => {
    const { table } = await attachmentTable({})
    await expect(
      table['upload.begin']?.(
        { sessionId: 's1', kind: 'video', name: 'v.mp4', mediaType: 'video/mp4', byteSize: 8 },
        device,
      ),
    ).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
    await expect(
      table['upload.begin']?.(
        { sessionId: 's1', kind: 'image', name: 'p.tiff', mediaType: 'image/tiff', byteSize: 8 },
        device,
      ),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_UNSUPPORTED' })
  })
})

describe('prompt attachments', () => {
  const device = { deviceId: 'd1', deviceName: 'iPhone', remote: '127.0.0.1' }

  it('keeps a text-only prompt exactly as it was', async () => {
    const { table, calls } = await attachmentTable({})
    const result = await table['session.prompt']?.(
      { sessionId: 's1', text: 'hello', requestId: 'keep-me' },
      device,
    )
    expect(result).toEqual({ accepted: true, requestId: 'keep-me' })
    const request = lastPromptRequest(calls)
    expect(request['requestId']).toBe('keep-me')
    expect(request['content']).toEqual([{ type: 'text', text: 'hello' }])
    expect(request['mode']).toBe('queue')
  })

  it('turns a finished image into an inline base64 content part', async () => {
    const { table, calls } = await attachmentTable({})
    const bytes = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg')])
    const finished = await uploadThroughTable(
      table,
      device,
      { sessionId: 's1', kind: 'image', name: 'p.jpg', mediaType: 'image/jpeg', byteSize: bytes.length },
      bytes,
    )

    // No text at all: `text` is optional when attachments are present.
    await expect(
      table['session.prompt']?.(
        { sessionId: 's1', attachmentIds: [finished.attachmentId] },
        device,
      ),
    ).resolves.toMatchObject({ accepted: true })
    expect(lastPromptRequest(calls)['content']).toEqual([
      {
        type: 'image',
        data: bytes.toString('base64'),
        mediaType: 'image/jpeg',
        name: 'p.jpg',
      },
    ])

    // And the text, when there is one, comes first in the caller's order.
    await table['session.prompt']?.(
      { sessionId: 's1', text: 'what is this?', attachmentIds: [finished.attachmentId] },
      device,
    )
    expect(lastPromptRequest(calls)['content']).toEqual([
      { type: 'text', text: 'what is this?' },
      {
        type: 'image',
        data: bytes.toString('base64'),
        mediaType: 'image/jpeg',
        name: 'p.jpg',
      },
    ])
  })

  it('stages a file with fileUploads and sends the receipt', async () => {
    const staged: { sessionId: string; name?: string; bytes: Buffer }[] = []
    const fileUploads = {
      uploadStream: async (request: {
        sessionId: string
        name?: string
        data: AsyncIterable<Uint8Array>
      }) => {
        const parts: Buffer[] = []
        for await (const chunk of request.data) parts.push(Buffer.from(chunk))
        staged.push({
          sessionId: request.sessionId,
          ...(request.name === undefined ? {} : { name: request.name }),
          bytes: Buffer.concat(parts),
        })
        return { receiptId: 'receipt-1' }
      },
    }
    const { table, calls } = await attachmentTable({}, { fileUploads })
    const bytes = Buffer.from('filebody')
    const finished = await uploadThroughTable(
      table,
      device,
      { sessionId: 's1', kind: 'file', name: 'notes.txt', mediaType: 'text/plain', byteSize: bytes.length },
      bytes,
    )

    await table['session.prompt']?.(
      { sessionId: 's1', text: 'see attached', attachmentIds: [finished.attachmentId] },
      device,
    )

    expect(lastPromptRequest(calls)['content']).toEqual([
      { type: 'text', text: 'see attached' },
      { type: 'file', receiptId: 'receipt-1' },
    ])
    expect(staged).toHaveLength(1)
    expect(staged[0]?.sessionId).toBe('s1')
    expect(staged[0]?.name).toBe('notes.txt')
    expect(staged[0]?.bytes).toEqual(bytes)
  })

  it('falls back to a saved path when the host has no fileUploads', async () => {
    const { table, calls, dir } = await attachmentTable({})
    const bytes = Buffer.from('filebody')
    const finished = await uploadThroughTable(
      table,
      device,
      { sessionId: 's1', kind: 'file', name: 'notes.txt', mediaType: 'text/plain', byteSize: bytes.length },
      bytes,
    )

    // File-only prompt: no text part of the caller's own, but the fallback adds
    // a readable handle the agent can act on.
    await expect(
      table['session.prompt']?.(
        { sessionId: 's1', attachmentIds: [finished.attachmentId] },
        device,
      ),
    ).resolves.toMatchObject({ accepted: true })

    const content = lastPromptRequest(calls)['content'] as { type: string; text: string }[]
    expect(content).toHaveLength(1)
    expect(content[0]?.type).toBe('text')
    expect(content[0]?.text.startsWith('[File: notes.txt]\n')).toBe(true)
    const saved = content[0]?.text.slice('[File: notes.txt]\n'.length) ?? ''
    expect(saved.startsWith(join(dir, 'attachments'))).toBe(true)
    await expect(readFile(saved)).resolves.toEqual(bytes)
  })

  it('reports a fileUploads failure as ATTACHMENT_FAILED', async () => {
    const failing = {
      uploadStream: async () => {
        throw new Error('disk full')
      },
    }
    const { table } = await attachmentTable({}, { fileUploads: failing })
    const bytes = Buffer.from('filebody')
    const finished = await uploadThroughTable(
      table,
      device,
      { sessionId: 's1', kind: 'file', name: 'notes.txt', mediaType: 'text/plain', byteSize: bytes.length },
      bytes,
    )
    await expect(
      table['session.prompt']?.(
        { sessionId: 's1', attachmentIds: [finished.attachmentId] },
        device,
      ),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_FAILED' })
  })

  it('reports a receipt-less fileUploads answer as ATTACHMENT_FAILED', async () => {
    const { table } = await attachmentTable({}, { fileUploads: { uploadStream: async () => ({}) } })
    const bytes = Buffer.from('filebody')
    const finished = await uploadThroughTable(
      table,
      device,
      { sessionId: 's1', kind: 'file', name: 'notes.txt', mediaType: 'text/plain', byteSize: bytes.length },
      bytes,
    )
    await expect(
      table['session.prompt']?.(
        { sessionId: 's1', attachmentIds: [finished.attachmentId] },
        device,
      ),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_FAILED' })
  })

  it('refuses a prompt with neither text nor attachments', async () => {
    const { table } = await attachmentTable({})
    await expect(table['session.prompt']?.({ sessionId: 's1' }, device)).rejects.toMatchObject({
      code: 'MALFORMED_FRAME',
    })
    await expect(
      table['session.prompt']?.({ sessionId: 's1', text: '' }, device),
    ).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
  })

  it('refuses a non-string text instead of silently dropping it', async () => {
    const { table } = await attachmentTable({})
    await expect(
      table['session.prompt']?.({ sessionId: 's1', text: 42 }, device),
    ).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
  })

  it('refuses attachmentIds that are not an array of ids', async () => {
    const { table } = await attachmentTable({})
    // `null` is read as "absent" (a client encoding nil explicitly), the same
    // way an absent field is; a value of the wrong shape is a frame error.
    for (const attachmentIds of ['nope', [42], ['']]) {
      await expect(
        table['session.prompt']?.({ sessionId: 's1', text: 'hi', attachmentIds }, device),
        `attachmentIds ${JSON.stringify(attachmentIds)} was accepted`,
      ).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
    }
  })

  it('refuses an attachment that is unknown, expired or not this session’s', async () => {
    const { table } = await attachmentTable({})
    await expect(
      table['session.prompt']?.(
        { sessionId: 's1', attachmentIds: ['not-an-attachment'] },
        device,
      ),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_UNKNOWN' })

    const bytes = Buffer.from('filebody')
    const finished = await uploadThroughTable(
      table,
      device,
      { sessionId: 's1', kind: 'file', name: 'notes.txt', mediaType: 'text/plain', byteSize: bytes.length },
      bytes,
    )
    await expect(
      table['session.prompt']?.(
        { sessionId: 's2', attachmentIds: [finished.attachmentId] },
        device,
      ),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_UNKNOWN' })
  })

  it('refuses more than eight attachment ids before reading anything', async () => {
    const { table } = await attachmentTable({})
    const ids = Array.from({ length: 9 }, (_unused, index) => `attachment-${index}`)
    await expect(
      table['session.prompt']?.({ sessionId: 's1', attachmentIds: ids }, device),
    ).rejects.toMatchObject({ code: 'ATTACHMENT_TOO_LARGE' })
  })

  it('refuses the same attachment listed twice', async () => {
    const { table } = await attachmentTable({})
    const bytes = Buffer.from('filebody')
    const finished = await uploadThroughTable(
      table,
      device,
      { sessionId: 's1', kind: 'file', name: 'notes.txt', mediaType: 'text/plain', byteSize: bytes.length },
      bytes,
    )
    await expect(
      table['session.prompt']?.(
        { sessionId: 's1', attachmentIds: [finished.attachmentId, finished.attachmentId] },
        device,
      ),
    ).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
  })

  it('keeps requestId idempotency when attachments are present', async () => {
    const { table, calls } = await attachmentTable({})
    const bytes = Buffer.from('filebody')
    const finished = await uploadThroughTable(
      table,
      device,
      { sessionId: 's1', kind: 'file', name: 'notes.txt', mediaType: 'text/plain', byteSize: bytes.length },
      bytes,
    )
    const result = await table['session.prompt']?.(
      {
        sessionId: 's1',
        text: 'one more time',
        attachmentIds: [finished.attachmentId],
        requestId: 'retry-me',
      },
      device,
    )
    expect(result).toEqual({ accepted: true, requestId: 'retry-me' })
    expect(lastPromptRequest(calls)['requestId']).toBe('retry-me')
  })
})


describe('session.activity (method table)', () => {
  const context = { deviceId: 'd1', deviceName: 'iPhone', remote: '127.0.0.1' }
  const facts = { hostId: 'h1', hostName: 'mac', home: '/home', protocolVersion: 1 }

  /** One log record in the gateway's shape. */
  function event(type: string, seq: number, data: Record<string, unknown>): unknown {
    return { type: 'event', event: { type, seq, time: 1_700_000_000_000 + seq, data } }
  }

  /**
   * A context that answers the page read and has no follow stream.
   *
   * The missing stream is the older-host path: the cut comes from the
   * projections read, and both reads are still exercised.
   *
   * @param records - the records every page returns.
   * @param options - the page's `hasMore`, and whether the session has a cut.
   * @returns the context and the recorded invocations.
   */
  function activityContext(
    records: unknown[],
    options: { hasMore?: boolean; noCut?: boolean } = {},
  ): { ctx: Context; calls: Invocation[] } {
    const calls: Invocation[] = []
    const ctx = {
      typertGateway: {
        stream: async () => {
          throw new Error('no follow stream in this test')
        },
        invoke: async (request: Invocation) => {
          calls.push({
            namespace: request.namespace,
            method: request.method,
            args: request.args,
          })
          if (request.method === 'projections') {
            return options.noCut === true ? { asOfSeq: null, values: {} } : { asOfSeq: 9, values: {} }
          }
          if (request.method === 'page') return { records, hasMore: options.hasMore === true }
          throw new Error(`unexpected method ${request.method}`)
        },
      },
      effect: () => () => {},
    } as unknown as Context
    return { ctx, calls }
  }

  it('answers the running turn through the method table', async () => {
    const records = [
      event('turn/start', 1, { turn: 1 }),
      event('assistant/attempt', 2, {
        turn: 1,
        step: 1,
        stream: [{ type: 'reasoning-chunks', time0: 1, index: 0, dt: [], texts: ['working on it'] }],
      }),
      event('tool/call', 3, {
        turn: 1,
        step: 1,
        callId: 'c1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'git status' }),
      }),
    ]
    const { ctx } = activityContext(records)
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    const result = (await table['session.activity']?.(
      { sessionId: 's1', maxEntries: 10 },
      context,
    )) as { sessionId: string; turn: number; entries: { kind: string }[] }

    expect(result).toMatchObject({
      sessionId: 's1',
      asOfSeq: 9,
      turn: 1,
      hasMore: false,
      // The page's smallest position: the cursor a later backwards read uses.
      oldestSeq: 1,
    })
    expect(result.entries.map((entry) => entry.kind)).toEqual(['thinking', 'command'])
  })

  it('asks the host for the bounded activity page window', async () => {
    const { ctx, calls } = activityContext([])
    const table = createMethodTable(ctx, facts, new InteractionBroker())
    await table['session.activity']?.({ sessionId: 's1' }, context)

    const page = calls.find((call) => call.method === 'page')
    expect(page?.args).toMatchObject({
      request: {
        address: { kind: 'session', sessionId: 's1' },
        throughSeq: 9,
        maxMessages: 200,
      },
    })
    // A forward read is the newest window: no lower bound travels.
    expect((page?.args as { request: Record<string, unknown> }).request).not.toHaveProperty(
      'beforeSeq',
    )
  })

  it('requires a session id and ignores an unusable maxEntries', async () => {
    const { ctx } = activityContext([])
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    await expect(table['session.activity']?.('nope', context)).rejects.toMatchObject({
      code: 'MALFORMED_FRAME',
    })
    await expect(table['session.activity']?.({}, context)).rejects.toMatchObject({
      code: 'MALFORMED_FRAME',
    })
    // A non-number hint is the default, not an error: the host's own clamp is
    // the authority and the client has nothing useful to do with a refusal.
    await expect(
      table['session.activity']?.({ sessionId: 's1', maxEntries: 'ten' }, context),
    ).resolves.toMatchObject({ sessionId: 's1', turn: null, entries: [] })
  })

  it('widens hasMore on a forward read when the page has older records', async () => {
    // Every row fitted, so nothing was trimmed -- but the page itself starts
    // partway into the log, and the running turn may extend before it. The phone
    // can only find that out by asking, so this answer has to say so.
    const records = [
      event('turn/start', 40, { turn: 3 }),
      event('tool/call', 41, {
        turn: 3,
        step: 1,
        callId: 'c1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'npm test' }),
      }),
    ]
    const { ctx } = activityContext(records, { hasMore: true })
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    const result = (await table['session.activity']?.({ sessionId: 's1' }, context)) as {
      entries: unknown[]
      hasMore: boolean
      oldestSeq: number
    }
    expect(result.entries).toHaveLength(1)
    expect(result.hasMore).toBe(true)
    expect(result.oldestSeq).toBe(40)
  })

  it('reads the page before beforeSeq when paging back', async () => {
    const records = [
      event('tool/call', 20, {
        turn: 2,
        step: 1,
        callId: 'c1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'ls' }),
      }),
    ]
    const { ctx, calls } = activityContext(records)
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    const result = (await table['session.activity']?.(
      { sessionId: 's1', beforeSeq: 42, turn: 2, maxEntries: 10 },
      context,
    )) as { turn: number; entries: { id: string }[]; oldestSeq: number; hasMore: boolean }

    expect(result).toMatchObject({ turn: 2, oldestSeq: 20, hasMore: false })
    expect(result.entries.map((entry) => entry.id)).toEqual(['seq-20'])
    const page = calls.find((call) => call.method === 'page')
    expect(page?.args).toMatchObject({
      request: {
        address: { kind: 'session', sessionId: 's1' },
        throughSeq: 9,
        // The cursor the phone sent is the page's lower bound.
        beforeSeq: 42,
        maxMessages: 200,
      },
    })
  })

  it('keeps hasMore true when a backwards page was trimmed by the cap', async () => {
    // The phone pages from the oldest *returned* row, so rows the cap trimmed
    // from the old end of this page are still reachable -- but only if this
    // answer says the walk continues. Reporting just the page's own bound would
    // end the walk here and drop them silently.
    const records = [20, 21, 22].map((seq) =>
      event('tool/call', seq, {
        turn: 2,
        step: 1,
        callId: `c${seq}`,
        name: 'bash',
        arguments: JSON.stringify({ command: `step ${seq}` }),
      }),
    )
    const { ctx } = activityContext(records)
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    const result = (await table['session.activity']?.(
      { sessionId: 's1', beforeSeq: 42, turn: 2, maxEntries: 2 },
      context,
    )) as { entries: { id: string }[]; hasMore: boolean; oldestSeq: number }

    // The newest rows fit under the cap; the oldest one did not.
    expect(result.entries.map((entry) => entry.id)).toEqual(['seq-21', 'seq-22'])
    expect(result.hasMore).toBe(true)
    expect(result.oldestSeq).toBe(20)
  })

  it('keeps only the requested turn out of a backwards page', async () => {
    // A page is a window cut out of the log, so it normally starts before the
    // turn the caller asked for. Earlier turns' rows are expected and skipped;
    // no `turn/start` is needed in the page.
    const thinking = [
      { type: 'reasoning-chunks', time0: 1, index: 0, dt: [], texts: ['thinking'] },
    ]
    const records = [
      event('tool/call', 10, {
        turn: 1,
        step: 1,
        callId: 'old',
        name: 'bash',
        arguments: JSON.stringify({ command: 'old' }),
      }),
      event('assistant/attempt', 11, { turn: 2, step: 1, stream: thinking }),
      event('tool/call', 12, {
        turn: 2,
        step: 1,
        callId: 'new',
        name: 'bash',
        arguments: JSON.stringify({ command: 'new' }),
      }),
      event('assistant/attempt', 13, { turn: 3, step: 1, stream: thinking }),
    ]
    const { ctx } = activityContext(records, { hasMore: true })
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    const result = (await table['session.activity']?.(
      { sessionId: 's1', beforeSeq: 100, turn: 2 },
      context,
    )) as { turn: number; entries: { id: string }[]; hasMore: boolean; oldestSeq: number }

    expect(result.turn).toBe(2)
    expect(result.entries.map((entry) => entry.id)).toEqual(['seq-11', 'seq-12'])
    // The page has older records and it contributed rows of this turn, so
    // another page may be worth asking for.
    expect(result.hasMore).toBe(true)
    expect(result.oldestSeq).toBe(10)
  })

  it("stops the walk when a backwards page passes the turn's beginning", async () => {
    // Older records exist -- but none of them is of the requested turn. That is
    // the definitive "there is no more history for this turn", not "try again",
    // so the phone must not page for ever on empty answers.
    const records = [
      event('tool/call', 5, {
        turn: 1,
        step: 1,
        callId: 'ancient',
        name: 'bash',
        arguments: JSON.stringify({ command: 'old' }),
      }),
    ]
    const { ctx } = activityContext(records, { hasMore: true })
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    await expect(
      table['session.activity']?.({ sessionId: 's1', beforeSeq: 50, turn: 7 }, context),
    ).resolves.toEqual({
      sessionId: 's1',
      asOfSeq: 9,
      turn: 7,
      entries: [],
      hasMore: false,
      oldestSeq: 5,
    })
  })

  it('answers a backwards page for a session with no log as an empty stop', async () => {
    const { ctx } = activityContext([], { noCut: true })
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    await expect(
      table['session.activity']?.({ sessionId: 'gone', beforeSeq: 5, turn: 2 }, context),
    ).resolves.toEqual({
      sessionId: 'gone',
      asOfSeq: null,
      turn: 2,
      entries: [],
      hasMore: false,
      oldestSeq: null,
    })
  })

  it('refuses beforeSeq without a turn, and ignores a turn without beforeSeq', async () => {
    const records = [
      event('turn/start', 1, { turn: 1 }),
      event('tool/call', 2, {
        turn: 1,
        step: 1,
        callId: 'c1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'npm test' }),
      }),
    ]
    const { ctx, calls } = activityContext(records)
    const table = createMethodTable(ctx, facts, new InteractionBroker())

    // A page read without a turn cannot be answered honestly: the page spans
    // earlier turns, and guessing which one to keep would append another turn's
    // rows to the feed.
    await expect(
      table['session.activity']?.({ sessionId: 's1', beforeSeq: 42 }, context),
    ).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
    await expect(
      table['session.activity']?.({ sessionId: 's1', beforeSeq: 42, turn: 'two' }, context),
    ).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
    await expect(
      table['session.activity']?.({ sessionId: 's1', beforeSeq: -1, turn: 2 }, context),
    ).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })

    // `turn` alone is not a paging request: a forward read names its own
    // running turn, so a stray one is ignored like any other unused field.
    const forward = (await table['session.activity']?.(
      { sessionId: 's1', turn: 99 },
      context,
    )) as { turn: number; entries: { id: string }[] }
    expect(forward.turn).toBe(1)
    expect(forward.entries.map((entry) => entry.id)).toEqual(['seq-2'])
    // None of the refusals read the log; only the forward answer did.
    expect(calls.filter((call) => call.method === 'page')).toHaveLength(1)
  })
})

describe('relay selection over the wire', () => {
  const context = { deviceId: 'd1', deviceName: 'iPhone', remote: '127.0.0.1' }
  const facts = { hostId: 'h1', hostName: 'mac', home: '/home', protocolVersion: 1 }
  const free = 'https://dshmizar.shirazu-nagisa.com'
  const paid = 'https://dshmizar-1.shirazu-nagisa.com'

  /** A host that can move between the two public relays, and remembers requests. */
  function movable() {
    const calls: string[] = []
    let current = { url: free, room: 'ROOM1', baseURL: `${free}/r/ROOM1` }
    return {
      calls,
      control: {
        current: () => current,
        set: async (url: string) => {
          calls.push(url)
          current = { url, room: 'ROOM1', baseURL: `${url}/r/ROOM1` }
          return current
        },
      },
    }
  }

  it('reports the relay facts in host.info when the host can move', async () => {
    const { ctx } = fakeContext({})
    const { control } = movable()
    const table = createMethodTable(ctx, { ...facts, relay: control }, new InteractionBroker())
    await expect(table['host.info']?.(undefined, context)).resolves.toEqual({
      hostId: 'h1',
      hostName: 'mac',
      home: '/home',
      protocolVersion: 1,
      plugin: { id: 'dsh-mizar', capabilities: ['deepseek.balance.v1'] },
      relay: { url: free, room: 'ROOM1', baseURL: `${free}/r/ROOM1` },
    })
  })

  it('leaves relay out of host.info when the host cannot move', async () => {
    const { ctx } = fakeContext({})
    const info = (await createMethodTable(ctx, facts, new InteractionBroker())['host.info']?.(
      undefined,
      context,
    )) as Record<string, unknown>
    expect('relay' in info).toBe(false)
  })

  it('moves the tunnel to the requested public relay', async () => {
    const { ctx } = fakeContext({})
    const { control, calls } = movable()
    const table = createMethodTable(ctx, { ...facts, relay: control }, new InteractionBroker())
    await expect(table['relay.set']?.({ url: paid }, context)).resolves.toEqual({
      url: paid,
      room: 'ROOM1',
      baseURL: `${paid}/r/ROOM1`,
    })
    expect(calls).toEqual([paid])
  })

  it('accepts the free relay and a trailing slash', async () => {
    const { ctx } = fakeContext({})
    const { control, calls } = movable()
    const table = createMethodTable(ctx, { ...facts, relay: control }, new InteractionBroker())
    await expect(table['relay.set']?.({ url: `${free}/` }, context)).resolves.toMatchObject({
      url: free,
    })
    expect(calls).toEqual([free])
  })

  it('refuses a URL outside the allowlist before the host sees it', async () => {
    const { ctx } = fakeContext({})
    const { control, calls } = movable()
    const table = createMethodTable(ctx, { ...facts, relay: control }, new InteractionBroker())
    await expect(
      table['relay.set']?.({ url: 'https://evil.example.com' }, context),
    ).rejects.toMatchObject({ code: 'MALFORMED_FRAME' })
    expect(calls).toHaveLength(0)
  })

  it('refuses a payload without a url', async () => {
    const { ctx } = fakeContext({})
    const { control } = movable()
    const table = createMethodTable(ctx, { ...facts, relay: control }, new InteractionBroker())
    await expect(table['relay.set']?.({}, context)).rejects.toMatchObject({
      code: 'MALFORMED_FRAME',
    })
  })

  it('is absent when the host has no selectable relay', async () => {
    const { ctx } = fakeContext({})
    const table = createMethodTable(ctx, facts, new InteractionBroker())
    expect(table['relay.set']).toBeUndefined()
  })
})
