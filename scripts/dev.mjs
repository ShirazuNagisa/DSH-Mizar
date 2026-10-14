#!/usr/bin/env node
/**
 * The dev harness, in Node instead of bash.
 *
 * `scripts/dev.sh` works and is the reference for behaviour, but every script in
 * this repository is bash, and the plugin is supposed to support Windows. That
 * made "Windows is unverified" a structural problem rather than a missing run:
 * there was no way to start the host there even if somebody had a machine.
 *
 * Node is the one runtime both platforms certainly have, since the plugin itself
 * needs it. So this file replicates the four things bash was doing that are not
 * portable, and nothing else:
 *
 *   1. **Killing a process tree.** The launcher is a thin parent that forks the
 *      real host, so killing the recorded pid leaves the host holding the port.
 *      bash walked the tree with `pgrep -P`; here the child is spawned detached
 *      so it leads its own process group on POSIX, and Windows gets `taskkill
 *      /T`. One call either way.
 *   2. **Finding whoever holds a port.** `lsof` on POSIX, `netstat -ano` on
 *      Windows.
 *   3. **Unsetting inherited DSH session markers.** Node does this natively via
 *      the spawn environment, which removes the `env -u` list that had to be
 *      kept in sync by hand.
 *   4. **Tail-following the log**, which needed neither bash nor a rewrite.
 *
 * The app path is the one thing that genuinely differs per platform, and the one
 * thing here that has not been verified: the Windows locations are probed
 * guesses. `MIZAR_APP` overrides all of it.
 *
 * Usage:
 *   node scripts/dev.mjs bootstrap|build|install|boot|stop|smoke|log|dump
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DEV_HOME = join(ROOT, '.devhome')
const PLUGIN_DIR = ROOT
const STATE_DIR = join(ROOT, '.devstate')
const LOG_FILE = join(STATE_DIR, 'dev.log')
const PID_FILE = join(STATE_DIR, 'dev.pid')

const PROFILE = process.env['MIZAR_PROFILE'] ?? 'mizar-dev'
const WEB_PORT = Number(process.env['MIZAR_WEB_PORT'] ?? 19388)
const LISTENER_PORT = Number(process.env['MIZAR_LISTENER_PORT'] ?? 19390)
const IS_WINDOWS = process.platform === 'win32'

/**
 * Where the desktop app is installed.
 *
 * The macOS path is the one this project was built against. The Windows entries
 * are the documented install locations for a per-user and a machine-wide
 * install; they are a best guess and have never been exercised, which is why
 * MIZAR_APP exists and is checked first.
 */
