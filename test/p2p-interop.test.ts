/**
 * Two implementations, one connection.
 *
 * The byte-level fixture proves the two sides agree on *format*. This proves
 * they agree on *behaviour*: a Node engine dials a Swift engine, and a Swift
 * engine dials a Node engine, over real UDP on loopback. Signatures are
 * verified in both directions, keys are derived on both sides, and a message
 * makes the round trip — which is the whole claim behind "a multi-platform
 * kernel" and the one thing no fixture can check.
 *
 * The Swift half is `iOS/MizarKit/Probe`, a CLI built only on MizarKit's
 * public API. Gated because it needs the Swift toolchain and a build:
 *
 *     cd dsh && MIZAR_P2P_INTEROP=1 npx vitest run test/p2p-interop.test.ts
 *
 * @module dsh-mizar/test/p2p-interop
 */
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { deriveIdentity } from '../src/transport/p2p/crypto.js'
import { Engine } from '../src/transport/p2p/engine.js'
import { STANDARD_POLICY } from '../src/transport/p2p/policy.js'

const ENABLED = process.env.MIZAR_P2P_INTEROP === '1'
const PACKAGE_PATH = fileURLToPath(new URL('../../iOS/MizarKit', import.meta.url))
const PROBE_PATH = `${PACKAGE_PATH}/.build/debug/mizar-net-probe`
// The repository's Swift wrapper knows the two flags this environment needs
// (SwiftPM's own sandbox cannot nest inside the session's, and its caches
// belong inside the checkout). Repeating them here would let the two drift.
const SWIFT_WRAPPER = fileURLToPath(new URL('../../iOS/scripts/swift.sh', import.meta.url))

/** A line-oriented handle on the probe process. */
interface Probe {
  /** Wait for the first line starting with `prefix`, and return the whole line. */
  line(prefix: string, timeoutMs?: number): Promise<string>
  /** Wait for the process to exit and return its code. */
  exited(timeoutMs?: number): Promise<number>
  /** Stop the process, whatever state it is in. */
  stop(): void
}

const probes: Probe[] = []
const engines: Engine[] = []

/** Start the probe with the given arguments. */
function startProbe(args: readonly string[]): Probe {
  const child: ChildProcessWithoutNullStreams = spawn(PROBE_PATH, args, { stdio: 'pipe' })
  const lines: string[] = []
  const waiters: Array<{ prefix: string; resolve: (line: string) => void; timer: NodeJS.Timeout }> = []
  let exitCode: number | null = null
  let buffer = ''

  const settle = (): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]
      if (waiter === undefined) continue
      const found = lines.find((line) => line.startsWith(waiter.prefix))
      if (found === undefined) continue
      clearTimeout(waiter.timer)
      waiters.splice(index, 1)
      waiter.resolve(found)
    }
  }

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    let newline = buffer.indexOf('\n')
    while (newline >= 0) {
      lines.push(buffer.slice(0, newline).trim())
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
    settle()
  })
  // The probe's stderr is diagnostics, not protocol; keep it out of the way
  // unless the test fails.
  child.stderr.on('data', () => {})
  child.on('exit', (code) => {
    exitCode = code ?? -1
  })

  const probe: Probe = {
    line(prefix, timeoutMs = 5000) {
      const found = lines.find((line) => line.startsWith(prefix))
      if (found !== undefined) return Promise.resolve(found)
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`the probe never printed "${prefix}"`)), timeoutMs)
        waiters.push({ prefix, resolve, timer })
      })
    },
    exited(timeoutMs = 5000) {
      if (exitCode !== null) return Promise.resolve(exitCode)
      return new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the probe did not exit')), timeoutMs)
        child.once('exit', (code) => {
          clearTimeout(timer)
          resolve(code ?? -1)
        })
      })
    },
    stop() {
      if (exitCode === null) child.kill('SIGKILL')
    },
  }
  probes.push(probe)
  return probe
}

/**
 * Start a Node engine with no STUN: the tests hand over a loopback address,
 * and a STUN query would add an outside dependency to a hermetic test.
 * @param secret - the device secret the identity derives from.
 * @returns the engine.
 */
async function startEngine(secret: Buffer): Promise<Engine> {
  const engine = await Engine.create({
    identity: deriveIdentity(secret, 'device'),
    policy: { ...STANDARD_POLICY, stunServers: [] },
    stunServers: [],
  })
  engines.push(engine)
  return engine
}

/** Fail rather than hang if the peer never answers. */
function within<T>(promise: Promise<T>, milliseconds = 5000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timed out')), milliseconds)),
  ])
}

/** Hex, which is what the probe's `--secret` wants. */
function hex(bytes: Buffer): string {
  return bytes.toString('hex')
}

beforeAll(async () => {
  if (!ENABLED) return
  // One build, then every test reuses the binary. Verbose on failure: a
  // toolchain problem here should read as a build error, not as a punch that
  // mysteriously failed.
  await new Promise<void>((resolve, reject) => {
    execFile(
      SWIFT_WRAPPER,
      ['build', '--product', 'mizar-net-probe'],
      { maxBuffer: 32 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`swift build failed:\n${stdout}\n${stderr}`))
        else resolve()
      },
    )
  })
}, 300_000)

afterEach(async () => {
  for (const probe of probes.splice(0)) probe.stop()
  for (const engine of engines.splice(0)) await engine.close()
})

describe.skipIf(!ENABLED)('a Node engine and a Swift engine', () => {
  it('connect when Node dials and Swift accepts', async () => {
    const swiftSecret = randomBytes(32)
    const probe = startProbe(['accept', '--secret', hex(swiftSecret)])
    const swiftId = (await probe.line('ID ')).slice(3)
    const port = Number((await probe.line('PORT ')).slice(5))
    expect(port).toBeGreaterThan(0)
    expect(swiftId).toHaveLength(43)

    const node = await startEngine(randomBytes(32))
    const stream = await within(
      node.dial({ endpointId: swiftId, direct: [`127.0.0.1:${port}`] }, 5000),
    )

    await stream.send(Buffer.from('hello swift'))
    // The echo is the Swift session opening Node's sealed chunk, reassembling
    // it, and sealing a reply under the other direction's key.
    expect((await within(stream.receive()))?.toString()).toBe('echo:hello swift')
    expect(await probe.line('RECEIVED ')).toBe('RECEIVED hello swift')
    expect(await probe.exited(10_000)).toBe(0)
  })

  it('connect when Swift dials and Node accepts', async () => {
    const node = await startEngine(randomBytes(32))
    const accepting = node.accept()
    const swiftSecret = randomBytes(32)
    const probe = startProbe([
      'dial',
      '--secret',
      hex(swiftSecret),
      '--purpose',
      'device',
      '--peer',
      node.identity.endpointId,
      '--address',
      `127.0.0.1:${node.port}`,
    ])
    expect(await probe.line('ID ')).toHaveLength(46)

    // This direction is the one that proves Node's *signature* is accepted by
    // CryptoKit: the probe verifies the ServerHello Node signs before it
    // reports a REPLY.
    const stream = await within(accepting, 10_000)
    expect((await within(stream.receive()))?.toString()).toBe('ping')
    await stream.send(Buffer.from('echo:ping'))

    expect(await probe.line('REPLY ')).toBe('REPLY echo:ping')
    expect(await probe.exited(10_000)).toBe(0)
  })
})
