#!/usr/bin/env node
/**
 * A stand-in for the AGI Mizar desktop app.
 *
 * Writes a real endpoint file, accepts the plugin's handshake, prints every frame
 * it receives, and forwards anything typed on stdin to the plugin. Enough to
 * develop and smoke-test the link without building the desktop first.
 *
 *   node scripts/fake-desktop.mjs [port]
 *
 * Then restart DSH. The plugin will find the endpoint file and connect.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import { WebSocketServer } from 'ws'

const port = Number(process.argv[2] ?? 19_500)
const token = randomBytes(24).toString('hex')
const endpointFile = join(homedir(), '.agi-mizar', 'endpoint.json')

mkdirSync(dirname(endpointFile), { recursive: true, mode: 0o700 })
writeFileSync(endpointFile, `${JSON.stringify({ port, token, pid: process.pid }, null, 2)}\n`, {
  mode: 0o600,
})

const server = new WebSocketServer({ port, path: '/dsh' })
let peer = null
let nextId = 0

server.on('connection', (socket) => {
  console.log(`[fake-desktop] plugin connected`)
  peer = socket

  socket.on('message', (data) => {
    let frame
    try {
      frame = JSON.parse(data.toString())
    } catch {
      console.log('[fake-desktop] non-JSON frame ignored')
      return
    }

    if (frame.type === 'hello') {
      if (frame.token !== token) {
        console.log('[fake-desktop] hello with a wrong token — closing')
        socket.close(4401, 'bad token')
        return
      }
      console.log(
        `[fake-desktop] hello: plugin ${frame.plugin?.version}, dsh ${frame.dsh?.platform} ` +
          `${frame.dsh?.node}, ${frame.endpoints?.length ?? 0} endpoints`,
      )
      socket.send(
        JSON.stringify({ v: 1, type: 'welcome', linkVersion: 1, desktop: 'fake-desktop 0.0.0' }),
      )
      return
    }

    if (frame.type === 'event') {
      const payload = frame.payload ?? {}
      const detail =
        frame.name === 'session/event'
          ? (payload.event?.type ?? '?')
          : `${payload.key ?? '?'}`
      console.log(`[fake-desktop] #${frame.seq} ${frame.name} ${detail} ${frame.sessionId ?? '-'}`)
      return
    }

    console.log(`[fake-desktop] ${frame.type} ${JSON.stringify(frame).slice(0, 400)}`)
  })

  socket.on('close', (code) => {
    console.log(`[fake-desktop] plugin disconnected (${code})`)
    if (peer === socket) peer = null
  })
})

server.on('listening', () => {
  console.log(`[fake-desktop] listening on ws://127.0.0.1:${port}/dsh`)
  console.log(`[fake-desktop] endpoint file: ${endpointFile}`)
  console.log('[fake-desktop] type JSON on stdin to send a frame; `invoke <endpoint>` to call one')
})

// Type a frame on stdin to send it. `invoke session/list` builds the frame.
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const text = line.trim()
  if (text === '' || peer === null) return

  let frame
  if (text.startsWith('invoke ')) {
    const endpoint = text.slice('invoke '.length).trim()
    frame = { v: 1, type: 'invoke', id: `c${(nextId += 1)}`, endpoint, args: {}, mode: 'unary' }
  } else {
    try {
      frame = JSON.parse(text)
    } catch {
      console.log('[fake-desktop] that line is neither JSON nor `invoke <endpoint>`')
      return
    }
  }
  peer.send(JSON.stringify(frame))
  console.log(`[fake-desktop] → ${JSON.stringify(frame).slice(0, 200)}`)
})

process.on('SIGINT', () => {
  server.close()
  process.exit(0)
})
