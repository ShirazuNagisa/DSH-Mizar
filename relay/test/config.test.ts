/**
 * Relay configuration, and the FCM half of it in particular.
 *
 * The failure this guards against is the one that takes the tunnel down with it:
 * a relay that refuses to boot because a *notification* credential is missing or
 * malformed. Everything about push is optional, so every incomplete FCM
 * configuration has to mean `null` — and the service-account JSON has three
 * shapes it can arrive in, each of which is a chance to read the wrong field.
 *
 * @module dsh-mizar-relay/test/config
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'

let dir = ''
afterEach(async () => {
  if (dir !== '') await rm(dir, { recursive: true, force: true })
  dir = ''
})

/** A temporary directory to keep config files in. */
async function scratch(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), 'mizar-relay-config-'))
  return dir
}

/** A service-account JSON, as the Firebase console downloads it. */
function serviceAccount(privateKey = '-----BEGIN PRIVATE KEY-----\nMIIabc\n-----END PRIVATE KEY-----\n'): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: 'mizar-test',
    private_key_id: 'key-1',
    private_key: privateKey,
    client_email: 'relay@mizar-test.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  })
}

describe('the FCM configuration', () => {
  it('is null by default, and the rest of the config still loads', async () => {
    const home = await scratch()
    const config = loadConfig(join(home, 'relay.config.json'), {})
    // No file, no environment: everything else has a default and push is off.
    // A relay that refused to start here would be a relay that cannot run
    // without a notification credential it does not need.
    expect(config.fcm).toBeNull()
    expect(config.apns).toBeNull()
    expect(config.port).toBe(8787)
  })

  it('reads the three fields out of an inline service account', async () => {
    const home = await scratch()
    const path = join(home, 'relay.config.json')
    await writeFile(
      path,
      JSON.stringify({ fcm: { serviceAccount: serviceAccount(), channelId: 'mizar-alerts' } }),
      'utf8',
    )

    const config = loadConfig(path, {})
    expect(config.fcm).toMatchObject({
      projectId: 'mizar-test',
      clientEmail: 'relay@mizar-test.iam.gserviceaccount.com',
      channelId: 'mizar-alerts',
    })
    // The PEM arrives with real newlines, because JSON's `\n` is a newline.
    expect(config.fcm?.privateKey).toContain('\nMIIabc\n')
  })

  it('reads them out of a service-account file instead', async () => {
    const home = await scratch()
    const account = join(home, 'firebase.json')
    await writeFile(account, serviceAccount(), 'utf8')
    const path = join(home, 'relay.config.json')
    await writeFile(path, JSON.stringify({ fcm: { serviceAccountFile: account } }), 'utf8')

    expect(loadConfig(path, {}).fcm).toMatchObject({ projectId: 'mizar-test' })
  })

  it('takes the fields apart when there is no service account at all', async () => {
    const home = await scratch()
    const path = join(home, 'relay.config.json')
    await writeFile(
      path,
      JSON.stringify({
        fcm: {
          projectId: 'p',
          clientEmail: 'c@example.test',
          privateKey: '-----BEGIN PRIVATE KEY-----\\nMIIabc\\n-----END PRIVATE KEY-----\\n',
        },
      }),
      'utf8',
    )

    const config = loadConfig(path, {})
    expect(config.fcm).toMatchObject({ projectId: 'p', clientEmail: 'c@example.test' })
    // The `\n` unescaping, which is the whole reason a key pasted into an
    // environment variable is not a startup failure about PEM parsing.
    expect(config.fcm?.privateKey).toContain('\nMIIabc\n')
    // Unset rather than present-and-empty: `buildMessage` branches on absence.
    expect(config.fcm?.channelId).toBeUndefined()
    expect(config.fcm?.authority).toBeUndefined()
  })

  it('lets the environment override the file, field by field', async () => {
    const home = await scratch()
    const path = join(home, 'relay.config.json')
    await writeFile(
      path,
      JSON.stringify({ fcm: { serviceAccount: serviceAccount(), channelId: 'from-file' } }),
      'utf8',
    )

    const config = loadConfig(path, {
      MIZAR_FCM_PROJECT_ID: 'from-env',
      MIZAR_FCM_CHANNEL_ID: 'from-env',
    })
    expect(config.fcm).toMatchObject({ projectId: 'from-env', channelId: 'from-env' })
    expect(config.fcm?.clientEmail).toBe('relay@mizar-test.iam.gserviceaccount.com')
  })

  it('is null rather than fatal when the credential is unusable', async () => {
    const home = await scratch()
    for (const fcm of [
      // A file that is not there.
      { serviceAccountFile: join(home, 'missing.json') },
      // A file that is not JSON.
      { serviceAccount: 'not json at all' },
      // A JSON body with no private key, which cannot sign anything.
      { serviceAccount: JSON.stringify({ project_id: 'p', client_email: 'c' }) },
      // The fields, one of them missing.
      { projectId: 'p', clientEmail: 'c@example.test' },
    ]) {
      const path = join(home, `relay-${Math.random().toString(36).slice(2)}.json`)
      await writeFile(path, JSON.stringify({ fcm, port: 9000 }), 'utf8')
      const config = loadConfig(path, {})
      expect(config.fcm).toBeNull()
      // And the tunnel's own settings were read on the way past, which is the
      // point: a broken notification credential costs notifications and nothing
      // else.
      expect(config.port).toBe(9000)
    }
  })

  it('leaves APNs and FCM independent in both directions', async () => {
    const home = await scratch()
    const path = join(home, 'relay.config.json')
    await writeFile(
      path,
      JSON.stringify({
        apns: { keyId: 'K', teamId: 'T', topic: 'me.shirazu.dshmizar', key: 'unused' },
        fcm: { serviceAccount: serviceAccount() },
      }),
      'utf8',
    )

    const config = loadConfig(path, {})
    expect(config.apns).not.toBeNull()
    expect(config.fcm).not.toBeNull()
    // Neither key is required for the other to load, so a relay serving only
    // iPhones does not need a Google account and vice versa.
    expect(loadConfig(path, { MIZAR_FCM_SERVICE_ACCOUNT: 'broken' }).apns).not.toBeNull()
  })
})
