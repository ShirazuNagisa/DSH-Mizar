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
  bringTailscaleUp,
  describeTailscaleState,
  findTailscaleCli,
  readTailscaleState,
  tailscaleCliCandidates,
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

  it('reports NeedsLogin as stopped, which is actionable', async () => {
    const state = await readTailscaleState('tailscale', runner(JSON.stringify({ BackendState: 'NeedsLogin' })))
    expect(state.kind).toBe('stopped')
  })

  it('reports a daemon that is not running as stopped', async () => {
    // The exact wording the standalone macOS client uses. A pattern looking for
    // "not running" misses it.
    const state = await readTailscaleState(
      'tailscale',
      failingRunner('failed to connect to local tailscaled; it does not seem to be running'),
    )
    expect(state.kind).toBe('stopped')
  })

  it('recognises the other shapes the same failure takes', async () => {
    for (const message of [
      'tailscale is stopped',
      'dial unix /var/run/tailscaled.socket: connect: connection refused',
      'spawn tailscale ENOENT',
      // The shape a timeout produces: the daemon is installed but not answering.
      'Command failed: /Applications/Tailscale.app/Contents/MacOS/Tailscale status --json — timed out',
    ]) {
      const state = await readTailscaleState('tailscale', failingRunner(message))
      expect(state.kind, message).toBe('stopped')
    }
  })

  it('reports an unexplained failure as unknown rather than stopped', async () => {
    // Claiming "stopped" for a permission problem would send the operator down
    // the wrong path.
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
    expect(describeTailscaleState({ kind: 'stopped', cli: 'x', detail: 'd' })).toContain('not connected')
    expect(describeTailscaleState({ kind: 'running', cli: 'x', ipv4: ['100.64.0.9'] })).toContain('100.64.0.9')
    expect(describeTailscaleState({ kind: 'unknown', cli: 'x', detail: 'why' })).toContain('why')
  })
})

describe('bringTailscaleUp', () => {
  it('launches the app on macOS, not the CLI', async () => {
    // `tailscale up` hangs when the daemon is not running; launching the app is
    // what actually starts it.
    const run = runner('')
    await expect(bringTailscaleUp('tailscale', run, 'darwin')).resolves.toMatchObject({ ok: true })
    expect(run).toHaveBeenCalledWith('/usr/bin/open', ['-a', 'Tailscale'])
  })

  it('uses the CLI elsewhere', async () => {
    const run = runner('')
    await expect(bringTailscaleUp('tailscale', run, 'linux')).resolves.toMatchObject({ ok: true })
    expect(run).toHaveBeenCalledWith('tailscale', ['up'])
  })

  it('reports the failure detail rather than throwing', async () => {
    // A plugin must not take down its own startup because an optional external
    // command failed.
    await expect(
      bringTailscaleUp('tailscale', failingRunner('needs login'), 'linux'),
    ).resolves.toMatchObject({ ok: false, detail: 'needs login' })
  })
})
