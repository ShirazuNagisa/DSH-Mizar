/**
 * Creating a session so that the Mac can see it.
 *
 * DSH attaches a session to a workspace in exactly one place -- `session/create`,
 * and only when the request names a `workspaceId`. With a bare `cwd` it creates
 * the session and attaches nothing, and a workspace's session list is membership
 * rather than a directory scan. So the phone, which groups by working directory,
 * drew a session the Mac's workspace-organised sidebar could not.
 *
 * Measured against a live host before this was fixed: `session.create` with a
 * `cwd` answered with a session id, and the host's workspace registry was still
 * empty afterwards. After it: one workspace, and the session in its
 * `sessionIds`.
 *
 * @module dsh-mizar/test/workspaces
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '../src/dsh.js'
import { createSession } from '../src/bridge/sessions.js'
import { listWorkspaces, resolveWorkspaceId } from '../src/bridge/workspaces.js'

/** One method call the plugin made. */
interface Invocation {
  readonly namespace: string
  readonly method: string
  readonly args?: { readonly request?: Record<string, unknown> }
}

/** The workspace registry, as much of it as the bridge touches. */
interface RegistryLike {
  create(path: string, title?: string): Promise<{ id?: unknown }>
  /** The whole registry, in display order. */
  list?(): readonly unknown[]
  /** The workspace owning a canonical path, without creating one. */
  resolveByPath?(path: string): Promise<unknown>
}

/** A context whose `workspace/follow` yields a baseline with these workspaces. */
function context(options: {
  workspaces?: Array<{ workspaceId: string; path: string; title?: string }>
  registry?: RegistryLike | null
  /** What `ctx.workspaceRegistry.list()` answers, when it is implemented. */
  registryList?: readonly unknown[]
  /** Whether the follow stream refuses outright. */
  throwOnStream?: boolean
  /** Whether closing the follow stream throws, as a carrier that died does. */
  returnThrowsOnStream?: boolean
  onInvoke?: (request: Invocation) => unknown
}): { ctx: Context; calls: Invocation[]; created: string[]; streams: () => number } {
  const calls: Invocation[] = []
  const created: string[] = []
  let streams = 0
  const rows = options.workspaces ?? []
  const registry =
    options.registry === undefined
      ? {
          create: async (path: string) => {
            created.push(path)
            return { id: `ws-for-${path}` }
          },
          ...(options.registryList === undefined ? {} : { list: () => options.registryList ?? [] }),
        }
      : options.registry

  const ctx = {
    typertGateway: {
      stream: async () => {
        streams += 1
        if (options.throwOnStream === true) throw new Error('gateway/invocation-unavailable')
        return {
          [Symbol.asyncIterator]: () => ({
            next: async () => ({
              value: {
                type: 'baseline',
                value: { items: rows.map((row) => ({ title: row.path, ...row })), archivedSessionIds: [], pinnedSessionIds: [] },
              },
              done: false,
            }),
            return: async () => {
              if (options.returnThrowsOnStream === true) throw new Error('the stream is already gone')
              return { value: undefined, done: true }
            },
          }),
        }
      },
      invoke: async (request: Invocation) => {
        calls.push({ namespace: request.namespace, method: request.method, args: request.args })
        return options.onInvoke === undefined ? { sessionId: 'session-1' } : options.onInvoke(request)
      },
    },
    // `get`, not a property read: the plugin reaches for the registry without
    // declaring it, so a composition that has one hands it over and a
    // composition that does not gets `undefined` rather than a failure.
    get: (name: string) => (name === 'workspaceRegistry' ? registry ?? undefined : undefined),
    // The gateway helper registers the Peer's disposal through the context
    // fiber; a double has none.
    effect: () => () => {},
  } as unknown as Context
  return { ctx, calls, created, streams: () => streams }
}

