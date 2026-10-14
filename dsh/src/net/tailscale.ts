/**
 * Tailscale discovery and, optionally, activation.
 *
 * The plugin never *needs* Tailscale — `bind.mode` has three other settings that
 * involve no third party at all. But when `tailscale` is the chosen mode, "no
 * tailnet address" is not one condition; it is several, and they need different
 * advice:
 *
 *   - not installed            → install it
 *   - installed, not logged in → sign in
 *   - installed and logged in,
 *     but stopped              → start it, and this is the one we can do for you
 *
 * Tailscale is supposed to start at login and reconnect by itself, and normally
 * does. It also has long-standing reports of failing to reconnect after a reboot
 * (tailscale/tailscale#21092) and of "Launch at Login" refusing to enable
 * (#18042), so a host that assumes it is always up will eventually strand
 * someone.
 *
 * Both the filesystem probe and the process runner are injected, so every branch
 * is testable without Tailscale installed.
 *
 * @module dsh-mizar/net/tailscale
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/** What we can tell about the local Tailscale installation. */
export type TailscaleState =
  | { readonly kind: 'absent' }
  | { readonly kind: 'stopped'; readonly cli: string; readonly detail: string }
  | { readonly kind: 'running'; readonly cli: string; readonly ipv4: readonly string[] }
  | { readonly kind: 'unknown'; readonly cli: string; readonly detail: string }

/** Where the CLI lives on each platform, in probe order. */
export function tailscaleCliCandidates(
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  if (platform === 'win32') {
    return [
      'C:\\Program Files\\Tailscale\\tailscale.exe',
      'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
      'tailscale.exe',
    ]
  }
  if (platform === 'darwin') {
    return [
      // The standalone build, which is the one that exposes a usable CLI.
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      // Homebrew and the open-source tailscaled.
      '/opt/homebrew/bin/tailscale',
      '/usr/local/bin/tailscale',
      'tailscale',
    ]
  }
  return ['/usr/bin/tailscale', '/usr/local/bin/tailscale', 'tailscale']
}

/** Finds an executable path, or reports that it is not there. */
export type ExistsProbe = (path: string) => boolean

/** Runs a command and returns its stdout. */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<string>

/**
 * Phrases Tailscale uses when its daemon is not up.
 *
 * Written against the real output, not a guess: the standalone macOS client says
 * "failed to connect to local tailscaled; it does not seem to be running", and a
 * pattern looking for "not running" misses it — leaving the operator with
 * "state could not be read" instead of "not connected", which is a much worse
 * thing to act on.
 */
const DAEMON_DOWN =
  /failed to connect to local tailscaled|does not seem to be running|not be running|not running|is stopped|connection refused|ENOENT|no such file|timed out|ETIMEDOUT/i

/** The real probe. */
export const defaultExists: ExistsProbe = (path) =>
  path.includes('/') || path.includes('\\') ? existsSync(path) : true

/**
 * The real runner: bounded, and it keeps the diagnostic text.
 *
 * `execFile`'s error message is only `Command failed: <command>`, which is
 * useless for classification — the sentence that says *why* is on stderr. A
 * timeout is likewise signalled by a flag rather than a message. Both are folded
 * into the error here, because without them every daemon-down case degrades to
 * "state could not be read", which is far worse advice than "not connected".
 *
 * Measured behaviour worth knowing: with the macOS app installed but not
 * running, `tailscale status --json` does not fail fast — it *hangs*, so the
 * timeout is the only thing that ends it.
 */
export const defaultRunner: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      [...args],
      { timeout: 5000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout)
          return
        }
        const detail = [
          (stderr ?? '').trim(),
          (error as { killed?: boolean }).killed === true ? 'timed out' : '',
          error.message,
        ]
          .filter((part) => part !== '')
          .join(' — ')
        reject(new Error(detail))
      },
    )
  })

/**
 * Locate the Tailscale CLI.
 *
 * @param platform - the platform to probe for.
 * @param exists - the filesystem probe.
 * @returns the path, or `null` when none is found.
 */
