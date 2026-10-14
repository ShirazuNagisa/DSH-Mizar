/**
 * Tailscale discovery, activation, and login-item setup.
 *
 * The plugin never *needs* Tailscale — `bind.mode` has three other settings that
 * involve no third party at all. But when `tailscale` is the chosen mode, "no
 * tailnet address" is several different conditions needing different actions,
 * and picking the wrong action is the difference between a silent recovery and a
 * window appearing on someone's screen.
 *
 * Three distinctions carry the module:
 *
 *   1. **The daemon is up but the tunnel is down** (Stopped, NeedsLogin)
 *      → `tailscale up` is a pure daemon call with *no user interface at all*.
 *   2. **The daemon is not answering** (the app is not running)
 *      → nothing works through the CLI; the app has to be launched, and
 *        `open -g` is what keeps that from stealing focus.
 *   3. **Using 1 when 2 is true is worse than doing nothing**: `tailscale up`
 *      against a daemon that is not there does not fail fast — it hangs.
 *
 * The module also manages **Launch at Login**, which is the mechanism that makes
 * later starts genuinely invisible rather than merely quiet: macOS starts a
 * menu-bar-only app with no window, no dock icon and no focus change. Turning
 * that on once is worth more than any amount of clever launching.
 *
 * Both the filesystem probe and the process runner are injected, so every branch
 * is testable without Tailscale installed.
 *
 * @module dsh-mizar/net/tailscale
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/** What the local Tailscale installation is doing. */
export type TailscaleState =
  /** No CLI found anywhere. */
  | { readonly kind: 'absent' }
  /** Reachable and connected, with at least one IPv4 address. */
  | { readonly kind: 'running'; readonly cli: string; readonly ipv4: readonly string[] }
  /** Daemon reachable, tunnel down. `tailscale up` fixes this silently. */
  | { readonly kind: 'disconnected'; readonly cli: string; readonly backend: string }
  /**
   * Reachable, but this node has never authenticated — or its key expired.
   *
   * Kept apart from `disconnected` because it is the one condition nothing
   * silent can fix. Measured behaviour: `tailscale up` against a NeedsLogin node
   * does not return — it waits for a browser sign-in that is never coming, so
   * running it merely stalls the host's startup and then reports a timeout that
   * explains nothing.
   */
  | { readonly kind: 'needs-login'; readonly cli: string }
  /** Daemon not answering: the app is not running. Needs a launch. */
  | { readonly kind: 'daemon-down'; readonly cli: string; readonly detail: string }
  /** The state could not be established. */
  | { readonly kind: 'unknown'; readonly cli: string; readonly detail: string }

/**
 * What should be done about a state.
 *
 * The CLI path travels with the action rather than being read back off the
 * state, so a caller that switches on `action` gets a narrowed `cli` and cannot
 * accidentally pair the ramp-up with the wrong state.
 */
export type StartupAction =
  | { readonly action: 'none'; readonly reason: string }
  | { readonly action: 'install' }
  /** Run `tailscale up`. No user interface. */
  | { readonly action: 'cli-up'; readonly cli: string }
  /** Launch the app in the background. */
  | { readonly action: 'launch-app'; readonly cli: string }
  /** Nothing automatic helps; the operator has to sign in. */
  | { readonly action: 'sign-in' }

/** Where the CLI lives on each platform, in probe order. */
export function tailscaleCliCandidates(
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  if (platform === 'win32') {
    return [
      'C:\\Program Files\\Tailscale\\tailscale.exe',
      'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
    ]
  }
  if (platform === 'darwin') {
    // On macOS there is only one binary: the app doubles as its own CLI, and
    // `/usr/local/bin/tailscale` is a two-line shim that execs it. There is no
    // separate headless client, because Tailscale does not support running as a
    // standalone system daemon on macOS.
    return [
      '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
      '/opt/homebrew/bin/tailscale',
      '/usr/local/bin/tailscale',
    ]
  }
  return ['/usr/bin/tailscale', '/usr/local/bin/tailscale']
}

/** Finds an executable path, or reports that it is not there. */
export type ExistsProbe = (path: string) => boolean

/** Runs a command and resolves with its stdout. */
export type CommandRunner = (command: string, args: readonly string[]) => Promise<string>

/**
 * The real probe.
 *
 * Bare command names are deliberately *not* treated as present: `existsSync`
 * cannot resolve a `PATH` lookup, and claiming a program exists because its name
 * looks plausible is how you report "installed but not connected" on a machine
 * that has never had it.
 */
