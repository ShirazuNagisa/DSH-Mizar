/**
 * Mizar panel styles.
 *
 * Deliberately a template string rather than a `.css` file: the client bundle's
 * only accepted artifact form is a single factory-CJS module, so a second
 * emitted file would need its own envelope and a second loader entry. Inlining
 * keeps one artifact and one `<style data-plugin-css>` seat, which the loader
 * removes when the owning fiber is disposed.
 *
 * **Every neutral is derived from `currentColor`.** The first version of this
 * file used the shell's `--dsw-*` tokens with light-theme fallbacks, which is a
 * bug in dark mode rather than a graceful degradation: an undefined
 * `var(--dsw-color-text, #1c1c1e)` does not fall back to inheriting, it *sets*
 * near-black text, overriding whatever the shell had already chosen. The panel
 * rendered black-on-black.
 *
 * `color-mix(in srgb, currentColor N%, transparent)` produces a tint of whatever
 * colour the shell is using, so the panel is legible in either theme without
 * knowing a single token name. The tokens are still consulted first, so a shell
 * that does define them gets its own palette; the derived value is what happens
 * when it does not.
 *
 * The two absolute colours left are deliberate: a QR code needs a white quiet
 * zone and black modules to scan, whatever the surrounding theme is.
 *
 * @module dsh-mizar/client/styles
 */
export const PANEL_CSS = `
.mizar-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px;
  height: 100%;
  box-sizing: border-box;
  overflow-y: auto;
  color: inherit;
}
.mizar-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.mizar-panel h1 { margin: 0; font-size: 18px; font-weight: 600; }
/* The language button is a quiet control beside the title, not a call to
   action: it is set once and then ignored. */
.mizar-panel .mizar-lang { flex: none; font-size: 12px; padding: 4px 10px; border-radius: 999px; }
.mizar-panel h2 { margin: 0; font-size: 13px; font-weight: 600; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.04em; }
.mizar-panel p { margin: 0; font-size: 13px; line-height: 1.5; opacity: 0.75; }
.mizar-card {
  border: 1px solid var(--dsw-color-border, color-mix(in srgb, currentColor 16%, transparent));
  border-radius: 10px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.mizar-row { display: flex; justify-content: space-between; gap: 16px; font-size: 13px; align-items: baseline; }
.mizar-label { opacity: 0.6; }
.mizar-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.mizar-badge {
  align-self: flex-start;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11px;
  font-weight: 600;
  background: var(--dsw-color-fill, color-mix(in srgb, currentColor 10%, transparent));
}
.mizar-badge.warn {
  background: var(--dsw-color-warn-fill, color-mix(in srgb, #e0910a 20%, transparent));
}
.mizar-warn {
  border-left: 3px solid color-mix(in srgb, #e0910a 85%, transparent);
  padding: 8px 12px;
  border-radius: 4px;
  background: color-mix(in srgb, #e0910a 12%, transparent);
  font-size: 13px;
  line-height: 1.5;
}
.mizar-qr {
  display: flex;
  gap: 20px;
  align-items: flex-start;
  flex-wrap: wrap;
}
/* Absolute on purpose: a QR code is not legible against a tinted panel. */
.mizar-qr svg { width: 180px; height: 180px; display: block; border-radius: 8px; background: #fff; padding: 8px; }
.mizar-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 26px;
  font-weight: 600;
  letter-spacing: 0.08em;
}
.mizar-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.mizar-panel button {
  font: inherit;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--dsw-color-border, color-mix(in srgb, currentColor 18%, transparent));
  background: var(--dsw-color-fill, color-mix(in srgb, currentColor 7%, transparent));
  color: inherit;
  padding: 5px 12px;
  cursor: pointer;
}
.mizar-panel button:hover { background: var(--dsw-color-fill-hover, color-mix(in srgb, currentColor 13%, transparent)); }
.mizar-panel button:disabled { opacity: 0.5; cursor: default; }
/* Mid-tone reds: legible on a white panel and on a near-black one. The dark
   brick red this replaced was invisible against a dark panel. */
.mizar-panel button.danger { color: #e5534b; }
.mizar-device {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid color-mix(in srgb, currentColor 10%, transparent);
  font-size: 13px;
}
.mizar-device:first-of-type { border-top: none; }
.mizar-device .meta { opacity: 0.6; font-size: 12px; }
.mizar-device.revoked { opacity: 0.45; }
.mizar-empty { opacity: 0.55; font-size: 13px; }
.mizar-error { color: #e5534b; font-size: 13px; }
`
