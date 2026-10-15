#!/usr/bin/env node
/**
 * Render the Mizar panel in both themes, without launching DSH.
 *
 * The panel is styled from `currentColor` so it follows whatever theme the shell
 * is in, and the first version of that stylesheet got it wrong in a way no unit
 * test could have shown: it looked fine on paper and rendered black-on-black in
 * the shell's dark theme. Having a page that puts both themes side by side turns
 * "the CSS looks theme-agnostic" into something you can look at.
 *
 * Usage: node scripts/panel-preview.mjs [port]
 */
import { build } from 'esbuild'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')

// Bundled on the fly so the preview cannot drift from the stylesheet it shows.
const bundled = await build({
  entryPoints: [join(root, 'client', 'src', 'styles.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'neutral',
})
const { PANEL_CSS } = await import(
  `data:text/javascript,${encodeURIComponent(bundled.outputFiles[0].text)}`
)

/** One panel body, in the markup shape `panel.tsx` produces. */
const body = `
<div class="mizar-panel">
  <div>
    <h1>DSH-Mizar</h1>
    <p>监听 100.64.0.1:19390</p>
  </div>
  <div class="mizar-card">
    <h2>Status</h2>
    <div class="mizar-row"><span class="mizar-label">Listening on</span><span class="mizar-mono">100.64.0.1:19390</span></div>
    <div class="mizar-row"><span class="mizar-label">Mode</span><span>loopback</span></div>
    <div class="mizar-row"><span class="mizar-label">Devices</span><span>2</span></div>
    <span class="mizar-badge">paired</span>
  </div>
  <div class="mizar-warn">No LAN address is bound and no relay is connected, so the phone cannot reach this Mac.</div>
  <div class="mizar-card">
    <h2>Pair a device</h2>
    <div class="mizar-qr">
      <svg viewBox="0 0 25 25" shape-rendering="crispEdges">
        <rect width="25" height="25" fill="#fff"/>
        <path d="M0 0h7v7H0zM18 0h7v7h-7zM0 18h7v7H0z" fill="#000"/>
        <path d="M9 0h1v1H9zM11 0h1v1h-1zM9 2h2v1H9zM13 1h1v2h-1zM9 4h1v1H9zM12 4h2v1h-2z" fill="#000"/>
      </svg>
      <div>
        <p class="mizar-label">Scan this, or type the code</p>
        <div class="mizar-code">K7QP-3M2X</div>
        <div class="mizar-actions" style="margin-top:12px">
          <button>New code</button>
          <button class="danger">Revoke all</button>
        </div>
      </div>
    </div>
  </div>
  <div class="mizar-card">
    <h2>Devices</h2>
    <div class="mizar-device"><span>Shirazu's iPhone</span><span class="meta">paired 2 hours ago</span></div>
    <div class="mizar-device revoked"><span>Old iPad</span><span class="meta">revoked</span></div>
  </div>
  <p class="mizar-empty">No devices have been paired yet.</p>
  <p class="mizar-error">Could not reach the host: the socket closed.</p>
</div>`

const page = `<!doctype html>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mizar panel — both themes</title>
<style>
  body { margin: 0; display: flex; font: 14px -apple-system, system-ui, sans-serif; }
  .half { flex: 1; min-height: 100vh; }
  .light { color-scheme: light; background: #ffffff; color: #1c1c1e; }
  .dark  { color-scheme: dark;  background: #1b1b1d; color: #f2f2f7; }
  .tag { position: sticky; top: 0; padding: 6px 12px; font-size: 11px; font-weight: 700;
         letter-spacing: .08em; text-transform: uppercase; opacity: .5; }
  ${PANEL_CSS}
</style>
<div class="half light"><div class="tag">light</div>${body}</div>
<div class="half dark"><div class="tag">dark</div>${body}</div>`

const port = Number(process.argv[2] ?? 19400)
createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  response.end(page)
}).listen(port, '127.0.0.1', () => {
  console.log(`panel preview on http://127.0.0.1:${port}`)
})
