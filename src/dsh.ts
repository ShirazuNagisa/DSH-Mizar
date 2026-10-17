/**
 * The one place the host half pulls in the Cordis `Context` module
 * augmentations it codes against.
 *
 * Every import here is **type-only and fully erased**, which is deliberate:
 * `dsh-mizar` is installed into a profile on its own, so its runtime
 * dependencies are only what the profile's `node_modules` actually contains.
 * The peer ranges in `package.json` are what assert the services exist, and DSH
 * supplies them from the running installation.
 *
 * The one runtime import of the DSH tree anywhere in this plugin is
 * `@deepseek-ai/schemastery` in `config.ts`, which the Cordis plugin `Config`
 * convention requires and which resolves from the installation anchor — proven
 * in Phase 0, where the plugin loaded and applied its config.
 *
 * @module dsh-mizar/dsh
 */
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-typert-registry'
// Declaration-merges `ctx.workspaceRegistry` and its `Workspace` entity, so the
// workspace bridge reads the real service instead of a hand-written guess at its
// shape. Type-only, like the rest: a composition without `dsh-workspace` has no
// service to find, and the bridge says so rather than failing.
import type {} from '@deepseek-ai/dsh-workspace'

// `SessionProjectionMap` is declaration-merged: each owning package contributes
// its own keys, and a key only exists in the type when its package is in the
// program. Importing exactly the owners Mizar reads keeps the map honest — a
// typo in a projection key is a compile error rather than a silent `undefined`.
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-stats'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-user-questions'

export type { Context } from '@deepseek-ai/cordis'
export type { Session, SessionEvent, SessionEventType, SessionId } from '@deepseek-ai/dsh-session'
export type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection'
