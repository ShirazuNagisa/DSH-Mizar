import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseHostFrame, splitRoomPath } from '../src/protocol.js'

/**
 * The golden frames both sides decode.
 *
 * Declared on both sides rather than imported, because the plugin is installed
 * from a git checkout that contains no relay/ directory at all -- the package's
 * `files` list is `["lib", "cordis.patch.yml"]`. Two decoders reading one
 * artifact is what holds the contract; a shared import would only hold a build.
 */
const FIXTURE = JSON.parse(
  readFileSync(new URL('../../protocol/relay/fixture.json', import.meta.url), 'utf8'),
) as { relayToHost: unknown[]; hostToRelay: unknown[] }

describe('splitRoomPath', () => {
  it('splits a room path into its room and the path behind it', () => {
    expect(splitRoomPath('/r/ABCD1234/mizar/v1/ws')).toEqual({
      room: 'ABCD1234',
      path: '/mizar/v1/ws',
    })
  })

  it('keeps a query string with the path', () => {
    expect(splitRoomPath('/r/ABCD/mizar/v1/pair?x=1')).toEqual({
      room: 'ABCD',
      path: '/mizar/v1/pair?x=1',
    })
  })

  it('keeps a deeper path intact', () => {
    expect(splitRoomPath('/r/R/mizar/v1/a/b/c')).toEqual({ room: 'R', path: '/mizar/v1/a/b/c' })
  })

  it('refuses a path with no room', () => {
    expect(splitRoomPath('/mizar/v1/ws')).toBeNull()
    expect(splitRoomPath('/r/')).toBeNull()
    expect(splitRoomPath('/r')).toBeNull()
  })

  it('refuses a path that names a room and nothing else', () => {
    // `/r/ABCD` has no resource behind it; answering it would mean inventing a
    // default, and there is not one.
    expect(splitRoomPath('/r/ABCD')).toBeNull()
  })

  it('treats a bare trailing slash as the room root and forwards it', () => {
    // `/r/ABCD/` does name a path -- the root. It is forwarded rather than
    // refused so the plugin answers with its own 404, which is a more useful
    // error than the relay guessing that the caller meant something else.
    expect(splitRoomPath('/r/ABCD/')).toEqual({ room: 'ABCD', path: '/' })
  })

  it('refuses an empty room', () => {
    expect(splitRoomPath('/r//mizar/v1/ws')).toBeNull()
  })
})

describe('parseHostFrame', () => {
  it('accepts every frame the plugin may send', () => {
    const frames = [
      { t: 'res', id: '1', status: 200, headers: {}, body: null },
      { t: 'ws-open-ok', id: '1' },
      { t: 'ws-msg', id: '1', data: '', binary: false },
      { t: 'ws-close', id: '1' },
      { t: 'pong', id: 'p1' },
      { t: 'error', id: '1', message: 'no' },
    ]
    for (const frame of frames) {
      expect(parseHostFrame(JSON.stringify(frame))).toEqual(frame)
    }
  })

  it('decodes every golden frame the relay may receive', () => {
    for (const frame of FIXTURE.hostToRelay) {
      expect(parseHostFrame(JSON.stringify(frame))).toEqual(frame)
    }
  })

  it('covers every frame type the plugin may send', () => {
    const types = new Set(FIXTURE.hostToRelay.map((frame) => (frame as { t: string }).t))
    expect([...types].sort()).toEqual(['error', 'pong', 'res', 'ws-close', 'ws-msg', 'ws-open-ok'])
  })

  it('refuses anything that is not a tagged object', () => {
    expect(parseHostFrame('not json')).toBeNull()
    expect(parseHostFrame('null')).toBeNull()
    expect(parseHostFrame('[]')).toBeNull()
    expect(parseHostFrame('"text"')).toBeNull()
    expect(parseHostFrame('{"id":"1"}')).toBeNull()
    expect(parseHostFrame('{"t":42}')).toBeNull()
  })
})
