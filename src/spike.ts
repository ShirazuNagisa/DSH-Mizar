/**
 * Phase 0.1 spike — settles the one unknown the whole plugin design rests on:
 * **can a third-party plugin drive the shipped Typert Remotes and read session
 * projections from its own Cordis context, in-process, with no wire client?**
 *
 * Three questions, each answered independently and reported as PASS/FAIL:
 *
 *   1. `ctx.typertGateway.invoke()` on a strict generated endpoint.
 *   2. `ctx.sessionProjections.snapshot()` on a live session.
 *   3. `ctx.typertGateway.stream()` on a `mode: 'stream'` endpoint.
 *
 * If (1) or (3) fail, the plugin falls back to calling the `sessionController`
 * business methods directly; projections (2) are a plain Cordis service with no
 * Remote involvement, so they are expected to work either way.
 *
 * @module dsh-mizar/spike
 */
import type { Context } from './dsh.js'
import { invokeRemote, streamRemote } from './bridge/invoke.js'
import { awaitEndpoints } from './ready.js'

/** Strict endpoints the spike addresses, in `namespace/method` form. */
const REQUIRED_ENDPOINTS = [
  'session/create',
  'session/list',
  'session/modelCatalog',
  'session/control',
] as const

/** Result of one probed capability. */
interface ProbeResult {
  readonly name: string
  readonly ok: boolean
  readonly detail: string
}

const PROJECTION_KEYS = [
  'tokenUsage',
  'contextPressure',
  'contextBreakdown',
  'sessionStats',
  'modelSelection',
  'permissions',
  'title',
] as const

/** Render an unknown thrown value as one readable line. */
function describe(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}

/**
 * Emit one spike line on plain stdout.
 *
 * The spike deliberately does not use `ctx.logger`: a Cordis logger's
 * visibility depends on the composition's exporters, and a diagnostic that
 * silently vanishes is worse than no diagnostic.
 * @param line - the message to emit.
 */
function say(line: string): void {
  console.log(`[mizar] ${line}`)
}

/** Trim a JSON-ish value so the log line stays short. */
function preview(value: unknown, limit = 240): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? String(value)
  } catch {
    text = String(value)
  }
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

/**
 * Probe one capability, converting any throw into a failed result so one broken
 * seam cannot hide the others.
 * @param name - capability label used in the report.
 * @param body - the probe.
 * @returns the probe outcome.
 */
async function probe(name: string, body: () => Promise<string>): Promise<ProbeResult> {
  try {
    return { name, ok: true, detail: await body() }
  } catch (error) {
    return { name, ok: false, detail: describe(error) }
  }
}

/**
 * Run the Phase 0.1 probe set once and log a single report.
 *
 * The `session/create` call is deliberate: a session has to exist for the
 * projection and stream probes to have something to address. It lands in the
 * development profile's own `$DSH_HOME`, never in the operator's real home.
 *
 * @param ctx - the plugin's own context.
 * @param workspace - absolute directory to root the probe session in.
 */
export async function runSpike(ctx: Context, workspace: string): Promise<void> {
  const results: ProbeResult[] = []

  say(`Phase 0.1 spike starting (workspace=${workspace})`)

  // Measured ordering fact: `apply()` runs during composition, but the strict
  // Typert descriptors register later, so an immediate invoke fails with
  // `gateway/invocation-unavailable`. Gate on the descriptors themselves.
  const ready = await awaitEndpoints(ctx, REQUIRED_ENDPOINTS, { timeoutMs: 60_000 })
  say(
    `readiness: ${ready.ok ? 'all required endpoints registered' : 'TIMED OUT'} — ` +
      `registered=${ready.registeredCount} missing=[${ready.missing.join(', ')}]`,
  )
  if (!ready.ok) {
    say(`Phase 0.1 spike ALL FAIL — endpoints never registered (${ready.registeredCount} local descriptors)`)
    return
  }

  let sessionId: string | undefined

  results.push(
    await probe('typertGateway.invoke session/create', async () => {
      const value = (await invokeRemote(ctx, {
        namespace: 'session',
        method: 'create',
        args: { request: { cwd: workspace } },
        signal: AbortSignal.timeout(30_000),
      })) as { sessionId?: string } | undefined
      sessionId = value?.sessionId
      if (!sessionId) throw new Error(`no sessionId in response: ${preview(value)}`)
      return `sessionId=${sessionId}`
    }),
  )

  results.push(
    await probe('typertGateway.invoke session/list', async () => {
      const value = (await invokeRemote(ctx, {
        namespace: 'session',
        method: 'list',
        args: { _request: {} },
        signal: AbortSignal.timeout(30_000),
      })) as { items?: readonly unknown[] } | undefined
      const items = value?.items ?? []
      return `${items.length} session(s), sample=${preview(items[0])}`
    }),
  )

  results.push(
    await probe('typertGateway.invoke session/modelCatalog', async () => {
      const value = (await invokeRemote(ctx, {
        namespace: 'session',
        method: 'modelCatalog',
        args: {},
        signal: AbortSignal.timeout(30_000),
      })) as { default?: unknown; groups?: readonly { models?: readonly unknown[] }[] } | undefined
      const models = (value?.groups ?? []).flatMap((group) => group.models ?? [])
      return `default=${preview(value?.default)} models=${models.length}`
    }),
  )

  if (sessionId !== undefined) {
    const id = sessionId
    results.push(
      await probe('ctx.sessions.get + sessionProjections.snapshot', async () => {
        const session = ctx.sessions.get(id as never)
        if (!session) throw new Error(`ctx.sessions.get(${id}) returned undefined`)
        const snapshot = ctx.sessionProjections.snapshot(session, [...PROJECTION_KEYS])
        const present = Object.keys(snapshot.values as Record<string, unknown>)
        const missing = PROJECTION_KEYS.filter((key) => !present.includes(key))
        return `asOfSeq=${snapshot.asOfSeq} present=[${present.join(',')}] missing=[${missing.join(',')}]`
      }),
    )

    results.push(
      await probe('ctx.sessionProjections.onChanged', async () => {
        const seen: string[] = []
        const disposer = ctx.sessionProjections.onChanged((change: unknown) => {
          seen.push(preview(change, 80))
        })
        disposer()
        return `subscribed and disposed (${seen.length} event(s) during window)`
      }),
    )

    results.push(
      await probe('typertGateway.stream session/control', async () => {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 15_000)
        try {
          const iterable = await streamRemote(ctx, {
            namespace: 'session',
            method: 'control',
            args: {},
            signal: controller.signal,
          })
          const iterator = iterable[Symbol.asyncIterator]()
          const first = await iterator.next()
          await iterator.return?.()
          return `first frame=${preview(first.value)}`
        } finally {
          clearTimeout(timer)
        }
      }),
    )
  } else {
    results.push({
      name: 'ctx.sessions.get + sessionProjections.snapshot',
      ok: false,
      detail: 'skipped — session/create did not produce an id',
    })
    results.push({
      name: 'typertGateway.stream session/control',
      ok: false,
      detail: 'skipped — session/create did not produce an id',
    })
  }

  const failed = results.filter((result) => !result.ok)
  say('Phase 0.1 spike report')
  for (const result of results) {
    say(`  ${result.ok ? 'PASS' : 'FAIL'}  ${result.name} — ${result.detail}`)
  }
  say(
    `Phase 0.1 spike ${failed.length === 0 ? 'ALL PASS' : 'HAS FAILURES'} ` +
      `(${results.length - failed.length}/${results.length})`,
  )
}