export const defaultExists: ExistsProbe = (path) =>
  path.includes('/') || path.includes('\\') ? existsSync(path) : false

/**
 * The real runner: bounded, and it keeps the diagnostic text.
 *
 * `execFile`'s error message is only `Command failed: <command>`; the sentence
 * that says *why* is on stderr, and a timeout is a flag rather than a message.
 * Both are folded into the error here, because without them every daemon-down
 * case degrades to "state could not be read", which is far worse advice.
 *
 * Measured behaviour worth knowing: with the macOS app installed but not
 * running, `tailscale status --json` does not fail fast — it **hangs**, so the
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
 * Phrases that mean the daemon is not answering, as opposed to a backend that is
 * merely stopped.
 *
 * Written against real output: the standalone macOS client says "failed to
 * connect to local tailscaled; it does not seem to be running", and a pattern
 * looking for "not running" misses it — leaving the operator with "state could
 * not be read" instead of "not connected".
 */
const DAEMON_DOWN =
  /failed to connect to local tailscaled|does not seem to be running|not be running|not running|connection refused|ENOENT|no such file|timed out|ETIMEDOUT/i

/**
 * Locate the Tailscale CLI.
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
 * `status --json` answers in every state once the daemon is reachable, so it is
 * the only probe needed. A failure to run it splits into "daemon not answering"
 * and "something else", and the two are kept apart on purpose: conflating them
 * makes the plugin run `tailscale up` against a daemon that is not there, which
 * hangs rather than fails.
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
    const detail = error instanceof Error ? error.message : String(error)
    if (DAEMON_DOWN.test(detail)) return { kind: 'daemon-down', cli, detail }
    return { kind: 'unknown', cli, detail }
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
    const ipv4 = raw.filter(
      (value): value is string => typeof value === 'string' && !value.includes(':'),
    )

    const backend = typeof parsed.BackendState === 'string' ? parsed.BackendState : ''
    if (backend === 'Running' && ipv4.length > 0) return { kind: 'running', cli, ipv4 }
    if (backend === 'NeedsLogin') return { kind: 'needs-login', cli }
    if (backend === 'Stopped') return { kind: 'disconnected', cli, backend }
    return { kind: 'unknown', cli, detail: `BackendState is ${backend || 'missing'}` }
  } catch {
    return { kind: 'unknown', cli, detail: 'status output was not JSON' }
  }
}

/**
 * Decide what to do about a state.
 *
 * Pure, so the decision is testable independently of running anything. The
 * mapping is the point of the module:
 *
 *   - `disconnected` → `tailscale up`, which touches no user interface.
 *   - `daemon-down`  → launch the app, in the background.
 *   - `running` / `unknown` → do nothing. Starting something already running
 *     cannot help, and acting on an unreadable state is guessing.
 *
 * @param state - the observed state.
 * @returns the action to take.
 */
export function planStartup(state: TailscaleState): StartupAction {
  switch (state.kind) {
    case 'absent':
      return { action: 'install' }
    case 'disconnected':
      return { action: 'cli-up', cli: state.cli }
    case 'daemon-down':
      return { action: 'launch-app', cli: state.cli }
    case 'needs-login':
      return { action: 'sign-in' }
    case 'running':
      return { action: 'none', reason: 'already connected' }
    case 'unknown':
      return { action: 'none', reason: state.detail }
  }
}

/**
 * Run `tailscale up`.
 *
 * A pure daemon call: no window, no menu bar, no focus change. This is the
 * correct action whenever the daemon is reachable — and the reason the module
 * separates `disconnected` from `daemon-down`.
 *
 * @param cli - the CLI path.
 * @param run - the process runner.
 * @returns whether it succeeded.
 */
