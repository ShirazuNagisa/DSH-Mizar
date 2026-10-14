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
.mizar-panel h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
}
.mizar-panel p {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  opacity: 0.75;
}
.mizar-card {
  border: 1px solid var(--dsw-color-border, rgba(0, 0, 0, 0.12));
  border-radius: 10px;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.mizar-row {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 13px;
}
.mizar-label { opacity: 0.6; }
.mizar-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}
.mizar-badge {
  align-self: flex-start;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 11px;
  font-weight: 600;
  background: var(--dsw-color-fill, rgba(0, 0, 0, 0.06));
}
`
