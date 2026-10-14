/**
 * A bridge failure that already knows its wire code.
 *
 * The listener treats any thrown value carrying a code from
 * {@link ERROR_CODES} as a deliberate answer and everything else as an internal
 * fault. Keeping the class in its own module lets the bridge and the error
 * translator use it without a cycle.
 *
 * @module dsh-mizar/bridge/method-error
 */
import type { ErrorCode } from '../protocol/frames.js'

/** A method failure carrying the code to answer with. */
export class MethodError extends Error {
  /**
   * @param code - the wire failure code.
   * @param message - a log-oriented description; never contains secrets.
   * @param cause - the upstream failure, kept for server-side diagnostics.
   */
  constructor(
    readonly code: ErrorCode,
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'MethodError'
  }
}

/**
 * Assert a request payload is an object.
 * @param payload - the raw payload.
 * @param method - the method name, for the message.
 * @returns the payload as a record.
 * @throws MethodError when the payload is not an object.
 */
export function requireObject(payload: unknown, method: string): Record<string, unknown> {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    throw new MethodError('MALFORMED_FRAME', `${method}: payload must be an object`)
  }
  return payload as Record<string, unknown>
}

/**
 * Read a required non-empty string field.
 * @param payload - the request payload.
 * @param key - the field name.
 * @param method - the method name, for the message.
 * @returns the value.
 * @throws MethodError when the field is missing or not a string.
 */
export function requireString(
  payload: unknown,
  key: string,
  method: string,
): string {
  const record = requireObject(payload, method)
  const value = record[key]
  if (typeof value !== 'string' || value === '') {
    throw new MethodError('MALFORMED_FRAME', `${method}: payload."${key}" must be a non-empty string`)
  }
  return value
}

/**
 * Assert a request payload is an object, or absent.
 *
 * For methods whose arguments are all optional, an absent payload is a valid
 * "use the defaults" call. A payload of the wrong *type* is not: silently
 * degrading garbage to "no arguments" turns a client bug into a real side
 * effect — a `session.create` with a string payload would otherwise create a
 * session instead of reporting the mistake.
 *
 * @param payload - the raw payload.
 * @param method - the method name, for the message.
 * @returns the payload as a record, or an empty record when it was absent.
 * @throws MethodError when the payload is present but not an object.
 */
export function optionalObject(payload: unknown, method: string): Record<string, unknown> {
  if (payload === undefined || payload === null) return {}
  return requireObject(payload, method)
}

/**
 * Read an optional string field.
 * @param payload - the request payload.
 * @param key - the field name.
 * @returns the value, or `undefined` when absent or not a string.
 */
export function optionalString(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read an optional boolean field.
 * @param payload - the request payload.
 * @param key - the field name.
 * @returns the value, or `undefined` when absent.
 */
export function optionalBoolean(payload: unknown, key: string): boolean | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const value = (payload as Record<string, unknown>)[key]
  return typeof value === 'boolean' ? value : undefined
}
