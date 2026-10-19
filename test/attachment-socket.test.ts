/** Real authenticated WebSocket transport with an isolated fake DSH boundary; no live profile. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { Context } from '../src/dsh.js'
import { MizarStore } from '../src/auth/store.js'
import { AttachmentBridge } from '../src/attachments/bridge.js'
import { UploadStore } from '../src/attachments/store.js'
import { createMethodTable } from '../src/bridge/index.js'
import { InteractionBroker } from '../src/bridge/interactions.js'
import { MizarListener } from '../src/server/listener.js'

let root: string, listener: MizarListener, bridge: AttachmentBridge
let prompts: any[], files: Buffer[]
const sockets = new Set<WebSocket>()

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mizar-attachment-socket-'))
  const store = await MizarStore.open(join(root, 'state'))
  prompts = []; files = []
  const ctx = {
    effect: () => () => {},
    typertGateway: { invoke: async (request: any) => { prompts.push(request.args.request); return { accepted: true } } },
    fileUploads: { uploadStream: async (request: any) => {
      const chunks: Buffer[] = []
      for await (const chunk of request.data) chunks.push(Buffer.from(chunk))
      files.push(Buffer.concat(chunks))
      return { receiptId: 'internal-receipt', file: { attachmentId: 'durable-file' } }
    } },
  } as unknown as Context
  bridge = new AttachmentBridge(ctx, await UploadStore.open({ parent: root }))
  const methods = createMethodTable(ctx, { hostId: 'isolated', hostName: 'isolated', home: root, protocolVersion: 1 }, new InteractionBroker(), undefined, undefined, bridge)
  listener = await MizarListener.start({
    plan: { addresses: ['127.0.0.1'], mode: 'addresses', fellBack: false, reason: 'isolated test' },
    port: 0, portFallback: false, store, pairingTtlSeconds: 300, maxAttemptsPerMinute: 30,
    heartbeatMs: 15000, pongTimeoutMs: 20000, log: () => {}, methods,
  })
})
afterEach(async () => {
  for (const socket of sockets) socket.terminate()
  sockets.clear()
  await listener?.stop()
  await bridge?.dispose()
  await rm(root, { recursive: true, force: true })
})
async function pair() {
  const code = await listener.issuePairingCode()
  const response = await fetch(`http://127.0.0.1:${listener.port}/mizar/v1/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code.display, deviceName: 'Attachment test' }),
  })
  return (await response.json()) as { deviceToken: string; deviceId: string }
}
async function connect(token?: string) {
  const socket = new WebSocket(`ws://127.0.0.1:${listener.port}/mizar/v1/ws`)
  sockets.add(socket)
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  if (token) {
    const response = exchange(socket, { v: 1, type: 'hello', token })
    expect((await response).type).toBe('welcome')
  }
  return socket
}
function exchange(socket: WebSocket, request: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); reject(new Error('socket response timeout')) }, 5000)
    const cleanup = () => { clearTimeout(timer); socket.off('message', got); socket.off('error', failed) }
    const got = (bytes: WebSocket.RawData) => { cleanup(); resolve(JSON.parse(bytes.toString())) }
    const failed = (error: Error) => { cleanup(); reject(error) }
    socket.once('message', got); socket.once('error', failed)
    socket.send(JSON.stringify(request))
  })
}
function call(socket: WebSocket, type: string, payload: unknown = {}) { return exchange(socket, { v: 1, id: randomUUID(), type, payload }) }

it('refuses all attachment calls before hello and introduces no public upload HTTP route', async () => {
  const socket = await connect()
  for (const method of ['attachment.capabilities', 'attachment.begin', 'attachment.chunk', 'attachment.finish', 'attachment.abort']) {
    expect(await call(socket, method)).toMatchObject({ type: 'error', code: 'UNAUTHENTICATED' })
  }
  const http = await fetch(`http://127.0.0.1:${listener.port}/mizar/v1/attachment`, { method: 'POST', body: 'anything' })
  expect(http.status).toBe(404)
  expect(files).toEqual([])
})
it('uploads over real authenticated sockets, survives reconnect, submits once and isolates devices', async () => {
  const first = await pair(), foreign = await pair()
  const socket = await connect(first.deviceToken), stranger = await connect(foreign.deviceToken)
  expect(await call(socket, 'attachment.capabilities')).toMatchObject({ type: 'ok', result: { chunkBytes: 65536, maxAttachments: 5 } })
  const data = Buffer.alloc(70 * 1024, 79)
  const begun = await call(socket, 'attachment.begin', { sessionId: 'target', kind: 'file', name: 'report.txt', bytes: data.length, sha256: createHash('sha256').update(data).digest('hex') })
  expect(begun.type).toBe('ok')
  const uploadId = begun.result.uploadId
  const firstChunk = { uploadId, offset: 0, data: data.subarray(0, 65536).toString('base64') }
  expect(await call(socket, 'attachment.chunk', firstChunk)).toMatchObject({ type: 'ok', result: { offset: 65536 } })
  socket.terminate()
  const reconnected = await connect(first.deviceToken)
  expect(await call(reconnected, 'attachment.chunk', firstChunk)).toMatchObject({ type: 'ok', result: { offset: 65536 } })
  expect(await call(stranger, 'attachment.abort', { uploadId })).toMatchObject({ type: 'error', code: 'UPLOAD_NOT_FOUND' })
  expect(await call(reconnected, 'attachment.chunk', { uploadId, offset: 65536, data: data.subarray(65536).toString('base64') })).toMatchObject({ type: 'ok', result: { offset: data.length } })
  const finished = await call(reconnected, 'attachment.finish', { uploadId })
  expect(finished).toMatchObject({ type: 'ok', result: { name: 'report.txt', kind: 'file', bytes: data.length } })
  const attachmentId = finished.result.attachmentId
  expect((await call(reconnected, 'attachment.finish', { uploadId })).result.attachmentId).toBe(attachmentId)
  const attached = { sessionId: 'target', text: '', requestId: 'stable', attachments: [attachmentId] }
  expect(await call(stranger, 'session.prompt', { ...attached, requestId: 'foreign' })).toMatchObject({ type: 'error', code: 'ATTACHMENT_INVALID' })
  expect(await call(reconnected, 'session.prompt', attached)).toMatchObject({ type: 'ok', result: { accepted: true, requestId: 'stable' } })
  expect(await call(reconnected, 'session.prompt', attached)).toMatchObject({ type: 'ok', result: { accepted: true, requestId: 'stable' } })
  expect(files).toEqual([data])
  expect(prompts).toEqual([{ sessionId: 'target', requestId: 'stable', mode: 'queue', content: [{ type: 'file', receiptId: 'internal-receipt' }] }])
  expect(await call(reconnected, 'session.prompt', { ...attached, text: 'changed' })).toMatchObject({ type: 'error', code: 'ATTACHMENT_INVALID' })
  expect(await call(reconnected, 'attachment.abort', { uploadId })).toMatchObject({ type: 'ok', result: { aborted: true } })
})
it('enforces inbound frame bound before untrusted JSON/base64 can allocate an unbounded buffer', async () => {
  const { deviceToken } = await pair()
  const socket = await connect(deviceToken)
  const closed = new Promise<number>((resolve) => { socket.once('close', resolve) })
  socket.send('x'.repeat(600 * 1024))
  expect(await closed).toBe(1009)
  expect(files).toEqual([])
})
it('revocation disconnects the attached device before more chunks can be sent', async () => {
  const { deviceToken, deviceId } = await pair()
  const socket = await connect(deviceToken)
  const closed = new Promise<number>((resolve) => { socket.once('close', resolve) })
  await listener.revokeDevice(deviceId)
  expect(await closed).toBe(4401)
})
