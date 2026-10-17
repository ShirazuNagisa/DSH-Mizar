package me.shirazu.mizar.kit

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.TimeUnit

/**
 * A socket, behind an interface.
 *
 * The connection layer is tested against a scripted transport, so the state machine
 * — which is where the expensive mistakes live — needs no network and no emulator.
 */
interface WebSocketTransport {

    /** Open the socket, or throw. */
    suspend fun connect(url: String)

    /** Send one text frame, or throw `SOCKET_CLOSED`. */
    suspend fun send(text: String)

    /** The next text frame, or `null` once the peer has gone. */
    suspend fun receive(): String?

    /** Close, without waiting to be polite about it. */
    suspend fun close()
}

/**
 * The real transport.
 *
 * Two settings carry the protocol rather than the HTTP library:
 *
 *  - **`pingInterval` must be shorter than the host's heartbeat.** The host pings
 *    every 15 s and drops a socket after 20 s without a pong, so a client that does
 *    not answer pings is disconnected every ~30 s. OkHttp answers pings at the
 *    protocol level and this interval keeps its own liveness check in step.
 *  - **`retryOnConnectionFailure(false)`.** A silent retry of `POST /pair` would
 *    spend a second attempt on a single-use pairing code, and the operator would be
 *    told their code was wrong.
 */
class OkHttpWebSocketTransport(
    private val client: OkHttpClient = defaultClient(),
    private val handshakeTimeoutMillis: Long = 20_000,
) : WebSocketTransport {

    private var socket: WebSocket? = null
    private var inbox = Channel<String?>(Channel.UNLIMITED)

    override suspend fun connect(url: String) {
        inbox = Channel(Channel.UNLIMITED)
        val opened = CompletableDeferred<Unit>()
        val request = Request.Builder().url(url).build()

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                opened.complete(Unit)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                inbox.trySend(text)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                inbox.close()
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                inbox.close()
            }

            override fun onFailure(webSocket: WebSocket, failure: Throwable, response: Response?) {
                if (!opened.isCompleted) opened.completeExceptionally(failure)
                inbox.close()
            }
        }

        socket = client.newWebSocket(request, listener)
        try {
            withTimeout(handshakeTimeoutMillis) { opened.await() }
        } catch (error: Throwable) {
            socket?.cancel()
            socket = null
            throw error
        }
    }

    override suspend fun send(text: String) {
        val current = socket ?: throw MizarError("SOCKET_CLOSED", "the socket is not open", retryable = true)
        if (!current.send(text)) {
            throw MizarError("SOCKET_CLOSED", "the socket refused the frame", retryable = true)
        }
    }

    override suspend fun receive(): String? = inbox.receiveCatching().getOrNull()

    override suspend fun close() {
        val current = socket
        socket = null
        inbox.close()
        current?.close(1000, null)
    }

    companion object {
        /** The client every real transport shares. */
        fun defaultClient(): OkHttpClient = OkHttpClient.Builder()
            .pingInterval(15, TimeUnit.SECONDS)
            .connectTimeout(20, TimeUnit.SECONDS)
            // A WebSocket is idle by design between frames; liveness is the ping's
            // job, not a read timeout's.
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .callTimeout(0, TimeUnit.MILLISECONDS)
            .retryOnConnectionFailure(false)
            .build()
    }
}
