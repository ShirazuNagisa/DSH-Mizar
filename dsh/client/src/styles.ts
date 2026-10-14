/**
 * Mizar panel styles.
 *
 * Deliberately a template string rather than a `.css` file: the client bundle's
 * only accepted artifact form is a single factory-CJS module, so a second
 * emitted file would need its own envelope and a second loader entry. Inlining
 * keeps one artifact and one `<style data-plugin-css>` seat, which the loader
 * removes when the owning fiber is disposed.
 *
 * Only `--dsw-*` design tokens are referenced, so the panel follows the shell's
 * light/dark theme without carrying its own palette.
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
  color: var(--dsw-color-text, #1c1c1e);
}
.mizar-panel h1 { margin: 0; font-size: 18px; font-weight: 600; }
.mizar-panel h2 { margin: 0; font-size: 13px; font-weight: 600; opacity: 0.6; text-transform: uppercase; letter-spacing: 0.04em; }
.mizar-panel p { margin: 0; font-size: 13px; line-height: 1.5; opacity: 0.75; }
.mizar-card {
  border: 1px solid var(--dsw-color-border, rgba(0, 0, 0, 0.12));
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
  background: var(--dsw-color-fill, rgba(0, 0, 0, 0.06));
}
.mizar-badge.warn { background: rgba(255, 170, 0, 0.18); }
.mizar-warn {
  border-left: 3px solid rgba(255, 170, 0, 0.8);
  padding: 8px 12px;
  border-radius: 4px;
  background: rgba(255, 170, 0, 0.08);
  font-size: 13px;
  line-height: 1.5;
}
.mizar-qr {
  display: flex;
  gap: 20px;
  align-items: flex-start;
  flex-wrap: wrap;
}
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
  border: 1px solid var(--dsw-color-border, rgba(0, 0, 0, 0.15));
  background: var(--dsw-color-fill, rgba(0, 0, 0, 0.04));
  color: inherit;
  padding: 5px 12px;
  cursor: pointer;
}
.mizar-panel button:hover { background: var(--dsw-color-fill-hover, rgba(0, 0, 0, 0.08)); }
.mizar-panel button:disabled { opacity: 0.5; cursor: default; }
.mizar-panel button.danger { color: #c0392b; }
.mizar-device {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-top: 1px solid var(--dsw-color-border, rgba(0, 0, 0, 0.08));
  font-size: 13px;
}
.mizar-device:first-of-type { border-top: none; }
.mizar-device .meta { opacity: 0.6; font-size: 12px; }
.mizar-device.revoked { opacity: 0.45; }
.mizar-empty { opacity: 0.55; font-size: 13px; }
.mizar-error { color: #c0392b; font-size: 13px; }
`
