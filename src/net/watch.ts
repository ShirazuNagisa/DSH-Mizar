/**
 * Bind-plan watching.
 *
 * The listener's address is not a startup-time constant, and treating it as one
 * is a real failure mode: DSH and the network both come up at login, and
 * orders them. If DSH wins that race, a one-shot bind decision lands on loopback
 * and stays there for the life of the process — the phone simply cannot connect,
 * with no indication why. The same applies when the network comes up later, or
 * when its address changes.
 *
 * So the plan is *waited for* and then *watched*:
 *
 *   1. At startup, wait a bounded time for the requested mode to actually
 *      produce an address before accepting a fallback.
 *   2. Afterwards, poll and rebind when the plan changes.
 *
 * The logic here is pure or takes an injected reader, so the timing behaviour is
 * testable without an operating system.
 *
 * @module dsh-mizar/net/watch
 */
import type { BindPlan } from './interfaces.js'

/**
 * A stable identity for a bind plan, for change detection.
 *
 * Addresses are sorted so a plan that reports them in a different order is not
 * mistaken for a change — reordering would otherwise cause a needless rebind,
 * dropping every connected client.
 *
 * @param plan - the plan to identify.
 * @returns the key.
 */
export function bindKey(plan: BindPlan): string {
  return `${plan.mode}|${[...plan.addresses].sort().join(',')}`
}

/**
 * Whether a plan produced what was asked for.
 *
 * A requested `loopback` is usable; a fallback *to* loopback is not. The
 * difference is `fellBack`, not the mode.
 *
 * @param plan - the plan to test.
 * @returns whether the plan is the requested one rather than a fallback.
 */
export function isRequested(plan: BindPlan): boolean {
  return !plan.fellBack
}

/** Options for {@link awaitRequestedPlan}. */
export interface AwaitPlanOptions {
  /** How long to keep waiting, in milliseconds. Zero accepts the first read. */
  readonly waitMs?: number
  /** How often to re-read, in milliseconds. */
  readonly pollMs?: number
  /** Ends the wait early; the last observed plan is still returned. */
  readonly signal?: AbortSignal
  /** Sink for one diagnostic line when the wait had to be given up on. */
  readonly onGiveUp?: (plan: BindPlan, waitedMs: number) => void
}

/**
 * Resolve a bind plan, waiting for the requested mode to take effect.
 *
 * Returns the first plan that is not a fallback. If none appears within
 * `waitMs`, returns the last observation so the caller can still start a
 * fallback listener rather than failing outright — a phone that cannot reach
 * loopback is no worse off than one that cannot reach anything, and a working
 * local panel is worth having.
 *
 * @param read - reads the current plan; injected so the timing is testable.
 * @param options - wait bounds.
 * @returns the chosen plan.
 */
export async function awaitRequestedPlan(
  read: () => BindPlan,
  options: AwaitPlanOptions = {},
): Promise<BindPlan> {
  const { waitMs = 0, pollMs = 1000, signal, onGiveUp } = options

  const first = read()
  if (isRequested(first) || waitMs <= 0) return first

  const deadline = Date.now() + waitMs
  let last = first
  while (Date.now() < deadline) {
    if (signal?.aborted === true) return last
    await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, Math.max(0, deadline - Date.now()))))
    last = read()
    if (isRequested(last)) return last
  }

  onGiveUp?.(last, waitMs)
  return last
}

/**
 * Report whether a newly read plan differs from the one in use.
 *
 * @param current - the key of the plan the listener is bound to.
 * @param next - the plan just read.
 * @returns whether a rebind is needed.
 */
export function needsRebind(current: string, next: BindPlan): boolean {
  return bindKey(next) !== current
}