const APP_CANDIDATES = IS_WINDOWS
  ? [
      join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
      join(process.env['PROGRAMFILES'] ?? '', 'DeepSeek Harness', 'DeepSeek Harness.exe'),
      join(process.env['PROGRAMFILES'] ?? '', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh'),
    ]
  : [
      '/Applications/DeepSeek Harness.app',
      join(process.env['HOME'] ?? '', 'Applications', 'DeepSeek Harness.app'),
    ]

/** Report a failure and stop. */
function die(message) {
  console.error(`dev: ${message}`)
  process.exit(1)
}

/** Resolve the app root, or explain what to set. */
function appRoot() {
  const override = process.env['MIZAR_APP']
  if (override !== undefined && override !== '') {
    if (!existsSync(override)) die(`MIZAR_APP points at "${override}", which does not exist`)
    return override
  }
  for (const candidate of APP_CANDIDATES) {
    if (candidate !== '' && existsSync(candidate)) return candidate
  }
  die(
    `could not find the DSH desktop app. Looked in:\n  ${APP_CANDIDATES.join('\n  ')}\n` +
      'Set MIZAR_APP to its install location.',
  )
}

/** The directory holding the app's `dsh` package. */
function dshRoot() {
  const root = appRoot()
  return IS_WINDOWS ? join(root, 'resources', 'app.asar', 'dsh') : join(root, 'Contents', 'Resources', 'app.asar', 'dsh')
}

/**
 * Run the app's bundled `dsh` CLI.
 *
 * The inherited `DSH_*` markers are dropped rather than inherited: running this
 * from inside a DSH session would otherwise leak `DSH_PROFILE=desktop` and point
 * the harness at the operator's real profile instead of the workspace-local one.
 * That happened once, which is why every variable here is `MIZAR_*`.
 *
 * @param args - arguments to pass after the CLI path.
 * @param options - spawn options.
 * @returns the child process.
 */
function dsh(args, options = {}) {
  const env = { ...process.env }
  for (const key of ['DSH_PROFILE', 'DSH_PROFILE_DIR', 'DSH_SESSION_ID', 'DSH_SHELL', 'DSH_WEB_URL']) {
    delete env[key]
  }
  env['DSH_HOME'] = DEV_HOME
  const useElectronNode = !IS_WINDOWS
  if (useElectronNode) env['ELECTRON_RUN_AS_NODE'] = '1'

  const bin = useElectronNode
    ? join(appRoot(), 'Contents', 'MacOS', 'DeepSeek Harness')
    : join(appRoot(), 'DeepSeek Harness.exe')
  const cli = join(dshRoot(), 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js')

  const argv = useElectronNode
    ? ['--expose-internals', cli, ...args]
    : [cli, ...args]

  // Merge, never replace: `{ env, ...options }` would let a caller's env wipe
  // DSH_HOME, ELECTRON_RUN_AS_NODE and the unset markers that keep this harness
  // off the operator's real profile.
  // The isolation values are applied last, after any caller-supplied
  // environment, because the caller is exactly who got this wrong: `boot` passed
  // `{ ...process.env, DSH_MIZAR_SPIKE_WORKSPACE }`, which put the ambient
  // `DSH_HOME=~/.dsh` back on top of the workspace one and produced "profile
  // mizar-dev does not exist" while it sat there existing. Same shape as the
  // incident the MIZAR_* naming convention exists to prevent, so the function now
  // owns these rather than trusting every caller to preserve them.
  const { env: extraEnv, ...rest } = options
  return spawn(bin, argv, {
    stdio: 'inherit',
    ...rest,
    env: { ...(extraEnv ?? {}), ...env },
  })
}

/**
 * The pid listening on a port, or `null`.
 *
 * `netstat -ano` output is `proto  local  foreign  state  pid`, and the local
 * address is `host:port`, so the port is matched at the end of the address
 * rather than anywhere in the line.
 *
 * @param port - the port to look for.
 * @returns the pid, or `null`.
 */
function portPid(port) {
  if (IS_WINDOWS) {
    const result = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' })
    for (const line of (result.stdout ?? '').split('\n')) {
      const parts = line.trim().split(/\s+/)
      if (parts.length < 5) continue
      if (!/LISTENING/i.test(parts[3] ?? '')) continue
      if (!(parts[1] ?? '').endsWith(`:${port}`)) continue
      const pid = Number(parts[4])
      if (Number.isInteger(pid) && pid > 0) return pid
    }
    return null
  }
  const result = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
  const first = (result.stdout ?? '').trim().split('\n')[0]
  const pid = Number(first)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Kill a process and everything it spawned.
 *
 * On POSIX the child was spawned detached, so it leads a process group and one
 * negative-pid signal reaches the whole tree. Windows has no such concept, which
 * is what `/T` is for.
 *
 * @param pid - the process to kill.
 * @param force - whether to send SIGKILL / `/F`.
 */
function killTree(pid, force = false) {
  if (!Number.isInteger(pid) || pid <= 0) return
  if (IS_WINDOWS) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore' })
    return
  }
  try {
    process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM')
  } catch {
    // The group may already be gone, or the pid may have been reaped between the
    // lookup and the signal. Neither is worth failing a stop for.
    try {
      process.kill(pid, force ? 'SIGKILL' : 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
}

/** Stop anything left over from an earlier run. */
function stopEverything() {
  if (existsSync(PID_FILE)) {
    const pid = Number(readFileSync(PID_FILE, 'utf8').trim())
    killTree(pid)
    setTimeout(() => killTree(pid, true), 1500)
  }
  const holder = portPid(WEB_PORT)
  if (holder !== null) {
    killTree(holder)
    setTimeout(() => killTree(holder, true), 1500)
  }
  rmSync(PID_FILE, { force: true })
}

/** Wait until the log contains a pattern, the process dies, or time runs out. */
async function waitForLog(pattern, child, seconds) {
  const deadline = Date.now() + seconds * 1000
  while (Date.now() < deadline) {
    if (existsSync(LOG_FILE)) {
      const text = readFileSync(LOG_FILE, 'utf8')
      if (new RegExp(pattern).test(text)) return true
    }
    if (child !== undefined && child.exitCode !== null) return false
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return false
}

/**
 * Start the app once, wait for a marker, then stop it.
 * @param marker - the log pattern that means "up".
 * @param extra - extra app arguments.
 */
async function bootOnce(marker, extra = []) {
  mkdirSync(STATE_DIR, { recursive: true })
  rmSync(LOG_FILE, { force: true })
  const out = openSync(LOG_FILE, 'a')
  const child = dsh(['--profile', PROFILE, ...extra, '--no-open', '--port', String(WEB_PORT)], {
    stdio: ['ignore', out, out],
    detached: !IS_WINDOWS,
  })
  await waitForLog(marker, child, 180)
  killTree(child.pid ?? 0)
  await new Promise((resolve) => setTimeout(resolve, 1200))
  killTree(child.pid ?? 0, true)
}

const commands = {
  /** Create the workspace-local dev home and profile. */
  async bootstrap() {
    mkdirSync(DEV_HOME, { recursive: true })
    mkdirSync(STATE_DIR, { recursive: true })
    if (existsSync(join(DEV_HOME, 'profiles', PROFILE))) {
      console.log(`dev: profile '${PROFILE}' already exists in .devhome`)
    } else {
      console.log(`dev: initializing profile '${PROFILE}' from the shipped web template`)
      await bootOnce('dsh web:', ['--from-default-profile', 'web'])
      if (!existsSync(join(DEV_HOME, 'profiles', PROFILE))) {
        die(`profile initialization failed; see ${LOG_FILE}`)
      }
    }
    console.log(`dev: dev home ready at ${DEV_HOME}`)
  },

  /** Build the plugin. */
  build() {
    if (!existsSync(join(PLUGIN_DIR, 'node_modules'))) {
      console.log('dev: installing plugin dependencies')
      const install = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
        cwd: PLUGIN_DIR,
        stdio: 'inherit',
        env: { ...process.env, npm_config_cache: join(ROOT, '.devcache', 'npm') },
        shell: IS_WINDOWS,
      })
      if (install.status !== 0) die('npm install failed')
    }
    const built = spawnSync(
      process.execPath,
      [join(PLUGIN_DIR, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.json'],
      { cwd: PLUGIN_DIR, stdio: 'inherit' },
    )
    if (built.status !== 0) die('tsc failed')
    console.log('dev: host half built to lib/')
  },

  /** Install the plugin into the dev profile. */
  async install() {
    await commands.build()
    const child = dsh(['plugin', '--profile', PROFILE, 'add', PLUGIN_DIR])
    await new Promise((resolve) => child.on('exit', resolve))
    console.log(`dev: dsh-mizar installed into '${PROFILE}'`)
  },

  /** Start the app in the background. */
  async boot() {
    mkdirSync(STATE_DIR, { recursive: true })
    const stale = portPid(WEB_PORT)
    if (stale !== null) {
      die(`port ${WEB_PORT} is already in use by pid ${stale} — run 'node scripts/dev.mjs stop' first`)
    }
    rmSync(LOG_FILE, { force: true })
    const out = openSync(LOG_FILE, 'a')
    const child = dsh(['--profile', PROFILE, '--no-open', '--port', String(WEB_PORT)], {
      stdio: ['ignore', out, out],
      detached: !IS_WINDOWS,
      // Only the extra variable. Spreading process.env here would re-add the
      // ambient DSH markers that dsh() just removed.
      env: { DSH_MIZAR_SPIKE_WORKSPACE: ROOT },
    })
    if (child.pid !== undefined) writeFileSync(PID_FILE, String(child.pid))
    console.log(`dev: booting '${PROFILE}' on 127.0.0.1:${WEB_PORT} (pid ${child.pid})`)
    const up = await waitForLog('dsh web:|startup failed', child, 90)
    if (!up) {
      console.error(`dev: boot did not reach readiness; last lines of ${LOG_FILE}:`)
      console.error(tailLog(20))
      process.exit(1)
    }
    child.unref()
    console.log(tailLog(30))
  },

  /** Stop the dev server. */
  stop() {
    stopEverything()
    console.log('dev: stopped')
  },

  /** Boot a fresh instance and run the live smoke suite against it. */
  async smoke() {
    stopEverything()
    await new Promise((resolve) => setTimeout(resolve, 800))
    await commands.boot()

    const log = readFileSync(LOG_FILE, 'utf8')
    const authority = /listening on ([0-9a-zA-Z.:[\]-]+):(\d+)/.exec(log)
    if (authority === null) die(`could not read the listener authority from ${LOG_FILE}`)
    const base = `http://${authority[1]}:${authority[2]}`

    const code = /pairing code: ([0-9A-Z-]+)/.exec(log)?.[1] ?? ''
    if (code === '') die(`no pairing code in ${LOG_FILE}`)

    const webToken = /dsh web: http:\/\/127\.0\.0\.1:\d+\/\?token=([A-Za-z0-9_-]+)/.exec(log)?.[1] ?? ''

    console.log(`dev: smoke against ${base}`)
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'smoke-listener.mjs')], {
      stdio: 'inherit',
      env: {
        ...process.env,
        MIZAR_BASE: base,
        MIZAR_CODE: code,
        MIZAR_WEB_BASE: `http://127.0.0.1:${WEB_PORT}`,
        MIZAR_WEB_TOKEN: webToken,
      },
    })
    const status = await new Promise((resolve) => child.on('exit', resolve))
    process.exitCode = typeof status === 'number' ? status : 1
  },

  /** Follow the log. */
  log() {
    if (!existsSync(LOG_FILE)) die(`no log at ${LOG_FILE}`)
    const child = spawn(
      IS_WINDOWS ? 'powershell' : 'tail',
      IS_WINDOWS ? ['-Command', `Get-Content -Wait -Tail 40 '${LOG_FILE}'`] : ['-f', LOG_FILE],
      { stdio: 'inherit' },
    )
    return new Promise((resolve) => child.on('exit', resolve))
  },

  /** Print the Mizar lines of the resolved config tree. */
  dump() {
    const log = existsSync(LOG_FILE) ? readFileSync(LOG_FILE, 'utf8') : ''
    process.stdout.write(
      log
        .split('\n')
        .filter((line) => line.includes('mizar') || line.includes('[mizar]'))
        .join('\n') + '\n',
    )
  },
}

/** The last N lines of the log. */
function tailLog(n) {
  if (!existsSync(LOG_FILE)) return ''
  return readFileSync(LOG_FILE, 'utf8').split('\n').slice(-n).join('\n')
}

const command = process.argv[2] ?? 'boot'
const handler = commands[command]
if (handler === undefined) {
  die(`unknown command '${command}'. Use: ${Object.keys(commands).join('|')}`)
}
await handler()