describe('finding the workspace a directory belongs to', () => {
  it('uses the workspace DSH already has, without creating anything', async () => {
    const { ctx, created } = context({
      workspaces: [{ workspaceId: 'ws-1', path: '/Users/you/projects/demo' }],
    })
    expect(await resolveWorkspaceId(ctx, '/Users/you/projects/demo')).toBe('ws-1')
    expect(created).toEqual([])
  })

  it('tolerates a trailing slash', async () => {
    // DSH stores the realpath of a workspace and the path here came out of a
    // session header, which DSH wrote from a workspace path -- so the two agree
    // except for the spelling somebody typed.
    const { ctx } = context({
      workspaces: [{ workspaceId: 'ws-1', path: '/Users/you/projects/demo' }],
    })
    expect(await resolveWorkspaceId(ctx, '/Users/you/projects/demo/')).toBe('ws-1')
  })

  it('creates one when DSH has none, which is what the desktop does', async () => {
    // A session has to live somewhere, and "somewhere DSH does not know about"
    // is not a place the Mac can list it from.
    const { ctx, created } = context({ workspaces: [] })
    expect(await resolveWorkspaceId(ctx, '/Users/you/projects/fresh')).toBe(
      'ws-for-/Users/you/projects/fresh',
    )
    expect(created).toEqual(['/Users/you/projects/fresh'])
  })

  it('answers null when there is no registry to ask', async () => {
    // A composition without `dsh-workspace` loses the ability to invent a
    // workspace and nothing else. The caller falls back to the directory.
    const { ctx } = context({ workspaces: [], registry: null })
    expect(await resolveWorkspaceId(ctx, '/Users/you/projects/fresh')).toBeNull()
  })

  it('answers null when the registry refuses the path', async () => {
    const { ctx } = context({
      workspaces: [],
      registry: {
        create: async () => {
          throw new Error("cannot create a workspace at '/nope': path is not a directory")
        },
      },
    })
    expect(await resolveWorkspaceId(ctx, '/nope')).toBeNull()
  })
})

describe('creating a session', () => {
  it('files it in the workspace rooted at the directory', async () => {
    // The bug this exists for. `workspaceId`, never both: `session/create`
    // refuses a request that names a workspace and a directory together.
    const { ctx, calls } = context({
      workspaces: [{ workspaceId: 'ws-1', path: '/Users/you/projects/demo' }],
    })
    await createSession(ctx, { cwd: '/Users/you/projects/demo' })
    expect(calls).toEqual([
      {
        namespace: 'session',
        method: 'create',
        args: { request: { workspaceId: 'ws-1' } },
      },
    ])
  })

  it('invents a workspace for a directory DSH has never seen', async () => {
    const { ctx, calls, created } = context({ workspaces: [] })
    await createSession(ctx, { cwd: '/Users/you/projects/fresh' })
    expect(created).toEqual(['/Users/you/projects/fresh'])
    expect(calls[0]?.args?.request).toEqual({ workspaceId: 'ws-for-/Users/you/projects/fresh' })
  })

  it('still creates the session when no workspace can be had', async () => {
    // The old behaviour, kept as the floor: a directory that cannot be filed is
    // still a place to work, and refusing to create the session there would be a
    // worse answer than creating one the Mac does not list.
    const { ctx, calls } = context({ workspaces: [], registry: null })
    await createSession(ctx, { cwd: '/Users/you/projects/fresh' })
    expect(calls[0]?.args?.request).toEqual({ cwd: '/Users/you/projects/fresh' })
  })

  it('never moves a session it is only resuming', async () => {
    // Adopting an existing session must not re-file it. `workspaceId` together
    // with a directory DSH disagrees about is an attach that fails the whole
    // call, and the session already has a home -- or deliberately has none.
    //
    // The directory is still forwarded, unchanged from before any of this
    // existed: a resume is the caller saying "this is where it lives", and
    // second-guessing that is how a resume starts moving people's sessions.
    const { ctx, calls } = context({
      workspaces: [{ workspaceId: 'ws-1', path: '/Users/you/projects/demo' }],
    })
    await createSession(ctx, { sessionId: 'session-9', cwd: '/Users/you/projects/demo' })
    expect(calls[0]?.args?.request).toEqual({
      cwd: '/Users/you/projects/demo',
      sessionId: 'session-9',
    })
  })

  it('passes an explicit workspace straight through', async () => {
    const { ctx, calls } = context({ workspaces: [] })
    await createSession(ctx, { workspaceId: 'ws-7' })
    expect(calls[0]?.args?.request).toEqual({ workspaceId: 'ws-7' })
  })

  it('keeps the preset it was asked for', async () => {
    const { ctx, calls } = context({
      workspaces: [{ workspaceId: 'ws-1', path: '/Users/you/projects/demo' }],
    })
    await createSession(ctx, { cwd: '/Users/you/projects/demo', agentPreset: 'standard' })
    expect(calls[0]?.args?.request).toEqual({ workspaceId: 'ws-1', agentPreset: 'standard' })
  })
})

