/**
 * dsh-mizar — browser half.
 *
 * This module is the *body* of the `window.__ModuleLoader__.load({ id, factory })`
 * envelope that `client/build.mjs` wraps around the esbuild output. The envelope
 * runs this module body when the bundle is materialized, not when the script is
 * evaluated, so every import and side effect here is deferred to the right
 * moment.
 *
 * The client half is an ordinary Cordis plugin: it exports `apply` and `inject`,
 * and the shell's browser Loader mounts it. `inject` here names Cordis
 * *services* on the client side — not to be confused with `dsh.client.inject` in
 * package.json, which names *package rows* this bundle must load after.
 *
 * @module dsh-mizar/client
 */
import type { Context } from './dsh-client.js'
import { MizarPanel, MizarPanelIcon, PANEL_ID } from './panel.js'
import { PANEL_CSS } from './styles.js'

/**
 * Client-side Cordis services this plugin needs.
 *
 * `slots` is the whole surface for now; Phase 3 adds `locale` for the bilingual
 * labels and `remote`/`connection` once the panel reads host state.
 */
export const inject = ['slots']

/**
 * Attach the panel stylesheet.
 *
 * Runs at materialization because it sits in the bundle body rather than inside
 * `apply`. The loader owns styles declared with `data-plugin-css`, so a hot
 * reload replaces this element instead of stacking a second copy.
 */
function installStyles(): void {
  if (typeof document === 'undefined') return
  const existing = document.querySelector(`style[data-plugin-css="${PANEL_ID}"]`)
  if (existing !== null) return
  const style = document.createElement('style')
  style.setAttribute('data-plugin-css', PANEL_ID)
  style.textContent = PANEL_CSS
  document.head.append(style)
}

installStyles()

/**
 * Mount the Mizar panel into the shell.
 *
 * Two registrations are required and they are independent: `sidebar.panellist`
 * contributes the sidebar entry, and `main` contributes the panel the entry
 * selects. Both slots are declared by `dsh-client-ui-layout`, which is why
 * `dsh.client.inject` lists it.
 *
 * @param ctx - the client context.
 */
export function apply(ctx: Context): void {
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 10,
        label: () => 'DSH-Mizar',
      },
      MizarPanelIcon,
    ),
  )

  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
      },
      MizarPanel,
    ),
  )
}
