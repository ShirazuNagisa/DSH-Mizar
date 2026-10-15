import { describe, expect, it } from 'vitest'
import { parseHostFrame, splitRoomPath } from '../src/protocol.js'

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

  it('refuses anything that is not a tagged object', () => {
    expect(parseHostFrame('not json')).toBeNull()
    expect(parseHostFrame('null')).toBeNull()
    expect(parseHostFrame('[]')).toBeNull()
    expect(parseHostFrame('"text"')).toBeNull()
    expect(parseHostFrame('{"id":"1"}')).toBeNull()
    expect(parseHostFrame('{"t":42}')).toBeNull()
  })
})
