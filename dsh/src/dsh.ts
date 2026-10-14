/**
 * The one place the host half pulls in the Cordis `Context` module
 * augmentations it codes against.
 *
 * Every import here is **type-only and fully erased**. That is load-bearing:
 * `dsh-mizar` is installed into a profile on its own, so a *runtime* import of
 * `@deepseek-ai/dsh-session` would fail to resolve from the profile's
 * `node_modules`. DSH's own packages supply these services from the running
 * installation, and the peer ranges in `package.json` are what assert they are
 * present.
 *
 * @module dsh-mizar/dsh
 */
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-typert-registry'

// `SessionProjectionMap` is declaration-merged: each owning package contributes
// its own keys, and a key only exists in the type when its package is in the
// program. Importing exactly the owners Mizar reads keeps the map honest — a
// typo in a projection key is a compile error rather than a silent `undefined`.
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-session-stats'
import type {} from '@deepseek-ai/dsh-token-meter'
import type {} from '@deepseek-ai/dsh-user-questions'

export type { Context } from '@deepseek-ai/cordis'
export type { Session, SessionEvent, SessionEventType, SessionId } from '@deepseek-ai/dsh-session'
export type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection'
