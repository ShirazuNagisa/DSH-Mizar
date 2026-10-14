/**
 * Tests for Tailscale discovery.
 *
 * Both the filesystem probe and the process runner are injected, so every branch
 * is covered without Tailscale installed and without running a command — which
 * matters, because the interesting branches are the ones this machine cannot
 * reach.
 *
 * @module dsh-mizar/test/tailscale
 */
import { describe, expect, it, vi } from 'vitest'
import {
  applyStartupPlan,
  describeTailscaleState,
  enableStartOnLogin,
  findTailscaleCli,
  launchTailscaleApp,
  planStartup,
  readStartOnLogin,
  readTailscaleState,
  runTailscaleUp,
  tailscaleCliCandidates,
  TAILSCALE_PREF_DOMAIN,
  TAILSCALE_START_ON_LOGIN_KEY,
  type CommandRunner,
} from '../src/net/tailscale.js'

/** A runner that answers with fixed output. */
function runner(output: string): CommandRunner {
  return vi.fn(async () => output)
}

/** A runner that fails. */
function failingRunner(message: string): CommandRunner {
  return vi.fn(async () => {
    throw new Error(message)
  })
}

describe('tailscaleCliCandidates', () => {
  it('prefers the standalone app on macOS, which is the one with a usable CLI', () => {
    expect(tailscaleCliCandidates('darwin')[0]).toBe('/Applications/Tailscale.app/Contents/MacOS/Tailscale')
  })

  it('knows the Windows install location', () => {
    expect(tailscaleCliCandidates('win32')[0]?.toLowerCase()).toContain('tailscale.exe')
  })

  it('offers a PATH fallback on every platform', () => {
    for (const platform of ['darwin', 'win32', 'linux'] as const) {
      expect(tailscaleCliCandidates(platform).length).toBeGreaterThan(1)
    }
  })
})

describe('findTailscaleCli', () => {
  it('returns the first candidate that exists', () => {
    const cli = findTailscaleCli('darwin', (path) => path === '/opt/homebrew/bin/tailscale')
    expect(cli).toBe('/opt/homebrew/bin/tailscale')
  })

  it('reports absence rather than guessing a path', () => {
    expect(findTailscaleCli('darwin', () => false)).toBeNull()
  })
})

