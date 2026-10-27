/**
 * The 0.9.0 configuration surface.
 *
 * Small on purpose: a plugin that only dials a local file should not have a
 * setting for a port, a bind policy or a relay. These tests pin the defaults and
 * the one thing a deployment is likely to change — which services may be proxied.
 *
 * @module dsh-mizar/test/config
 */
import { describe, expect, it } from 'vitest'
import { Config, DEFAULT_ENDPOINT_FILE, DEFAULT_SERVICES } from '../src/config.js'

describe('Config', () => {
  it('defaults to enabled, with the desktop endpoint file', () => {
    const config = Config({})
    expect(config.enabled).toBe(true)
    expect(config.endpointFile).toBe(DEFAULT_ENDPOINT_FILE)
  })

  it('allows the in-process services the desktop needs on day one', () => {
    const config = Config({})
    expect(config.services).toEqual([...DEFAULT_SERVICES])
    expect(config.services).toContain('workspaceRegistry')
  })

  it('accepts a deployment-specific service list', () => {
    const config = Config({ services: ['workspaceRegistry'] })
    expect(config.services).toEqual(['workspaceRegistry'])
  })

  it('keeps a retry policy that backs off but does not give up', () => {
    const config = Config({})
    expect(config.reconnect.baseMs).toBeGreaterThan(0)
    expect(config.reconnect.maxMs).toBeGreaterThan(config.reconnect.baseMs)
    expect(config.reconnect.heartbeatMs).toBeGreaterThan(0)
  })

  it('does not log every event by default', () => {
    expect(Config({}).logEvents).toBe(false)
  })
})
