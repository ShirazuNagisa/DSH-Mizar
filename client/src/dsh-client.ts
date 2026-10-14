/**
 * The one place the browser half pulls in — and fills in — the Cordis
 * `Context` types it codes against.
 *
 * Mirrors `src/dsh.ts` on the host side: type-only, fully erased. The client
 * half must never import a DSH package at runtime, because those modules are
 * either supplied by the shell's baseline table or have to be declared in
 * `dsh.client.external`, and neither applies to a plain type.
 *
 * Unlike the host half, this file also *adds* one declaration. Every shipped
 * client plugin is compiled JavaScript, so the packages publish their slot
 * engine (`SlotCore`, which is a plain class) but never the `declare module`
 * block that puts the shell-wired `slots` service on `Context` — that wiring
 * lives in `dsh-client-web`, which is not a published package. Declaring the
 * two methods Mizar actually calls is therefore the honest minimum; it is
 * deliberately narrow rather than a guess at the full service surface.
 *
 * @module dsh-mizar/client/dsh-client
 */
import type { ReactElement } from 'react'
import type {} from '@deepseek-ai/dsh-client-ui-slots'

export type { Context } from '@deepseek-ai/cordis'

/**
 * A component a slot registration can render.
 *
 * `P` defaults to `never` because the shell passes props this package does not
 * model yet; Phase 3 widens it once the panel consumes slot props.
 */
export type SlotComponent<P = never> = (props: P) => ReactElement | null

/** The shell-wired slot service, narrowed to the operations Mizar uses. */
export interface SlotsService {
  /**
   * Contribute to a declared slot for the calling fiber's lifetime.
   * @param owner - the slot name being contributed to.
   * @param contribute - produces this contribution, run when the owner is live.
   */
  inject(owner: string, contribute: () => unknown): void
  /**
   * Register one entry into a declared slot.
   *
   * Options are `Record<string, unknown>` on purpose: the option shape (`kind`,
   * `order`, `key`, `children`, `store`, …) is validated by the slot engine at
   * runtime, and the engine throws a precise message for an undeclared slot or
   * a duplicated cell. Modelling it here would duplicate that contract.
   *
   * @param options - slot name plus entry identity and display metadata.
   * @param component - the component rendered for this entry.
   * @returns the registration handle.
   */
  register(options: Readonly<Record<string, unknown>>, component: SlotComponent): unknown
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The shell's slot registry. */
    slots: SlotsService
  }
}