describe('readTailscaleState', () => {
  it('reports a connected node with its IPv4 address', async () => {
    const state = await readTailscaleState(
      'tailscale',
      runner(JSON.stringify({ BackendState: 'Running', TailscaleIPs: ['100.64.0.9', 'fd7a:115c:a1e0::9'] })),
    )
    expect(state.kind).toBe('running')
    if (state.kind === 'running') expect(state.ipv4).toEqual(['100.64.0.9'])
  })

  it('reads the address from Self when it is not at the top level', async () => {
    const state = await readTailscaleState(
      'tailscale',
      runner(JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.64.0.9'] } })),
    )
    expect(state.kind).toBe('running')
  })

  it('reports NeedsLogin as its own state, not as a stopped tunnel', async () => {
    // Nothing silent fixes it, and running `tailscale up` here hangs waiting for
    // a browser sign-in that never arrives.
    const state = await readTailscaleState('tailscale', runner(JSON.stringify({ BackendState: 'NeedsLogin' })))
    expect(state.kind).toBe('needs-login')
  })

  it('reports Stopped as a stopped tunnel, which the CLI does fix silently', async () => {
    const state = await readTailscaleState('tailscale', runner(JSON.stringify({ BackendState: 'Stopped' })))
    expect(state.kind).toBe('disconnected')
  })

  it('reports a daemon that is not answering as daemon-down, not disconnected', async () => {
    // The distinction decides the action: `tailscale up` against a daemon that
    // is not there hangs rather than failng, so this case must NOT take the CLI
    // path. The wording is the exact string the standalone macOS client uses.
    const state = await readTailscaleState(
      'tailscale',
      failingRunner('failed to connect to local tailscaled; it does not seem to be running'),
    )
    expect(state.kind).toBe('daemon-down')
  })

  it('recognises the other shapes a dead daemon takes', async () => {
    for (const message of [
      'dial unix /var/run/tailscaled.socket: connect: connection refused',
      'spawn tailscale ENOENT',
      // The shape a timeout produces: the daemon is installed but not answering.
      'Command failed: /Applications/Tailscale.app/Contents/MacOS/Tailscale status --json — timed out',
    ]) {
      const state = await readTailscaleState('tailscale', failingRunner(message))
      expect(state.kind, message).toBe('daemon-down')
    }
  })

  it('reports an unexplained failure as unknown rather than acting on it', async () => {
    // Claiming a dead daemon for a permission problem would send the operator
    // down the wrong path.
    const state = await readTailscaleState('tailscale', failingRunner('EACCES: permission denied'))
    expect(state.kind).toBe('unknown')
  })

  it('reports unparseable output as unknown', async () => {
    const state = await readTailscaleState('tailscale', runner('not json'))
    expect(state.kind).toBe('unknown')
  })

  it('does not mistake a running node with no address for a connected one', async () => {
    const state = await readTailscaleState('tailscale', runner(JSON.stringify({ BackendState: 'Running' })))
    expect(state.kind).toBe('unknown')
  })
})

describe('describeTailscaleState', () => {
  it('names the next step for each state', () => {
    expect(describeTailscaleState({ kind: 'absent' })).toContain('not installed')
    expect(describeTailscaleState({ kind: 'disconnected', cli: 'x', backend: 'Stopped' })).toContain('Stopped')
    expect(describeTailscaleState({ kind: 'daemon-down', cli: 'x', detail: 'd' })).toContain('not running')
    expect(describeTailscaleState({ kind: 'needs-login', cli: 'x' })).toContain('sign in')
    expect(describeTailscaleState({ kind: 'running', cli: 'x', ipv4: ['100.64.0.9'] })).toContain('100.64.0.9')
    expect(describeTailscaleState({ kind: 'unknown', cli: 'x', detail: 'why' })).toContain('why')
  })
})

describe('planStartup', () => {
  it('fixes a stopped tunnel through the CLI, which shows nothing', () => {
    // The daemon is up, so `tailscale up` is a pure daemon call.
    expect(planStartup({ kind: 'disconnected', cli: '/ts', backend: 'Stopped' })).toEqual({
      action: 'cli-up',
      cli: '/ts',
    })
  })

  it('launches the app only when the daemon is not answering', () => {
    expect(planStartup({ kind: 'daemon-down', cli: '/ts', detail: 'x' })).toEqual({
      action: 'launch-app',
      cli: '/ts',
    })
  })

  it('does nothing when already connected', () => {
    expect(planStartup({ kind: 'running', cli: '/ts', ipv4: ['100.64.0.9'] }).action).toBe('none')
  })

  it('asks the operator to sign in rather than running a command that would hang', () => {
    expect(planStartup({ kind: 'needs-login', cli: '/ts' })).toEqual({ action: 'sign-in' })
  })

  it('does nothing on an unreadable state rather than guessing', () => {
    expect(planStartup({ kind: 'unknown', cli: '/ts', detail: 'why' }).action).toBe('none')
  })

  it('asks for an install when there is nothing to run', () => {
    expect(planStartup({ kind: 'absent' }).action).toBe('install')
  })
})

describe('runTailscaleUp', () => {
  it('runs the CLI and reports success', async () => {
    const run = runner('')
    await expect(runTailscaleUp('/ts', run)).resolves.toMatchObject({ ok: true })
    expect(run).toHaveBeenCalledWith('/ts', ['up'])
  })

  it('reports the failure detail rather than throwing', async () => {
    // A plugin must not take down its own startup because an optional external
    // command failed.
    await expect(runTailscaleUp('/ts', failingRunner('needs login'))).resolves.toMatchObject({
      ok: false,
      detail: 'needs login',
    })
  })
})

describe('launchTailscaleApp', () => {
  it('launches in the background on macOS', async () => {
    // `-g` is the point: without it the app takes focus, which is a visible
    // interruption on every DSH start.
    const run = runner('')
    await expect(launchTailscaleApp('/ts', run, 'darwin')).resolves.toMatchObject({ ok: true })
    expect(run).toHaveBeenCalledWith('/usr/bin/open', ['-g', '-a', 'Tailscale'])
  })

  it('uses the CLI elsewhere', async () => {
    const run = runner('')
    await expect(launchTailscaleApp('tailscale', run, 'windows' as NodeJS.Platform)).resolves.toMatchObject({
      ok: true,
    })
    expect(run).toHaveBeenCalledWith('tailscale', ['up'])
  })
})

describe('applyStartupPlan', () => {
  it('runs the CLI for a stopped tunnel', async () => {
    const run = runner('')
    await expect(
      applyStartupPlan({ kind: 'disconnected', cli: '/ts', backend: 'Stopped' }, run, 'darwin'),
    ).resolves.toMatchObject({ started: true })
    expect(run).toHaveBeenCalledWith('/ts', ['up'])
  })

  it('launches the app in the background for a dead daemon', async () => {
    const run = runner('')
    await expect(
      applyStartupPlan({ kind: 'daemon-down', cli: '/ts', detail: 'x' }, run, 'darwin'),
    ).resolves.toMatchObject({ started: true })
    expect(run).toHaveBeenCalledWith('/usr/bin/open', ['-g', '-a', 'Tailscale'])
  })

  it('runs nothing for a node that has never been signed in', async () => {
    const run = vi.fn(runner(''))
    const result = await applyStartupPlan({ kind: 'needs-login', cli: '/ts' }, run, 'darwin')
    expect(result.started).toBe(false)
    expect(run).not.toHaveBeenCalled()
  })

  it('reports that nothing was started when already connected', async () => {
    const run = vi.fn(runner(''))
    await expect(
      applyStartupPlan({ kind: 'running', cli: '/ts', ipv4: ['100.64.0.9'] }, run, 'darwin'),
    ).resolves.toMatchObject({ started: false })
    expect(run).not.toHaveBeenCalled()
  })
})

describe('launch at login', () => {
  it('reads the real preference domain and key', async () => {
    const run = runner('1')
    await expect(readStartOnLogin(run, 'darwin')).resolves.toBe(true)
    expect(run).toHaveBeenCalledWith('/usr/bin/defaults', [
      'read',
      TAILSCALE_PREF_DOMAIN,
      TAILSCALE_START_ON_LOGIN_KEY,
    ])
    expect(TAILSCALE_START_ON_LOGIN_KEY).toBe('TailscaleStartOnLogin')
  })

  it('reads a disabled preference', async () => {
    await expect(readStartOnLogin(runner('0'), 'darwin')).resolves.toBe(false)
  })

  it('reports an unset key as unknown rather than as off', async () => {
    // An unset key and a disabled one are different: one means "never decided".
    await expect(
      readStartOnLogin(failingRunner('The domain/default pair does not exist'), 'darwin'),
    ).resolves.toBeNull()
  })

  it('is not applicable off macOS', async () => {
    await expect(readStartOnLogin(runner('1'), 'linux')).resolves.toBeNull()
  })

  it('writes the preference on macOS', async () => {
    const run = runner('')
    await expect(enableStartOnLogin(run, 'darwin')).resolves.toMatchObject({ ok: true })
    expect(run).toHaveBeenCalledWith('/usr/bin/defaults', [
      'write',
      TAILSCALE_PREF_DOMAIN,
      TAILSCALE_START_ON_LOGIN_KEY,
      '-bool',
      'true',
    ])
  })

  it('reports a write failure rather than throwing', async () => {
    await expect(enableStartOnLogin(failingRunner('permission denied'), 'darwin')).resolves.toMatchObject({
      ok: false,
      detail: 'permission denied',
    })
  })

  it('does nothing off macOS', async () => {
    const run = runner('')
    await expect(enableStartOnLogin(run, 'linux')).resolves.toMatchObject({ ok: false })
    expect(run).not.toHaveBeenCalled()
  })
})
