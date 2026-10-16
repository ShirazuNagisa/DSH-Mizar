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
}

/** A context whose `workspace/follow` yields a baseline with these workspaces. */
function context(options: {
  workspaces?: Array<{ workspaceId: string; path: string; title?: string }>
  registry?: RegistryLike | null
  onInvoke?: (request: Invocation) => unknown
}): { ctx: Context; calls: Invocation[]; created: string[] } {
  const calls: Invocation[] = []
  const created: string[] = []
  const rows = options.workspaces ?? []
  const registry =
    options.registry === undefined
      ? {
          create: async (path: string) => {
            created.push(path)
            return { id: `ws-for-${path}` }
          },
        }
      : options.registry

  const ctx = {
    typertGateway: {
      stream: async () => ({
        [Symbol.asyncIterator]: () => ({
          next: async () => ({
            value: {
              type: 'baseline',
              value: { items: rows.map((row) => ({ title: row.path, ...row })), archivedSessionIds: [], pinnedSessionIds: [] },
            },
            done: false,
          }),
          return: async () => ({ value: undefined, done: true }),
        }),
      }),
      invoke: async (request: Invocation) => {
        calls.push({ namespace: request.namespace, method: request.method, args: request.args })
        return options.onInvoke === undefined ? { sessionId: 'session-1' } : options.onInvoke(request)
      },
    },
    // `get`, not a property read: the plugin reaches for the registry without
    // declaring it, so a composition that has one hands it over and a
    // composition that does not gets `undefined` rather than a failure.
    get: (name: string) => (name === 'workspaceRegistry' ? registry ?? undefined : undefined),
  } as unknown as Context
  return { ctx, calls, created }
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
  it('is still the follow baseline, and still closes the stream', async () => {
    const { ctx } = context({
      workspaces: [
        { workspaceId: 'ws-1', path: '/Users/you/projects/demo' },
        { workspaceId: 'ws-2', path: '/Users/you/projects/other' },
      ],
    })
    const listed = await listWorkspaces(ctx)
    expect(listed.items.map((row) => row.workspaceId)).toEqual(['ws-1', 'ws-2'])
  })
})
