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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactElement,
} from 'react'
import qrcode from 'qrcode-generator'
import { getLocale, subscribe, t, toggleLocale } from './i18n.js'

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
    <svg viewBox={`0 0 ${shape.count} ${shape.count}`} shapeRendering="crispEdges" role="img" aria-label={t('Pairing QR code')}>
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
      if (!response.ok) throw new Error(t('status request failed: {status}', { status: response.status }))
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

/**
 * The language the panel is rendering in, and re-render when it changes.
 *
 * `useSyncExternalStore` rather than a state variable: the locale lives outside
 * React because the translation function does too, and this is the hook that
 * exists for exactly that shape.
 *
 * @returns the current locale.
 */
function useLocale(): ReturnType<typeof getLocale> {
  return useSyncExternalStore(subscribe, getLocale, getLocale)
}

/**
 * The panel's title row, with the language switch.
 *
 * Shared by every state rather than only the loaded one. The first thing a
 * reader who cannot read the panel needs is the button that changes it, and the
 * loading state is the first thing anyone sees -- so it was the one screen the
 * button was missing from.
 *
 * @returns the header.
 */
function PanelHeader(): ReactElement {
  const locale = useLocale()
  const other = locale === 'zh-Hans' ? 'English' : '中文'
  return (
    <div className="mizar-header">
      <h1>DSH-Mizar</h1>
      <button
        type="button"
        className="mizar-lang"
        onClick={toggleLocale}
        // Labelled with the language it switches *to*, which is what the button
        // reads as and what a screen reader should announce.
        aria-label={t('Switch to {language}', { language: t(other) })}
      >
        {t(other)}
      </button>
    </div>
  )
}

/** Format an epoch millisecond value as a coarse relative age. */
function relativeTime(time: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - time) / 1000))
  if (seconds < 60) return t('just now')
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return t('{minutes}m ago', { minutes })
  const hours = Math.round(minutes / 60)
  if (hours < 24) return t('{hours}h ago', { hours })
  return t('{days}d ago', { days: Math.round(hours / 24) })
}

/** Format the remaining lifetime of a pairing code. */
function remaining(expiresAt: number): string {
  const seconds = Math.max(0, Math.round((expiresAt - Date.now()) / 1000))
  if (seconds === 0) return t('expired')
  if (seconds < 60) return t('{seconds}s left', { seconds })
  return t('{minutes}m left', { minutes: Math.round(seconds / 60) })
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
          {device.revoked ? t(' · revoked') : t(' · last seen {when}', { when: relativeTime(device.lastSeenAt) })}
        </div>
      </div>
      {!device.revoked && (
        <button type="button" className="danger" disabled={busy} onClick={() => onRevoke(device.deviceId)}>
          {t('Revoke')}
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
          throw new Error(detail?.error ?? t('request failed: {status}', { status: response.status }))
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
        <PanelHeader />
        {error === null ? <p>{t('Loading…')}</p> : <p className="mizar-error">{t('Cannot reach the Mizar host: {detail}', { detail: error })}</p>}
      </div>
    )
  }

  const live = status.devices.filter((device) => !device.revoked)
  const revoked = status.devices.filter((device) => device.revoked)

  return (
    <div className="mizar-panel">
      <PanelHeader />
      <p>
        {t('Monitor and guide this DSH agent from your phone. Pair a device below, then open the DSH-Mizar app and scan the code.')}
      </p>

      {status.bind.fellBack && (
        <div className="mizar-warn">
          <strong>{t('Not reachable from your phone yet.')}</strong> {status.bind.reason}{' '}
          {t('Install and sign in to a relay, or bind an address the phone can reach, then restart DSH.')}
        </div>
      )}

      <div className="mizar-card">
        <h2>{t('Host')}</h2>
        <div className="mizar-row">
          <span className="mizar-label">{t('Listening on')}</span>
          <span className="mizar-mono">
            {status.listening ? status.authorities.join(', ') : t('not listening')}
          </span>
        </div>
        <div className="mizar-row">
          <span className="mizar-label">{t('Bind mode')}</span>
          <span className="mizar-mono">
            {status.bind.mode}
            {status.bind.fellBack ? ` ${t('(fell back to loopback)')}` : ''}
          </span>
        </div>
        <div className="mizar-row">
          <span className="mizar-label">{t('Connected clients')}</span>
          <span className="mizar-mono">{status.clients}</span>
        </div>
        <div className="mizar-row">
          <span className="mizar-label">{t('Protocol')}</span>
          <span className="mizar-mono">v{status.protocolVersion}</span>
        </div>
      </div>

      <div className="mizar-card">
        <h2>{t('Pair a device')}</h2>
        {status.pairing === null ? (
          <>
            <p className="mizar-empty">{t('No pairing code is outstanding.')}</p>
            <div className="mizar-actions">
              <button type="button" disabled={busy} onClick={() => void act('/api/mizar.pairing')}>
                {t('Generate pairing code')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="mizar-qr">
              <QrCode text={status.pairing.uri} />
              <div>
                <div className="mizar-label">{t('Or enter this code')}</div>
                <div className="mizar-code">{status.pairing.display}</div>
                <p style={{ marginTop: 8 }}>{remaining(status.pairing.expiresAt)}</p>
                <div className="mizar-actions" style={{ marginTop: 12 }}>
                  <button type="button" disabled={busy} onClick={() => void act('/api/mizar.pairing')}>
                    {t('New code')}
                  </button>
                </div>
              </div>
            </div>
            <p className="mizar-empty">{t('A code works once and expires. Generating a new one invalidates this one.')}</p>
          </>
        )}
      </div>

      <div className="mizar-card">
        <h2>{t('Paired devices')}</h2>
        {actionError !== null && <p className="mizar-error">{actionError}</p>}
        {live.length === 0 && revoked.length === 0 && <p className="mizar-empty">{t('None yet.')}</p>}
        {live.map((device) => (
          <DeviceRow key={device.deviceId} device={device} busy={busy} onRevoke={(deviceId) => void act('/api/mizar.revoke', { deviceId })} />
        ))}
        {revoked.length > 0 && (
          <>
            <h2 style={{ marginTop: 8 }}>{t('Revoked')}</h2>
            {revoked.map((device) => (
              <DeviceRow key={device.deviceId} device={device} busy={busy} onRevoke={() => {}} />
            ))}
          </>
        )}
      </div>

      <p className="mizar-empty">
        {t('Revoking a device takes effect immediately and disconnects it. The host identity is {hostId}.', {
          hostId: status.hostId,
        })}
      </p>
    </div>
  )
}
