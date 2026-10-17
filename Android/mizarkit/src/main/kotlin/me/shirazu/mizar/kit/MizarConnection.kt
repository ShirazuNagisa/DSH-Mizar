package me.shirazu.mizar.kit

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.serializer
import java.util.UUID

/**
 * One authenticated connection to a host.
 *
 * The handshake, the correlated calls and the pushed events, with the failure
 * behaviour an operator actually meets: a dropped socket fails everything in flight
 * with a *retryable* error rather than hanging, and a version mismatch is the one
 * decode failure that closes the connection instead of being skipped.
 */
class MizarConnection(
    private val configuration: Configuration,
    private val makeTransport: () -> WebSocketTransport = { OkHttpWebSocketTransport() },
) {

    /**
     * Where to dial and who to be.
     *
     * @property authority `host:port` for a direct connection.
     * @property baseUrl a relay base URL (`https://relay/r/ROOM`) instead.
     * @property token the device token from pairing.
     * @property secure whether a direct connection speaks `wss`.
     */
    data class Configuration(
        val authority: String? = null,
        val baseUrl: String? = null,
        val token: String,
        val secure: Boolean = false,
        val appVersion: String? = null,
        val deviceModel: String? = null,
        val requestTimeoutMillis: Long = 60_000,
        val handshakeTimeoutMillis: Long = 20_000,
    ) {
        /** Direct first: one QR code covers "same Wi-Fi" and "anywhere". */
        val endpoint: Endpoint?
            get() = when {
                !authority.isNullOrBlank() -> Endpoint.Direct(authority)
                !baseUrl.isNullOrBlank() && PairingUri.isUsableBaseUrl(baseUrl) -> Endpoint.Relay(baseUrl)
                else -> null
            }
    }

    /** A direct authority or a relay base. */
    sealed interface Endpoint {
        data class Direct(val authority: String) : Endpoint
        data class Relay(val baseUrl: String) : Endpoint
    }

    /** Where the connection is. `Failed` is not terminal: reconnecting leaves it. */
    sealed interface State {
        data object Idle : State
        data object Connecting : State
        data class Ready(val welcome: ServerFrame.Welcome) : State
        data class Failed(val message: String) : State
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private var transport: WebSocketTransport? = null
    private var readJob: Job? = null
    private val pending = LinkedHashMap<String, CompletableDeferred<JsonElement?>>()
    private var handshake: CompletableDeferred<ServerFrame.Welcome>? = null
    private val subscribers = LinkedHashMap<String, Channel<ServerFrame>>()

    private val _state = MutableStateFlow<State>(State.Idle)

    /** Observable, for a UI that wants to draw the connection's state. */
    val state: StateFlow<State> = _state

    /** The host's identity, once the handshake has completed. */
    val welcome: ServerFrame.Welcome? get() = (_state.value as? State.Ready)?.welcome

    /**
     * Pushed frames, for one collector.
     *
     * A fresh flow per call, which **completes when the socket closes** — the
     * subscribers are finished on every close path, so a caller looping over this
     * sees the end of the connection rather than a silent stall.
     */
    fun events(): Flow<ServerFrame> = flow {
        val id = UUID.randomUUID().toString()
        val channel = Channel<ServerFrame>(Channel.UNLIMITED)
        subscribers[id] = channel
        try {
            for (frame in channel) emit(frame)
        } finally {
            subscribers.remove(id)
            channel.close()
        }
    }

    /**
     * Complete the handshake.
     *
     * Idempotent when already connected: a caller that reconnects on a timer should
     * not have to ask whether it already is.
     */
    suspend fun connect(): ServerFrame.Welcome {
        (_state.value as? State.Ready)?.let { return it.welcome }

        val endpoint = configuration.endpoint
            ?: throw failAndReturn("BAD_AUTHORITY", "there is no address to dial")

        val url = when (endpoint) {
            is Endpoint.Direct -> PairingUri.webSocketUrl(endpoint.authority, configuration.secure)
            is Endpoint.Relay -> PairingUri.relayWebSocketUrl(endpoint.baseUrl)
        } ?: throw failAndReturn("BAD_AUTHORITY", "cannot dial ${endpoint.describe()}")

        _state.value = State.Connecting
        val socket = makeTransport()
        transport = socket

        try {
            socket.connect(url)
        } catch (error: Throwable) {
            transport = null
            _state.value = State.Failed(describe(error))
            throw error
        }

        // Reading starts *before* the hello is sent: the welcome can beat the send,
        // and a socket with no reader loses it.
        startReading(socket)

        val awaiting = CompletableDeferred<ServerFrame.Welcome>()
        handshake = awaiting

        try {
            socket.send(
                Frames.encodeHello(
                    token = configuration.token,
                    appVersion = configuration.appVersion,
                    deviceModel = configuration.deviceModel,
                ),
            )
        } catch (error: Throwable) {
            closeSocket("the handshake could not be sent")
            throw error
        }

        return try {
            withTimeout(configuration.handshakeTimeoutMillis) { awaiting.await() }
        } catch (_: TimeoutCancellationException) {
            val message = "the host did not answer the handshake in time"
            closeSocket(message)
            throw MizarError("REQUEST_TIMEOUT", message, retryable = true)
        }
    }

    /** Connect, retrying on the schedule until it works or the caller is cancelled. */
    suspend fun connectWithRetry(backoff: Backoff = Backoff.standard): ServerFrame.Welcome {
        while (true) {
            try {
                return connect()
            } catch (cancelled: CancellationException) {
                // Cancellation is the caller's decision, not a connection failure to
                // retry: swallowing it here would make a cancelled screen reconnect
                // forever.
                throw cancelled
            } catch (_: Throwable) {
                delay((backoff.nextDelay() * 1000).toLong())
            }
        }
    }

    /**
     * One method call.
     *
     * @param type the method name.
     * @param payload the arguments, omitted entirely when `null`.
     * @returns whatever the host answered, or throws [MizarError].
     */
    suspend fun request(type: String, payload: JsonElement? = null): JsonElement? {
        val socket = transport
            ?: throw MizarError("NO_CONNECTION", "there is no connection to the host", retryable = true)

        val id = UUID.randomUUID().toString().uppercase()
        val awaiting = CompletableDeferred<JsonElement?>()
        pending[id] = awaiting

        try {
            socket.send(Frames.encodeRequest(type, id, payload))
        } catch (_: Throwable) {
            pending.remove(id)
            throw MizarError("SOCKET_CLOSED", "the request could not be sent", retryable = true)
        }

        return try {
            withTimeout(configuration.requestTimeoutMillis) { awaiting.await() }
        } catch (_: TimeoutCancellationException) {
            pending.remove(id)
            throw MizarError("REQUEST_TIMEOUT", "$type did not answer in time", retryable = true)
        }
    }

    /**
     * One method call, decoded.
     *
     * A `null` result is an error rather than a default: a caller that asked for
     * stats and got nothing must not be handed a zeroed frame.
     */
    suspend inline fun <reified T> call(method: String, payload: JsonElement? = null): T {
        val result = request(method, payload)
        if (result == null || result is JsonNull) {
            throw MizarError("EMPTY_RESULT", "$method answered without a result")
        }
        return WIRE_JSON.decodeFromJsonElement(serializer<T>(), result)
    }

    /** Close, failing everything in flight. */
    suspend fun disconnect() {
        closeSocket("disconnected")
    }

    private fun startReading(socket: WebSocketTransport) {
        readJob = scope.launch {
            try {
                while (true) {
                    val text = socket.receive() ?: break
                    when (val decoded = Frames.decodeServer(text)) {
                        is FrameDecode.Decoded -> route(decoded.frame)
                        is FrameDecode.VersionMismatch -> {
                            val seen = decoded.seen
                            val message = "host speaks protocol version $seen, this build speaks $MIZAR_PROTOCOL_VERSION"
                            val error = MizarError(MizarErrorCode.PROTOCOL_VERSION_MISMATCH.wire, message)
                            closeSocket(message)
                            failAll(error)
                            return@launch
                        }

                        FrameDecode.Malformed -> continue
                    }
                }
                closeSocket("the host closed the connection")
            } catch (error: Throwable) {
                closeSocket(describe(error))
            }
        }
    }

    private fun route(frame: ServerFrame) {
        when (frame) {
            is ServerFrame.Welcome -> {
                _state.value = State.Ready(frame)
                handshake?.complete(frame)
                handshake = null
            }

            is ServerFrame.Ok -> pending.remove(frame.id)?.complete(frame.result)

            is ServerFrame.Failure -> {
                // An answer nobody is waiting for is a socket-level complaint, and
                // the operator is the only one who can act on it: it goes to the
                // subscribers rather than being dropped.
                val id = frame.id
                val waiting = if (id == null) null else pending.remove(id)
                if (waiting != null) waiting.completeExceptionally(frame.error) else publish(frame)
            }

            is ServerFrame.Event, is ServerFrame.Unknown -> publish(frame)
        }
    }

    private fun publish(frame: ServerFrame) {
        for (channel in subscribers.values) channel.trySend(frame)
    }

    private fun closeSocket(reason: String) {
        val socket = transport
        transport = null
        readJob?.cancel()
        readJob = null
        if (socket != null) scope.launch { socket.close() }
        handshake?.completeExceptionally(MizarError("CONNECTION_CLOSED", reason, retryable = true))
        handshake = null
        failAll(MizarError("CONNECTION_CLOSED", reason, retryable = true))
        for (channel in subscribers.values) channel.close()
        subscribers.clear()
        _state.value = State.Failed(reason)
    }

    private fun failAll(error: MizarError) {
        val waiting = pending.values.toList()
        pending.clear()
        for (deferred in waiting) deferred.completeExceptionally(error)
    }

    private fun failAndReturn(code: String, message: String): MizarError {
        _state.value = State.Failed(message)
        return MizarError(code, message)
    }

    private fun Endpoint.describe(): String = when (this) {
        is Endpoint.Direct -> authority
        is Endpoint.Relay -> baseUrl
    }

    private fun describe(error: Throwable): String =
        error.message?.takeIf { it.isNotBlank() } ?: error::class.simpleName ?: "the connection failed"
}