describe('the workspace list the phone draws from', () => {
  it('comes from the registry when the composition has one', async () => {
    // The registry is what the Mac's own sidebar is built from, so it is the
    // only answer that can be *the same* list. `list()` is a synchronous
    // projection of records already in memory: no round trip, no timeout.
    const { ctx, streams } = context({
      registryList: [
        { id: 'ws-1', path: '/Users/you/projects/demo', title: 'demo', sessionIds: ['s1'] },
        { id: 'ws-2', path: '/Users/you/projects/other', title: 'other', sessionIds: [] },
      ],
    })
    const listed = await listWorkspaces(ctx)
    expect(listed.items).toEqual([
      { workspaceId: 'ws-1', path: '/Users/you/projects/demo', title: 'demo', sessionIds: ['s1'] },
      { workspaceId: 'ws-2', path: '/Users/you/projects/other', title: 'other', sessionIds: [] },
    ])
    expect(listed.complete).toBe(true)
    // And the stream is not opened at all: a second way to answer the same
    // question is a second way to disagree with itself.
    expect(streams()).toBe(0)
  })

  it('falls back to the follow baseline without a registry', async () => {
    const { ctx, streams } = context({
      registry: null,
      workspaces: [
        { workspaceId: 'ws-1', path: '/Users/you/projects/demo' },
        { workspaceId: 'ws-2', path: '/Users/you/projects/other' },
      ],
    })
    const listed = await listWorkspaces(ctx)
    expect(listed.items.map((row) => row.workspaceId)).toEqual(['ws-1', 'ws-2'])
    expect(listed.complete).toBe(true)
    expect(streams()).toBe(1)
  })

  it('says so when neither can answer', async () => {
    // `complete: false` is the difference the phone acts on: an incomplete list
    // may only ever add, because "this host cannot say" and "this host has none"
    // are the same empty array.
    const { ctx } = context({ registry: null, throwOnStream: true })
    await expect(listWorkspaces(ctx)).resolves.toEqual({ items: [], complete: false })
  })

  it('keeps the baseline when the stream refuses to be closed', async () => {
    // The list was read; closing the carrier is best effort, exactly as it is
    // for a history page (`followCursor` says so where it does the same job). A
    // close that throws used to discard an answer the phone needed, leaving it
    // on the directory grouping this method exists to replace.
    const { ctx } = context({
      registry: null,
      returnThrowsOnStream: true,
      workspaces: [{ workspaceId: 'ws-1', path: '/Users/you/projects/demo' }],
    })

    const listed = await listWorkspaces(ctx)
    expect(listed.complete).toBe(true)
    expect(listed.items.map((row) => row.workspaceId)).toEqual(['ws-1'])
  })

  it('treats a registry that throws as no answer, not as the stream\'s opinion', async () => {
    // The registry is the durable record; the stream is a separate service that
    // may be holding an older set. Falling back would hand the phone a different
    // answer labelled *complete*, and complete is what it deletes rows on -- so a
    // registry that is there and will not answer ends the question, and the next
    // refresh tries again.
    const { ctx, streams } = context({
      registry: {
        create: async () => ({ id: 'ws-unused' }),
        list: () => {
          throw new Error('the workspace registry has not started yet')
        },
      },
      workspaces: [{ workspaceId: 'ws-stale', path: '/Users/you/projects/old' }],
    })
    await expect(listWorkspaces(ctx)).resolves.toEqual({ items: [], complete: false })
    expect(streams()).toBe(0)
  })

  it('falls back to the stream when the registry has no list at all', async () => {
    // Not a failure: a composition whose registry predates `list` answers this
    // question through the stream, and the stream's baseline is the whole list.
    const { ctx, streams } = context({
      registry: { create: async () => ({ id: 'ws-created' }) },
      workspaces: [{ workspaceId: 'ws-1', path: '/Users/you/projects/demo' }],
    })
    const listed = await listWorkspaces(ctx)
    expect(listed.items.map((row) => row.workspaceId)).toEqual(['ws-1'])
    expect(listed.complete).toBe(true)
    expect(streams()).toBe(1)
  })

  it('keeps an empty registry list, which is an answer', async () => {
    // Somebody deleted their last workspace. Reporting that as "no answer" is
    // how the phone keeps drawing workspaces that are gone -- the reported bug.
    const { ctx } = context({ registryList: [] })
    await expect(listWorkspaces(ctx)).resolves.toEqual({ items: [], complete: true })
  })

  it('drops registry entries that are not shaped like a workspace', async () => {
    // All or nothing: the phone replaces its list on `complete`, so a row this
    // cannot read is a workspace that would vanish from both screens -- and the
    // stream does not get to answer instead, because a shorter list from another
    // service is still a shorter list.
    const { ctx, streams } = context({
      registryList: [{ id: 'ws-1' }, null, 'nope', { path: '/no-id' }],
      workspaces: [{ workspaceId: 'ws-1', path: '/a' }],
    })
    await expect(listWorkspaces(ctx)).resolves.toEqual({ items: [], complete: false })
    expect(streams()).toBe(0)
  })

  it('omits membership the registry did not carry', async () => {
    // `sessionIds` is optional on the wire so the phone can tell "nothing is
    // filed here" from "the host did not say" -- the second one is matched on
    // the path, and the first one is not.
    const { ctx } = context({ registryList: [{ id: 'ws-1', path: '/a', title: 'A' }] })
    expect((await listWorkspaces(ctx)).items[0]).toEqual({ workspaceId: 'ws-1', path: '/a', title: 'A' })
  })
})