export async function runTailscaleUp(
  cli: string,
  run: CommandRunner = defaultRunner,
): Promise<{ ok: boolean; detail: string }> {
  try {
    await run(cli, ['up'])
    return { ok: true, detail: 'tailscale up succeeded' }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Launch the Tailscale app in the background.
 *
 * `open -g` is the whole point on macOS: without it the app is brought to the
 * foreground, which is a visible interruption every time DSH starts. Tailscale
 * is a menu-bar-only app, so even a foreground launch shows no window — but it
 * still takes focus, and that is exactly what "silent" has to mean.
 *
 * @param cli - the CLI path, used where the CLI is itself the entry point.
 * @param run - the process runner.
 * @param platform - the platform to act on.
 * @returns whether the launch was accepted.
 */
export async function launchTailscaleApp(
  cli: string,
  run: CommandRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<{ ok: boolean; detail: string }> {
  try {
    if (platform === 'darwin') {
      await run('/usr/bin/open', ['-g', '-a', 'Tailscale'])
      return { ok: true, detail: 'launched Tailscale in the background' }
    }
    await run(cli, ['up'])
    return { ok: true, detail: 'tailscale up succeeded' }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Carry out a startup plan.
 *
 * @param state - the observed state.
 * @param run - the process runner.
 * @param platform - the platform to act on.
 * @returns whether something was started, so the caller knows to wait again.
 */
export async function applyStartupPlan(
  state: TailscaleState,
  run: CommandRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<{ started: boolean; detail: string }> {
  const plan = planStartup(state)
  switch (plan.action) {
    case 'none':
      return { started: false, detail: plan.reason }
    case 'install':
      return { started: false, detail: 'Tailscale is not installed' }
    case 'sign-in':
      return {
        started: false,
        detail: 'this node has not been signed in yet — sign in from the Tailscale menu',
      }
    case 'cli-up': {
      const result = await runTailscaleUp(plan.cli, run)
      return { started: result.ok, detail: result.detail }
    }
    case 'launch-app': {
      const result = await launchTailscaleApp(plan.cli, run, platform)
      return { started: result.ok, detail: result.detail }
    }
  }
}

// MARK: - Launch at login

/** The macOS preferences domain the Tailscale app writes. */
export const TAILSCALE_PREF_DOMAIN = 'io.tailscale.ipn.macsys'

/** The macOS preference key behind "Launch Tailscale at Login". */
export const TAILSCALE_START_ON_LOGIN_KEY = 'TailscaleStartOnLogin'

/**
 * Read whether Tailscale is set to start at login.
 *
 * This is the setting that makes later starts genuinely invisible, so it is
 * worth knowing and worth saying out loud. macOS-only: no other platform has the
 * equivalent, and Windows keeps Tailscale in the user session anyway.
 *
 * @param run - the process runner.
 * @param platform - the platform to read on.
 * @returns whether it is enabled, or `null` when it cannot be determined.
 */
export async function readStartOnLogin(
  run: CommandRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<boolean | null> {
  if (platform !== 'darwin') return null
  try {
    const output = await run('/usr/bin/defaults', [
      'read',
      TAILSCALE_PREF_DOMAIN,
      TAILSCALE_START_ON_LOGIN_KEY,
    ])
    const value = output.trim()
    if (value === '1' || value.toLowerCase() === 'true') return true
    if (value === '0' || value.toLowerCase() === 'false') return false
    return null
  } catch {
    // An unset key or a missing domain both land here. Neither is an error; it
    // just means there is nothing to report.
    return null
  }
}

/**
 * Turn on "Launch Tailscale at Login".
 *
 * This modifies another application's preferences, which is a real side effect
 * and the reason the caller has to opt in. It is worth the trade: it is the
 * difference between a menu-bar icon appearing on some mornings and never having
 * to think about Tailscale again.
 *
 * The app reads the setting when it starts, so it takes effect from the next
 * launch — including the one the plugin is about to cause.
 *
 * @param run - the process runner.
 * @param platform - the platform to act on.
 * @returns whether it was written.
 */
export async function enableStartOnLogin(
  run: CommandRunner = defaultRunner,
  platform: NodeJS.Platform = process.platform,
): Promise<{ ok: boolean; detail: string }> {
  if (platform !== 'darwin') {
    return { ok: false, detail: 'launch-at-login is only managed on macOS' }
  }
  try {
    await run('/usr/bin/defaults', [
      'write',
      TAILSCALE_PREF_DOMAIN,
      TAILSCALE_START_ON_LOGIN_KEY,
      '-bool',
      'true',
    ])
    return { ok: true, detail: 'Tailscale will start at login from now on' }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * A one-line, actionable description of the state.
 * @param state - the observed state.
 * @returns operator-facing text.
 */
export function describeTailscaleState(state: TailscaleState): string {
  switch (state.kind) {
    case 'absent':
      return 'Tailscale is not installed. Install it, sign in, and this listener will pick up its address automatically.'
    case 'disconnected':
      return `Tailscale is running but not connected (${state.backend}).`
    case 'needs-login':
      return 'Tailscale is installed but this Mac has never been signed in. Open Tailscale and sign in — after that it stays connected on its own.'
    case 'daemon-down':
      return 'Tailscale is installed but not running.'
    case 'running':
      return `Tailscale is connected (${state.ipv4.join(', ')}).`
    case 'unknown':
      return `Tailscale's state could not be read: ${state.detail}`
  }
}
