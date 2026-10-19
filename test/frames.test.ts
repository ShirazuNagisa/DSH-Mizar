/**
 * Tests for the Mizar wire protocol validation.
 *
 * This is the contract the iOS app is written against, so the cases below pin
 * the rejections as carefully as the acceptances: a frame that cannot be
 * understood must produce a specific code rather than being half-read.
 *
 * @module dsh-mizar/test/frames
 */
import { describe, expect, it } from 'vitest'
import {
  encodeFrame,
  ERROR_CODES,
  errorFrame,
  isHelloFrame,
  okFrame,
  parseClientFrame,
  PROTOCOL_VERSION,
} from '../src/protocol/frames.js'

/** Parse and assert success, returning the frame. */
function accept(raw: unknown) {
  const result = parseClientFrame(typeof raw === 'string' ? raw : JSON.stringify(raw))
  if (!result.ok) throw new Error(`expected acceptance, got ${result.code}: ${result.message}`)
  return result.frame
}

/** Parse and assert failure, returning the code. */
function reject(raw: unknown) {
  const result = parseClientFrame(typeof raw === 'string' ? raw : JSON.stringify(raw))
  if (result.ok) throw new Error(`expected rejection, got ${JSON.stringify(result.frame)}`)
  return result.code
}

describe('protocol version', () => {
  it('is 1 for this build', () => {
    expect(PROTOCOL_VERSION).toBe(1)
  })
})

describe('parseClientFrame — rejections', () => {
  it('rejects text that is not JSON', () => {
    expect(reject('{ nope')).toBe('MALFORMED_FRAME')
  })

  it('rejects a JSON scalar or array', () => {
    expect(reject('"hello"')).toBe('MALFORMED_FRAME')
    expect(reject('[]')).toBe('MALFORMED_FRAME')
    expect(reject('null')).toBe('MALFORMED_FRAME')
  })

  it('rejects a missing version', () => {
    expect(reject({ type: 'hello', token: 'x' })).toBe('PROTOCOL_VERSION_MISMATCH')
  })

  it('rejects a future version explicitly rather than reading fields', () => {
    expect(reject({ v: 2, type: 'session.list', id: 'a' })).toBe('PROTOCOL_VERSION_MISMATCH')
  })

  it('rejects a frame with no type', () => {
    expect(reject({ v: 1, id: 'a' })).toBe('MALFORMED_FRAME')
    expect(reject({ v: 1, type: '', id: 'a' })).toBe('MALFORMED_FRAME')
  })

  it('rejects a non-string id', () => {
    expect(reject({ v: 1, type: 'ping', id: 7 })).toBe('MALFORMED_FRAME')
  })

  it('rejects a request with no id', () => {
    // Without an id the response could not be correlated, so this is a
    // protocol error rather than a silently unanswerable request.
    expect(reject({ v: 1, type: 'session.list' })).toBe('MALFORMED_FRAME')
    expect(reject({ v: 1, type: 'session.list', id: '' })).toBe('MALFORMED_FRAME')
  })

  it('rejects hello without a token string', () => {
    expect(reject({ v: 1, type: 'hello' })).toBe('MALFORMED_FRAME')
    expect(reject({ v: 1, type: 'hello', token: 42 })).toBe('MALFORMED_FRAME')
  })

  it('reports a version mismatch with the offending value', () => {
    const result = parseClientFrame(JSON.stringify({ v: 'one', type: 'hello', token: '' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('one')
  })
})

describe('parseClientFrame — acceptances', () => {
  it('accepts a minimal hello', () => {
    const frame = accept({ v: 1, type: 'hello', token: '' })
    expect(frame.type).toBe('hello')
  })

  it('keeps the optional hello metadata when present', () => {
    const frame = accept({
      v: 1,
      type: 'hello',
      id: 'h1',
      token: 'mz_abc',
      appVersion: '0.1.0',
      deviceModel: 'iPhone 18 Pro',
      protocolVersion: 1,
    })
    expect(frame).toMatchObject({
      type: 'hello',
      id: 'h1',
      token: 'mz_abc',
      appVersion: '0.1.0',
      deviceModel: 'iPhone 18 Pro',
      protocolVersion: 1,
    })
  })

  it('drops hello metadata of the wrong type instead of propagating it', () => {
    const frame = accept({ v: 1, type: 'hello', token: 'x', appVersion: 5, protocolVersion: 'one' })
    expect(frame).not.toHaveProperty('appVersion')
    expect(frame).not.toHaveProperty('protocolVersion')
  })

  it('accepts a request and keeps its payload', () => {
    const frame = accept({ v: 1, type: 'session.list', id: 'r1', payload: { workspaceId: 'w' } })
    expect(frame).toMatchObject({ id: 'r1', type: 'session.list', payload: { workspaceId: 'w' } })
  })

  it('accepts a request with no payload', () => {
    const frame = accept({ v: 1, type: 'ping', id: 'r2' })
    expect(frame).not.toHaveProperty('payload')
  })
})

describe('isHelloFrame', () => {
  it('narrows hello', () => {
    const frame = accept({ v: 1, type: 'hello', token: 'x' })
    expect(isHelloFrame(frame)).toBe(true)
    if (isHelloFrame(frame)) {
      // The guard exists so this property is typed `string`, not `unknown`.
      expect(frame.token).toBe('x')
    }
  })

  it('does not match a request that happens to be named like hello', () => {
    const frame = accept({ v: 1, type: 'session.hello', id: 'a' })
    expect(isHelloFrame(frame)).toBe(false)
  })
})

describe('error codes', () => {
  it('carries every code the attachment methods answer with', () => {
    // The app renders localized text from the code, so the upload vocabulary is
    // part of the contract the moment a method can produce it.
    for (const code of [
      'UPLOAD_UNKNOWN',
      'UPLOAD_BAD_CHUNK',
      'UPLOAD_TOO_LARGE',
      'UPLOAD_INCOMPLETE',
      'ATTACHMENT_UNKNOWN',
      'ATTACHMENT_TOO_LARGE',
      'ATTACHMENT_UNSUPPORTED',
      'ATTACHMENT_FAILED',
    ]) {
      expect(ERROR_CODES, `${code} is not a wire code`).toContain(code)
    }
  })

  it('does not change the protocol version for optional additions', () => {
    // New methods, new optional payload fields and new error codes are
    // compatible: every existing frame means what it meant, and a peer that does
    // not know a key or a method leaves it alone.
    expect(PROTOCOL_VERSION).toBe(1)
  })
})

describe('server frames', () => {
  it('builds an ok frame carrying the correlation id', () => {
    expect(okFrame('r1', { value: 2 })).toEqual({ v: 1, type: 'ok', id: 'r1', result: { value: 2 } })
  })

  it('omits the result when there is none', () => {
    expect(okFrame('r1')).not.toHaveProperty('result')
  })

  it('builds an error frame with the code and correlation id', () => {
    expect(errorFrame('NOT_IMPLEMENTED', 'no', 'r1')).toEqual({
      v: 1,
      type: 'error',
      code: 'NOT_IMPLEMENTED',
      message: 'no',
      retryable: false,
      id: 'r1',
    })
  })

  it('omits the id for an unsolicited error', () => {
    expect(errorFrame('RATE_LIMITED', 'slow down')).not.toHaveProperty('id')
  })

  it('round-trips through the encoder', () => {
    const frame = okFrame('r9', { n: 1 })
    expect(JSON.parse(encodeFrame(frame))).toEqual(frame)
  })
})