describe('resolving a directory through the registry', () => {
  it('asks the registry for the canonical path, and does not create', async () => {
    const asked: string[] = []
    const { ctx, created } = context({
      registry: {
        create: async () => ({ id: 'ws-created' }),
        resolveByPath: async (path: string) => {
          asked.push(path)
          return { id: 'ws-canonical' }
        },
      },
    })
    expect(await resolveWorkspaceId(ctx, '/tmp/project')).toBe('ws-canonical')
    expect(asked).toEqual(['/tmp/project'])
    expect(created).toEqual([])
  })

  it('creates when the registry owns no workspace for the directory', async () => {
    const { ctx, created } = context({
      registry: {
        create: async (path: string) => {
          created.push(path)
          return { id: 'ws-created' }
        },
        resolveByPath: async () => undefined,
      },
    })
    expect(await resolveWorkspaceId(ctx, '/Users/you/projects/fresh')).toBe('ws-created')
    expect(created).toEqual(['/Users/you/projects/fresh'])
  })

  it('falls through to create when the lookup refuses the path', async () => {
    // `resolveByPath` runs `fs.realpath`, so a path that does not exist rejects
    // there. `create` is the one that decides whether that is fatal, and its
    // answer -- null -- is the caller's cue to pass the directory itself.
    const { ctx, created } = context({
      registry: {
        create: async (path: string) => {
          created.push(path)
          return { id: 'ws-created' }
        },
        resolveByPath: async () => {
          throw new Error("realpath '/nope'")
        },
      },
    })
    expect(await resolveWorkspaceId(ctx, '/nope')).toBe('ws-created')
    expect(created).toEqual(['/nope'])
  })
})
