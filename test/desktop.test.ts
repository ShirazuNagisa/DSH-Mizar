/**
 * Tests for the desktop identity the phone draws under a computer's name.
 *
 * The mapping is small but user-visible: `win32` under a machine would look
 * like a leaked build identifier, and an unnamed OS is worse than the platform
 * string it already has.
 *
 * @module dsh-mizar/test/desktop
 */
import { describe, expect, it } from 'vitest'
import { DESKTOP_CLIENT, desktopIdentity, desktopOS } from '../src/desktop.js'

describe('desktop identity', () => {
  it('spells the common platforms the way their makers do', () => {
    expect(desktopOS('darwin')).toBe('macOS')
    expect(desktopOS('win32')).toBe('Windows')
    expect(desktopOS('linux')).toBe('Linux')
  })

  it('passes an unfamiliar platform through instead of inventing a name', () => {
    expect(desktopOS('freebsd')).toBe('freebsd')
  })

  it('names this plugin’s desktop and the OS it runs on', () => {
    const identity = desktopIdentity()
    expect(identity.client).toBe(DESKTOP_CLIENT)
    expect(identity.client).toBe('DSH')
    expect(identity.os).not.toBe('')
  })
})
