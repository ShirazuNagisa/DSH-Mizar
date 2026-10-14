/**
 * Readiness gates for the Mizar host half.
 *
 * Phase 0.1 established a non-obvious ordering fact by measurement: a plugin's
 * `apply()` runs during composition, but the shipped strict Typert descriptors
 * register **later**, so an immediate `ctx.typertGateway.invoke()` fails with
 * `gateway/invocation-unavailable`. Every consumer of the gateway therefore has
 * to gate on descriptor availability rather than on its own activation.
 *
 * @module dsh-mizar/ready
 */
import type { Context } from './dsh.js'

/** Minimal shape of a registered strict descriptor that readiness needs. */
interface DescriptorLike {
  readonly namespace?: string
  readonly method?: string
  readonly endpoint?: string
}

/** Options for {@link awaitEndpoints}. */
export interface AwaitEndpointsOptions {
  /** Total time to wait, in milliseconds. */
  readonly timeoutMs?: number
  /** Poll interval, in milliseconds. */
  readonly intervalMs?: number
  /** Optional abort signal that ends the wait early. */
  readonly signal?: AbortSignal
}

/** Outcome of an {@link awaitEndpoints} wait. */
export interface EndpointsReady {
  /** Whether every requested endpoint was registered in time. */
  readonly ok: boolean
  /** Endpoints observed at the end of the wait. */
  readonly present: readonly string[]
  /** Requested endpoints never observed. */
  readonly missing: readonly string[]
  /** Total number of local descriptors registered when the wait ended. */
  readonly registeredCount: number
}

/**
 * Build the `namespace/method` key a descriptor is addressed by.
 * @param descriptor - a registered descriptor.
 * @returns its endpoint key, or `undefined` when it carries no identity.
 */
function endpointKeyOf(descriptor: DescriptorLike): string | undefined {
  if (typeof descriptor.endpoint === 'string') return descriptor.endpoint
  const { namespace, method } = descriptor
  if (typeof namespace === 'string' && typeof method === 'string') return `${namespace}/${method}`
  return undefined
}

/**
 * List the strict endpoints currently registered on this environment.
 * @param ctx - any context observing `ctx.typert`.
 * @returns the registered endpoint keys.
 */
export function localEndpoints(ctx: Context): Set<string> {
  const keys = new Set<string>()
  for (const descriptor of ctx.typert.local.list() as readonly DescriptorLike[]) {
    const key = endpointKeyOf(descriptor)
    if (key !== undefined) keys.add(key)
  }
  return keys
}

/**
 * Wait until every named strict endpoint is registered.
 *
 * Returns whether the wait succeeded together with what was observed, so a
 * caller can report a precise diagnostic instead of a bare timeout.
 *
 * @param ctx - any context observing `ctx.typert`.
 * @param required - endpoint keys in `namespace/method` form.
 * @param options - wait bounds.
 * @returns the readiness outcome; never throws for a timeout.
 */
export async function awaitEndpoints(
  ctx: Context,
  required: readonly string[],
  options: AwaitEndpointsOptions = {},
): Promise<EndpointsReady> {
  const { timeoutMs = 60_000, intervalMs = 200, signal } = options
  const deadline = Date.now() + timeoutMs
  let registered = new Set<string>()

  for (;;) {
    registered = localEndpoints(ctx)
    const missing = required.filter((endpoint) => !registered.has(endpoint))
    if (missing.length === 0) {
      return {
        ok: true,
        present: [...required],
        missing: [],
        registeredCount: registered.size,
      }
    }
    if (signal?.aborted === true || Date.now() >= deadline) {
      return {
        ok: false,
        present: required.filter((endpoint) => registered.has(endpoint)),
        missing,
        registeredCount: registered.size,
      }
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}
