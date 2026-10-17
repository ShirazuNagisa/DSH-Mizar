/**
 * Permission presets.
 *
 * A permission preset bundles two independent knobs — the sandbox mode and the
 * approval policy — under one name. The app shows the catalog and switches the
 * preset; it never sets a knob directly, because the named presets are what the
 * operator recognises and what the audit log records.
 *
 * Two reserved values matter to the UI:
 *
 *   - `auto` is live-only. It appears in the catalog while the auto-review
 *     integration is mounted and disappears when it is not, so the app must
 *     render the catalog it is given rather than a hardcoded list.
 *   - `custom` is derived-only. It can be the *current* value but is never a
 *     selectable row, so a picker must not offer it as a target.
 *
 * There is no Remote setter for a preset — the switch goes through the
 * `/permission` command — and confirmation arrives as a change to the
 * `permissions` projection rather than as the command's return value.
 *
 * @module dsh-mizar/bridge/permissions
 */
import type { Context } from '../dsh.js'
import { invokeRemote } from './invoke.js'
import { MethodError } from './method-error.js'

/** One selectable preset. */
export interface PermissionOption {
  /** The preset id passed back when switching. */
  readonly value: string
  /** Human-readable name. */
  readonly name: string
  readonly description?: string
}

/** The catalog the app renders. */
export interface PermissionCatalogView {
  /** Presets a session may be switched to. */
  readonly options: readonly PermissionOption[]
  /** Presets offered for future sessions' default. */
  readonly defaults: readonly PermissionOption[]
  /** The preset a new session would use. */
  readonly defaultPreset: string
}

/** Read a string field, or `undefined`. */
function str(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Narrow one preset option.
 * @param value - the raw option.
 * @returns the option, or `null` when it carries no value.
 */
function toOption(value: unknown): PermissionOption | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  const id = str(record, 'value')
  if (id === undefined) return null
  const description = str(record, 'description')
  return {
    value: id,
    name: str(record, 'name') ?? id,
    ...(description === undefined ? {} : { description }),
  }
}

/**
 * Read the permission catalog.
 * @param ctx - a context observing `ctx.typertGateway`.
 * @returns the catalog, normalised.
 */
export async function permissionCatalog(ctx: Context): Promise<PermissionCatalogView> {
  const value = (await invokeRemote(ctx, {
    namespace: 'permissionPresets',
    method: 'catalog',
    args: {},
    signal: AbortSignal.timeout(30_000),
  })) as
    | { options?: readonly unknown[]; defaultOptions?: readonly unknown[]; defaultPreset?: unknown }
    | undefined

  const narrow = (input: readonly unknown[] | undefined): PermissionOption[] =>
    (input ?? []).map(toOption).filter((option): option is PermissionOption => option !== null)

  return {
    options: narrow(value?.options),
    defaults: narrow(value?.defaultOptions),
    defaultPreset: typeof value?.defaultPreset === 'string' ? value.defaultPreset : '',
  }
}

/** The outcome of switching a session's permission preset. */
export interface SetPermissionResult {
  /**
   * The command's own report.
   *
   * The preset switch is confirmed by the `permissions` projection changing, not
   * by this value, so it is informational: a `success` here means the command
   * was accepted, not that the new preset is already in effect.
   */
  readonly commandResult: { kind: 'success' | 'error'; text?: string }
}

/**
 * Switch one session's permission preset.
 *
 * @param ctx - a context observing `ctx.typertGateway`.
 * @param options - target session and preset id.
 * @returns the command's report.
 * @throws MethodError when the command reports a failure.
 */
export async function setPermissionPreset(
  ctx: Context,
  options: { sessionId: string; preset: string },
): Promise<SetPermissionResult> {
  const value = (await invokeRemote(ctx, {
    namespace: 'commands',
    method: 'execute',
    args: {
      // `agentId` is a lookup parameter: the gateway resolves it to the session's
      // agent, which is why a SessionId is what travels on the wire.
      agentId: options.sessionId,
      line: `/permission ${options.preset}`,
      submittedAttachments: [],
    },
    signal: AbortSignal.timeout(30_000),
  })) as { result?: unknown } | undefined

  const result = value?.result
  if (typeof result !== 'object' || result === null) {
    throw new MethodError('REMOTE_ERROR', 'commands.execute returned no result')
  }
  const record = result as Record<string, unknown>
  const kind = record['kind']
  if (kind !== 'success' && kind !== 'error') {
    throw new MethodError('REMOTE_ERROR', 'commands.execute returned an unusable result')
  }
  const text = str(record, 'text')

  if (kind === 'error') {
    throw new MethodError('REMOTE_ERROR', text ?? `permission preset "${options.preset}" was refused`)
  }
  return { commandResult: { kind, ...(text === undefined ? {} : { text }) } }
}
