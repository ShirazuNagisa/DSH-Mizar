/**
 * The Mizar panel.
 *
 * Shows what an operator needs to get a phone connected and to see who already
 * is: the address the listener took, whether it fell back to loopback, the live
 * pairing code as both text and QR, and the device roster with revocation.
 *
 * The panel re-renders the whole status on a poll. The payload is a few hundred
 * bytes and the changes are rare, so a diffing protocol would be more moving
 * parts than it is worth; the poll is paused while the tab is hidden.
 *
 * @module dsh-mizar/client/panel
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import qrcode from 'qrcode-generator'

/** The reserved key addressing this panel in the root-scoped `main` slot. */
export const PANEL_ID = 'mizar'

/** How often the panel refreshes while visible, in milliseconds. */
const POLL_MS = 2000

/** One device row, as the host reports it. */
interface DeviceView {
  deviceId: string
  name: string
  model: string | null
  tokenPrefix: string
  createdAt: number
  lastSeenAt: number
  revoked: boolean
}

/** The status the host reports. */
interface PanelStatus {
  hostId: string
  hostName: string
  protocolVersion: number
  listening: boolean
  authorities: string[]
  bind: { mode: string; fellBack: boolean; reason: string }
  pairing: { display: string; expiresAt: number; uri: string } | null
  devices: DeviceView[]
  clients: number
}

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

/**
 * Render a QR code as a single SVG path.
 *
 * Built from the module matrix rather than the library's own SVG string, so the
 * shell never has to inject markup. One path element keeps the DOM small enough
 * that re-rendering on every poll is free.
 *
 * @param props - the text to encode, or `null` to render nothing.
 * @returns the SVG, or `null`.
 */
function QrCode({ text }: { text: string | null }): ReactElement | null {
  const shape = useMemo(() => {
    if (text === null || text === '') return null
    // Type 0 lets the library pick the smallest version that fits; error
    // correction M tolerates a slightly smudged phone camera.
    const qr = qrcode(0, 'M')
    qr.addData(text)
    qr.make()
    const count = qr.getModuleCount()
    let path = ''
    for (let row = 0; row < count; row += 1) {
      for (let column = 0; column < count; column += 1) {
        if (qr.isDark(row, column)) path += `M${column} ${row}h1v1h-1z`
      }
    }
    return { count, path }
  }, [text])

  if (shape === null) return null
  return (
    <svg viewBox={`0 0 ${shape.count} ${shape.count}`} shapeRendering="crispEdges" role="img" aria-label="Pairing QR code">
      <rect width={shape.count} height={shape.count} fill="#fff" />
      <path d={shape.path} fill="#000" />
    </svg>
  )
}

/**
 * Fetch the panel status on a poll.
 * @returns the current status, any error, and a manual refresh.
 */
function useStatus(): { status: PanelStatus | null; error: string | null; refresh: () => Promise<void> } {
  const [status, setStatus] = useState<PanelStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch('/api/mizar.status', { headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error(`status request failed: ${response.status}`)
      const next = (await response.json()) as PanelStatus
      if (alive.current) {
        setStatus(next)
        setError(null)
      }
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause))
    }
  }, [])

  useEffect(() => {
    alive.current = true
    void refresh()
    // Polling a hidden tab wastes work and, worse, can make a stale code look
    // fresh the moment the tab comes back. Refresh immediately on return.
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh()
    }, POLL_MS)
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive.current = false
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh])

  return { status, error, refresh }
}

