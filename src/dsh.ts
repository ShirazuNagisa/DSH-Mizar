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
 * 0.9.0 needs four of these. Everything the 0.8.x plugin imported for its
 * listener, device store, relay, push and panel is gone — those services are not
 * reached from this process any more.
 *
 * @module dsh-mizar/dsh
 */
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-typert-registry'
// Declaration-merges the two waterfall events this plugin answers. Without these
// the `ctx.on('approval/request', …)` calls are not typed at all, which is how a
// rename upstream becomes a compile error instead of a silently dead channel.
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'

export type { Context } from '@deepseek-ai/cordis'
export type { Session, SessionEvent, SessionEventType, SessionId } from '@deepseek-ai/dsh-session'
export type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection'
