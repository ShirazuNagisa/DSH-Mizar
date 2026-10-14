/**
 * The method table.
 *
 * One place where wire method names map to bridge calls. Keeping it separate
 * from the listener is what lets `server/listener.ts` stay transport-only: it
 * moves frames and enforces authentication, and knows nothing about sessions.
 * Every DSH-shaped decision lives here or below.
 *
 * @module dsh-mizar/bridge
 */
import type { Context } from '../dsh.js'
import { listSessions, sessionStats } from './sessions.js'

/** Per-connection facts handed to a method. */
export interface MethodContext {
  /** The authenticated device's id. */
  readonly deviceId: string
  /** The authenticated device's display name. */
  readonly deviceName: string
  /** The remote address the request arrived from. */
  readonly remote: string
}

/** A wire method implementation. */
export type MethodHandler = (payload: unknown, context: MethodContext) => Promise<unknown>

/** What the bridge needs from its host to answer `host.info`. */
export interface HostFacts {
  readonly hostId: string
  readonly hostName: string
  readonly home: string
  readonly protocolVersion: number
}

/** A malformed request payload. */
export class MethodError extends Error {
  /**
   * @param code - the wire failure code.
   * @param message - a log-oriented description.
   */
  constructor(
    readonly code: 'MALFORMED_FRAME' | 'INTERNAL',
    message: string,
  ) {
    super(message)
    this.name = 'MethodError'
  }
}

/**
 * Read a required string field from a request payload.
 * @param payload - the raw payload.
 * @param key - the field name.
 * @returns the value.
 * @throws MethodError when the payload is not an object or the field is missing.
 */
function requireString(payload: unknown, key: string): string {
  if (typeof payload !== 'object' || payload === null) {
    throw new MethodError('MALFORMED_FRAME', `payload must be an object with a "${key}"`)
  }
  const value = (payload as Record<string, unknown>)[key]
  if (typeof value !== 'string' || value === '') {
    throw new MethodError('MALFORMED_FRAME', `payload."${key}" must be a non-empty string`)
  }
  return value
}

/**
 * Build the method table for one plugin mount.
 *
 * @param ctx - the plugin context, used for every DSH call.
 * @param facts - host identity reported to clients.
 * @returns the table, keyed by wire method name.
 */
export function createMethodTable(ctx: Context, facts: HostFacts): Record<string, MethodHandler> {
  return {
    /** Host identity and protocol facts; the phone calls this after `welcome`. */
    'host.info': async () => ({
      hostId: facts.hostId,
      hostName: facts.hostName,
      home: facts.home,
      protocolVersion: facts.protocolVersion,
    }),

    /** Every session DSH would list, newest activity first. */
    'session.list': async () => listSessions(ctx),

    /**
     * One session's usage frame. Works for a cold session: the projection read
     * does not activate an agent.
     */
    'session.stats': async (payload) => sessionStats(ctx, requireString(payload, 'sessionId')),
  }
}
