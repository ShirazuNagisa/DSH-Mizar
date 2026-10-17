package me.shirazu.mizar.kit

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/** An HTTP exchange, small enough that a test can stand in for it. */
data class HttpRequest(
    val method: String,
    val url: String,
    val headers: Map<String, String> = emptyMap(),
    val body: String? = null,
)

/** What came back. */
data class HttpResponse(
    val status: Int,
    val body: String,
    val headers: Map<String, String> = emptyMap(),
)

/** Sending one request. */
interface HttpTransport {
    suspend fun send(request: HttpRequest): HttpResponse
}

/** The real one. */
class OkHttpHttpTransport(
    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .retryOnConnectionFailure(false)
        .build(),
) : HttpTransport {
    override suspend fun send(request: HttpRequest): HttpResponse = withContext(Dispatchers.IO) {
        val builder = Request.Builder().url(request.url)
        for ((name, value) in request.headers) builder.header(name, value)
        val body = request.body?.toRequestBody("application/json".toMediaType())
        builder.method(request.method, body)

        client.newCall(builder.build()).execute().use { response ->
            HttpResponse(
                status = response.code,
                body = response.body?.string() ?: "",
                headers = response.headers.names().associateWith { response.header(it) ?: "" },
            )
        }
    }
}

/**
 * The two unauthenticated exchanges: ask whether anything is there, then redeem a
 * pairing code.
 *
 * This is the only part of the protocol that speaks HTTP, and it is the part whose
 * failures an operator actually reads, so every status the host can answer with has
 * a sentence attached to it rather than a number.
 */
class PairingClient(
    private val transport: HttpTransport = OkHttpHttpTransport(),
    private val appVersion: String? = null,
) {

    /** `GET /mizar/v1/hello` — is this address a Mizar host, and is a code open? */
    suspend fun hello(authority: String? = null, baseUrl: String? = null): HelloResponse {
        val url = requireUrl(authority, baseUrl, MIZAR_HELLO_PATH)
        val response = send(HttpRequest(method = "GET", url = url, headers = mapOf("accept" to "application/json")))
        if (response.status != 200) {
            throw MizarError("HELLO_FAILED", describeStatus(response.status), retryable = response.status >= 500)
        }
        return try {
            WIRE_JSON.decodeFromString(HelloResponse.serializer(), response.body)
        } catch (_: Exception) {
            throw MizarError("MALFORMED_RESPONSE", "the host answered something this app could not read")
        }
    }

    /**
     * `POST /mizar/v1/pair` — trade the code for a device token.
     *
     * The code is single use and lives five minutes, so a failure here is worth
     * explaining precisely: "the code is no longer valid" and "there is nothing at
     * that address" send the operator to two different places.
     */
    suspend fun pair(
        code: String,
        deviceName: String? = null,
        deviceModel: String? = null,
        authority: String? = null,
        baseUrl: String? = null,
    ): PairedHost {
        val url = requireUrl(authority, baseUrl, MIZAR_PAIR_PATH)
        val body = WIRE_JSON.encodeToString(
            PairRequest.serializer(),
            PairRequest(code = code, deviceName = deviceName, deviceModel = deviceModel, appVersion = appVersion),
        )
        val response = send(
            HttpRequest(
                method = "POST",
                url = url,
                headers = mapOf("content-type" to "application/json", "accept" to "application/json"),
                body = body,
            ),
        )

        if (response.status != 200) throw pairFailure(response.status, response.body)

        val parsed = try {
            WIRE_JSON.decodeFromString(PairResponse.serializer(), response.body)
        } catch (_: Exception) {
            throw MizarError("MALFORMED_RESPONSE", "the host answered something this app could not read")
        }

        return PairedHost(
            hostId = parsed.hostId,
            hostName = parsed.hostName,
            authority = authority,
            baseUrl = baseUrl,
            deviceId = parsed.deviceId,
            deviceToken = parsed.deviceToken,
        )
    }

    private suspend fun send(request: HttpRequest): HttpResponse = try {
        transport.send(request)
    } catch (error: IOException) {
        throw error
    }

    /**
     * The URL for one step.
     *
     * Direct first: `h` is present when the host is on this network, and dialling it
     * is both faster and independent of somebody else's server.
     */
    private fun requireUrl(authority: String?, baseUrl: String?, path: String): String {
        val direct = authority?.takeIf { it.isNotBlank() }?.let { PairingUri.httpUrl(it, path) }
        if (direct != null) return direct

        val relay = baseUrl?.takeIf { it.isNotBlank() }?.let { PairingUri.relayHttpUrl(it, path) }
        if (relay != null) return relay

        val described = authority?.takeIf { it.isNotBlank() } ?: baseUrl.orEmpty()
        throw MizarError("BAD_AUTHORITY", "\"$described\" is not an address this app can dial")
    }

    /**
     * Turn a failed pairing into an explanation.
     *
     * Branching on the body's `error` code rather than the status: `410` is both
     * "expired" and "unknown", and the host deliberately does not tell a client which
     * of those a code it has never seen is.
     */
    private fun pairFailure(status: Int, body: String): MizarError {
        val reported = try {
            WIRE_JSON.decodeFromString(PairErrorBody.serializer(), body).error
        } catch (_: Exception) {
            null
        }
        val code = reported ?: "PAIRING_FAILED"
        val message = when (code) {
            "PAIRING_CODE_INVALID" -> "That pairing code is not right. Check the code shown on the host."
            "PAIRING_CODE_EXPIRED" -> "That pairing code has expired. Generate a new one on the host."
            "PAIRING_CODE_UNKNOWN" -> "That pairing code is no longer valid. Generate a new one on the host."
            "RATE_LIMITED" -> "Too many attempts. Wait a moment and try again."
            "MALFORMED_FRAME" -> "The host could not read the request. Check that the app is up to date."
            else -> describeStatus(status)
        }
        return MizarError(code, message, retryable = code == "RATE_LIMITED" || status >= 500)
    }

    /** What a status means, in words rather than digits. */
    private fun describeStatus(status: Int): String = when (status) {
        401 -> "The host refused the request."
        403 -> "The host refused the request because it did not come from a trusted address."
        404 -> "Nothing is listening at that address."
        405 -> "The host does not accept that request."
        410 -> "That pairing code is no longer valid. Generate a new one on the host."
        413 -> "The request was too large."
        429 -> "Too many attempts. Wait a moment and try again."
        else -> "The host answered with status $status."
    }
}

/** The JSON body of a pairing request, exposed for tests that assert its shape. */
fun pairRequestBody(request: PairRequest): JsonObject =
    WIRE_JSON.encodeToJsonElement(PairRequest.serializer(), request) as JsonObject