export function findTailscaleCli(
  platform: NodeJS.Platform = process.platform,
  exists: ExistsProbe = defaultExists,
): string | null {
  for (const candidate of tailscaleCliCandidates(platform)) {
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * Read what Tailscale is doing.
 *
 * `status --json` answers in every state, including stopped, so this is the only
 * probe needed once the CLI is found. A failure to run it is reported as
 * `unknown` rather than `stopped`: claiming "stopped" for a permission problem
 * would send the operator down the wrong path.
 *
 * @param cli - the CLI path.
 * @param run - the process runner.
 * @returns the observed state.
 */
export async function readTailscaleState(
  cli: string,
  run: CommandRunner = defaultRunner,
): Promise<TailscaleState> {
  let output: string
  try {
    output = await run(cli, ['status', '--json'])
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // `tailscale status` exits non-zero when the daemon is not running, which is
    // a real "stopped" rather than an unknown failure.
    if (DAEMON_DOWN.test(message)) {
      return { kind: 'stopped', cli, detail: message }
    }
    return { kind: 'unknown', cli, detail: message }
  }

  try {
    const parsed = JSON.parse(output) as {
      BackendState?: unknown
      TailscaleIPs?: unknown
      Self?: { TailscaleIPs?: unknown }
    }
    const raw = Array.isArray(parsed.TailscaleIPs)
      ? parsed.TailscaleIPs
      : Array.isArray(parsed.Self?.TailscaleIPs)
        ? parsed.Self.TailscaleIPs
        : []
    const ipv4 = raw.filter((value): value is string => typeof value === 'string' && !value.includes(':'))

    const backend = typeof parsed.BackendState === 'string' ? parsed.BackendState : ''
    if (backend === 'Running' && ipv4.length > 0) return { kind: 'running', cli, ipv4 }
    if (backend === 'NeedsLogin' || backend === 'Stopped') {
      return { kind: 'stopped', cli, detail: `BackendState is ${backend}` }
    }
    return { kind: 'unknown', cli, detail: `BackendState is ${backend || 'missing'}` }
  } catch {
    return { kind: 'unknown', cli, detail: 'status output was not JSON' }
  }
}

/**
 * Bring Tailscale up.
 *
 * Deliberately platform-aware, because the CLI is not the right lever on macOS.
 * With the app installed but not running, `tailscale up` does not start anything
 * — it waits for a daemon that is not there, and hangs. Launching the app is
 * what actually starts the daemon, after which it connects on its own.
 *
 * Only meaningful once the tailnet is already authenticated: a fresh install
 * would show a login window and never complete, which is not something a plugin
 * should do on a user's behalf unasked.
 *
 * @param cli - the CLI path, used on platforms where it is the right lever.
 * @param run - the process runner.
 * @param platform - the platform to act on.
 * @returns whether the action was accepted.
 */
export async function bringTailscaleUp(
  cli: string,
  run: CommandRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<{ ok: boolean; detail: string }> {
  try {
    if (platform === 'darwin') {
      await run('/usr/bin/open', ['-a', 'Tailscale'])
      return { ok: true, detail: 'launched Tailscale; it connects on its own once signed in' }
    }
    await run(cli, ['up'])
    return { ok: true, detail: 'tailscale up succeeded' }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * A one-line, actionable description of the state.
 *
 * The panel shows this verbatim, so it names the next step rather than the
 * symptom.
 *
 * @param state - the observed state.
 * @returns operator-facing text.
 */
export function describeTailscaleState(state: TailscaleState): string {
  switch (state.kind) {
    case 'absent':
      return 'Tailscale is not installed. Install it, sign in, and this listener will pick up its address automatically.'
    case 'stopped':
      return 'Tailscale is installed but not connected. Open Tailscale and sign in, or enable "Start Tailscale at login".'
    case 'running':
      return `Tailscale is connected (${state.ipv4.join(', ')}).`
    case 'unknown':
      return `Tailscale's state could not be read: ${state.detail}`
  }
}