/** Format an epoch millisecond value as a coarse relative age. */
function relativeTime(time: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Format the remaining lifetime of a pairing code. */
function remaining(expiresAt: number): string {
  const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
  if (seconds === 0) return 'expired'
  if (seconds < 60) return `${seconds}s left`
  return `${Math.round(seconds / 60)}m left`
}

/** One device row with its revoke action. */
function DeviceRow({
  device,
  onRevoke,
  busy,
}: {
  device: DeviceView
  onRevoke: (deviceId: string) => void
  busy: boolean
}): ReactElement {
  return (
    <div className={`mizar-device${device.revoked ? ' revoked' : ''}`}>
      <div>
        <div>
          {device.name}
          {device.model !== null && device.model !== device.name ? ` · ${device.model}` : ''}
        </div>
        <div className="meta">
          <span className="mizar-mono">{device.tokenPrefix}</span>
          {device.revoked ? ' · revoked' : ` · last seen ${relativeTime(device.lastSeenAt)}`}
        </div>
      </div>
      {!device.revoked && (
        <button type="button" className="danger" disabled={busy} onClick={() => onRevoke(device.deviceId)}>
          Revoke
        </button>
      )}
    </div>
  )
}

/** The Mizar panel body. */
export function MizarPanel(): ReactElement {
  const { status, error, refresh } = useStatus()
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const act = useCallback(
    async (path: string, body?: unknown) => {
      setBusy(true)
      setActionError(null)
      try {
        const response = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if (!response.ok) {
          const detail = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(detail?.error ?? `request failed: ${response.status}`)
        }
        await refresh()
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        setBusy(false)
      }
    },
    [refresh],
  )

  if (status === null) {
    return (
      <div className="mizar-panel">
        <h1>DSH-Mizar</h1>
        {error === null ? <p>Loading…</p> : <p className="mizar-error">Cannot reach the Mizar host: {error}</p>}
      </div>
    )
  }

  const live = status.devices.filter((device) => !device.revoked)
  const revoked = status.devices.filter((device) => device.revoked)

  return (
    <div className="mizar-panel">
      <h1>DSH-Mizar</h1>
      <p>
        Monitor and guide this DSH agent from your phone. Pair a device below, then open the
        DSH-Mizar app and scan the code.
      </p>

      {status.bind.fellBack && (
        <div className="mizar-warn">
          <strong>Not reachable from your phone yet.</strong> {status.bind.reason} Install and sign in to
          Tailscale on this machine, then restart DSH.
        </div>
      )}

      <div className="mizar-card">
        <h2>Host</h2>
        <div className="mizar-row">
          <span className="mizar-label">Listening on</span>
          <span className="mizar-mono">
            {status.listening ? status.authorities.join(', ') : 'not listening'}
          </span>
        </div>
        <div className="mizar-row">
          <span className="mizar-label">Bind mode</span>
          <span className="mizar-mono">
            {status.bind.mode}
            {status.bind.fellBack ? ' (fell back to loopback)' : ''}
          </span>
        </div>
        <div className="mizar-row">
          <span className="mizar-label">Connected clients</span>
          <span className="mizar-mono">{status.clients}</span>
        </div>
        <div className="mizar-row">
          <span className="mizar-label">Protocol</span>
          <span className="mizar-mono">v{status.protocolVersion}</span>
        </div>
      </div>

      <div className="mizar-card">
        <h2>Pair a device</h2>
        {status.pairing === null ? (
          <>
            <p className="mizar-empty">No pairing code is outstanding.</p>
            <div className="mizar-actions">
              <button type="button" disabled={busy} onClick={() => void act('/api/mizar.pairing')}>
                Generate pairing code
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mizar-qr">
              <QrCode text={status.pairing.uri} />
              <div>
                <div className="mizar-label">Or enter this code</div>
                <div className="mizar-code">{status.pairing.display}</div>
                <p style={{ marginTop: 8 }}>{remaining(status.pairing.expiresAt)}</p>
                <div className="mizar-actions" style={{ marginTop: 12 }}>
                  <button type="button" disabled={busy} onClick={() => void act('/api/mizar.pairing')}>
                    New code
                  </button>
                </div>
              </div>
            </div>
            <p className="mizar-empty">
              A code works once and expires. Generating a new one invalidates this one.
            </p>
          </>
        )}
      </div>

      <div className="mizar-card">
        <h2>Paired devices</h2>
        {actionError !== null && <p className="mizar-error">{actionError}</p>}
        {live.length === 0 && revoked.length === 0 && <p className="mizar-empty">None yet.</p>}
        {live.map((device) => (
          <DeviceRow key={device.deviceId} device={device} busy={busy} onRevoke={(deviceId) => void act('/api/mizar.revoke', { deviceId })} />
        ))}
        {revoked.length > 0 && (
          <>
            <h2 style={{ marginTop: 8 }}>Revoked</h2>
            {revoked.map((device) => (
              <DeviceRow key={device.deviceId} device={device} busy={busy} onRevoke={() => {}} />
            ))}
          </>
        )}
      </div>

      <p className="mizar-empty">
        Revoking a device takes effect immediately and disconnects it. The host identity is{' '}
        <span className="mizar-mono">{status.hostId}</span>.
      </p>
    </div>
  )
}
