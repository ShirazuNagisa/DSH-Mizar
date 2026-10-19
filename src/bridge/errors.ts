/**
 * Upstream failure translation.
 *
 * The in-process gateway propagates a business failure with its own code intact
 * — DSH's `RemoteError` keeps `session/writer-held`, `session/model-unavailable`
 * and friends. Those codes are meaningful, but they are also DSH's internal
 * vocabulary and carry a slash-separated namespace the app should not have to
 * parse. This module maps the ones the app must branch on to wire codes and
 * folds everything else into `REMOTE_ERROR` with the original code preserved in
 * the message, so nothing is lost for an operator reading a log.
 *
 * @module dsh-mizar/bridge/errors
 */
import type { ErrorCode } from '../protocol/frames.js'
import { MethodError } from './method-error.js'

/**
 * Read the `code` and `message` off an unknown thrown value.
 * @param error - the thrown value.
 * @returns the code, message and raw value.
 */
function inspect(error: unknown): { code: string | undefined; message: string; raw: unknown } {
  if (typeof error === 'object' && error !== null) {
    const record = error as Record<string, unknown>
    const code = typeof record['code'] === 'string' ? record['code'] : undefined
    const message =
      typeof record['message'] === 'string' && record['message'] !== ''
        ? record['message']
        : String(error)
    return { code, message, raw: error }
  }
  return { code: undefined, message: String(error), raw: error }
}

/** Upstream codes the app branches on, and the wire code each becomes. */
const MAPPED: Readonly<Record<string, ErrorCode>> = {
  // The session is held by another writer (normally the desktop UI). Retrying
  // later is the right advice, so the app needs to recognise it.
  'session/writer-held': 'WRITER_HELD',
  // The selected provider/model pair is not in the available catalog.
  'session/model-unavailable': 'MODEL_UNAVAILABLE',
  'session/attachment-invalid': 'ATTACHMENT_INVALID',
  // The default model could not be initialised because the provider exposes no
  // usable model at all.
  'session/provider-models-unavailable': 'MODEL_UNAVAILABLE',
}

/**
 * Translate a thrown upstream failure into a wire-level {@link MethodError}.
 *
 * @param error - the value thrown by the bridge call.
 * @returns the error to surface to the client.
 */
export function toMethodError(error: unknown): MethodError {
  if (error instanceof MethodError) return error

  const { code, message, raw } = inspect(error)
  const mapped = code === undefined ? undefined : MAPPED[code]

  if (mapped !== undefined) {
    return new MethodError(mapped, code === undefined ? message : `${code}: ${message}`, raw)
  }

  // Keep the upstream code visible: a support request that says only "internal"
  // is not actionable, and the code is not a secret.
  const detail = code === undefined ? message : `${code}: ${message}`
  return new MethodError('REMOTE_ERROR', detail, raw)
}
