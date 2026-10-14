/**
 * The Mizar panel.
 *
 * Phase 0.3 renders a placeholder that proves the three things the client half
 * needs before any real work is worth doing: the factory-CJS envelope loads,
 * React renders inside a shell slot, and a component can sit in the
 * root-scoped `main` keyed slot reached from `sidebar.panellist`.
 *
 * Phase 3 replaces the body with the pairing QR, the bound address, the device
 * roster and revocation.
 *
 * @module dsh-mizar/client/panel
 */
import type { ReactElement } from 'react'

/** The reserved key addressing this panel in the root-scoped `main` slot. */
export const PANEL_ID = 'mizar'

/** The sidebar entry icon for the Mizar panel. */
export function MizarPanelIcon(): ReactElement {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        d="M8 1.2 14 4.6v6.8L8 14.8 2 11.4V4.6L8 1.2Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="2.1" fill="currentColor" />
    </svg>
  )
}

/** The Mizar panel body. */
export function MizarPanel(): ReactElement {
  return (
    <div className="mizar-panel">
      <h1>DSH-Mizar</h1>
      <p>
        Remote monitoring and guidance for DSH agents. This panel will show the pairing QR code,
        the bound address, and the paired-device roster.
      </p>
      <div className="mizar-card">
        <span className="mizar-badge">Phase 0.3</span>
        <div className="mizar-row">
          <span className="mizar-label">Client bundle</span>
          <span className="mizar-mono">factory-CJS envelope loaded</span>
        </div>
        <div className="mizar-row">
          <span className="mizar-label">Slot</span>
          <span className="mizar-mono">main / {PANEL_ID}</span>
        </div>
      </div>
    </div>
  )
}
