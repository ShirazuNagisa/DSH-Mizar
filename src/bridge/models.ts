/**
 * Model catalog and reasoning effort.
 *
 * The catalog the app renders comes from `session/modelCatalog`, which is the
 * same call the shipped web UI makes. One trap matters here: the client-facing
 * catalog carries **no context window**. Capacity is only known per session,
 * from the `contextPressure` projection, so the app must take the window from
 * the usage frame rather than from the model row — which is also why
 * `bridge/stats.ts` reports it there.
 *
 * @module dsh-mizar/bridge/models
 */
import type { Context } from '../dsh.js'
import { invokeRemote } from './invoke.js'
import { MethodError } from './method-error.js'

/** One reasoning level a model accepts. */
export interface ReasoningEffortOption {
  readonly id: string
  readonly name: string
  readonly description?: string
}

/** One selectable model. */
export interface ModelOption {
  readonly id: string
  readonly name: string
  readonly description?: string
  /**
   * The reasoning levels this model accepts, in the provider's order.
   *
   * A model with no levels takes no `reasoningEffort`; sending one is a hard
   * error upstream, not something that gets clamped.
   */
  readonly efforts: readonly ReasoningEffortOption[]
  /** The level the provider applies when none is chosen. */
  readonly defaultEffort?: string
}

/** One provider and its models. */
export interface ProviderGroup {
  readonly id: string
  readonly name: string
  readonly models: readonly ModelOption[]
}

/** A provider that could not be listed. */
export interface CatalogFailure {
  readonly id: string
  readonly name: string
  readonly message: string
}

/** The complete catalog the app renders. */
export interface ModelCatalogView {
  /** The route a new session would use. */
  readonly default: { provider: string; model: string; reasoningEffort?: string } | null
  /** Every provider with at least one model. */
  readonly providers: readonly ProviderGroup[]
  /** Providers that failed to enumerate; shown rather than hidden. */
  readonly failures: readonly CatalogFailure[]
}

/** Read a string field, or `undefined`. */
function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Narrow one model row.
 * @param value - the raw catalog entry.
 * @returns the option, or `null` when it carries no id.
 */
function toModel(value: unknown): ModelOption | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const id = str(record, 'id')
  if (id === undefined) return null

  const reasoning = record['reasoning'] as Record<string, unknown> | undefined
  const rawEfforts = Array.isArray(reasoning?.['efforts']) ? (reasoning?.['efforts'] as unknown[]) : []
  const efforts = rawEfforts
    .map((entry): ReasoningEffortOption | null => {
      if (typeof entry !== 'object' || entry === null) return null
      const item = entry as Record<string, unknown>
      const effortId = str(item, 'id')
      if (effortId === undefined) return null
      return {
        id: effortId,
        name: str(item, 'name') ?? effortId,
        ...(str(item, 'description') === undefined ? {} : { description: str(item, 'description') as string }),
      }
    })
    .filter((entry): entry is ReasoningEffortOption => entry !== null)

  const defaultEffort = reasoning === undefined ? undefined : str(reasoning, 'defaultEffort')
  const description = str(record, 'description')

  return {
    id,
    name: str(record, 'name') ?? id,
    ...(description === undefined ? {} : { description }),
    efforts,
    ...(defaultEffort === undefined ? {} : { defaultEffort }),
  }
}

/**
 * Read the model catalog.
 * @param ctx - a context observing `ctx.typertGateway`.
 * @returns the catalog, normalised.
 */
export async function modelCatalog(ctx: Context): Promise<ModelCatalogView> {
  const value = (await invokeRemote(ctx, {
    namespace: 'session',
    method: 'modelCatalog',
    args: {},
    signal: AbortSignal.timeout(30_000),
  })) as
    | {
        default?: unknown
        groups?: readonly unknown[]
        failures?: readonly unknown[]
      }
    | undefined

  const fallback = value?.default
  const defaultSelection =
    typeof fallback === 'object' && fallback !== null
      ? (() => {
          const record = fallback as Record<string, unknown>
          const provider = str(record, 'provider')
          const model = str(record, 'model')
          if (provider === undefined || model === undefined) return null
          const effort = str(record, 'reasoningEffort')
          return { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) }
        })()
      : null

  const providers = (value?.groups ?? [])
    .map((group): ProviderGroup | null => {
      if (typeof group !== 'object' || group === null) return null
      const record = group as Record<string, unknown>
      const id = str(record, 'id')
      if (id === undefined) return null
      const models = (Array.isArray(record['models']) ? (record['models'] as unknown[]) : [])
        .map(toModel)
        .filter((model): model is ModelOption => model !== null)
      return { id, name: str(record, 'name') ?? id, models }
    })
    .filter((group): group is ProviderGroup => group !== null)

  const failures = (value?.failures ?? [])
    .map((entry): CatalogFailure | null => {
      if (typeof entry !== 'object' || entry === null) return null
      const record = entry as Record<string, unknown>
      const id = str(record, 'id')
      if (id === undefined) return null
      return {
        id,
        name: str(record, 'name') ?? id,
        message: str(record, 'message') ?? 'unavailable',
      }
    })
    .filter((entry): entry is CatalogFailure => entry !== null)

  return { default: defaultSelection, providers, failures }
}

/** The outcome of selecting a model for a session. */
export interface SelectModelResult {
  readonly sessionId: string
  readonly selected: { provider: string; model: string; reasoningEffort?: string }
}

/**
 * Select the model and reasoning effort for one session.
 *
 * The host validates an explicit effort against the exact model before any
 * provider I/O and rejects a bad one rather than clamping it, so the app should
 * only offer efforts the catalog listed for that model.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param options - target session and the requested route.
 * @returns what the host recorded as selected.
 */
export async function selectModel(
  ctx: Context,
  options: { sessionId: string; provider: string; model: string; reasoningEffort?: string },
): Promise<SelectModelResult> {
  const value = (await invokeRemote(ctx, {
    namespace: 'session',
    method: 'selectModel',
    args: {
      request: {
        sessionId: options.sessionId,
        provider: options.provider,
        model: options.model,
        ...(options.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: options.reasoningEffort }),
      },
    },
    signal: AbortSignal.timeout(30_000),
  })) as { selected?: unknown } | undefined

  const selected = value?.selected
  if (typeof selected !== 'object' || selected === null) {
    throw new MethodError('REMOTE_ERROR', 'session.selectModel returned no selection')
  }
  const record = selected as Record<string, unknown>
  const provider = str(record, 'provider')
  const model = str(record, 'model')
  if (provider === undefined || model === undefined) {
    throw new MethodError('REMOTE_ERROR', 'session.selectModel returned an unusable selection')
  }
  const effort = str(record, 'reasoningEffort')

  return {
    sessionId: options.sessionId,
    selected: { provider, model, ...(effort === undefined ? {} : { reasoningEffort: effort }) },
  }
}
