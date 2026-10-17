package me.shirazu.mizar.kit

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/**
 * The result of reading one frame off the socket.
 *
 * Three outcomes rather than two, because the protocol treats them differently:
 * a version mismatch is fatal (the socket is torn down), a malformed frame is
 * *dropped* (the read loop continues — a newer host may send a shape this build
 * does not know, and killing the connection over it would make every host upgrade
 * a disconnect), and anything readable is routed.
 */
sealed interface FrameDecode {
    /** Readable. */
    data class Decoded(val frame: ServerFrame) : FrameDecode

    /** `v` was present and was not this build's version: the socket must close. */
    data class VersionMismatch(val seen: JsonElement?) : FrameDecode

    /** Unreadable, including a missing `v`: dropped, not fatal. */
    data object Malformed : FrameDecode
}

/**
 * A frame from the host.
 *
 * `Unknown` keeps the **whole** frame — including `v` and `type` — rather than
 * just its payload, because that is what the frame *is* to a client that has never
 * heard of the type, and a subscriber that logs it should see what arrived.
 */
sealed interface ServerFrame {
    /** The id this frame answers, when it answers one. */
    val correlationId: String?

    data class Welcome(
        val hostId: String,
        val hostName: String,
        val protocolVersion: Int,
        val home: String,
        val deviceId: String,
    ) : ServerFrame {
        override val correlationId: String? get() = null
    }

    data class Ok(val id: String, val result: JsonElement?) : ServerFrame {
        override val correlationId: String? get() = id
    }

    data class Failure(val error: MizarError, val id: String?) : ServerFrame {
        override val correlationId: String? get() = id
    }

    data class Event(val name: String, val data: JsonElement) : ServerFrame {
        override val correlationId: String? get() = null
    }

    data class Unknown(val type: String, val payload: JsonElement) : ServerFrame {
        override val correlationId: String? get() = null
    }
}

/**
 * Wire framing: decoding what the host sends, encoding what this client sends.
 *
 * Hand-written over `JsonElement` rather than generated from `@Serializable`
 * classes, for one reason that keeps coming up: the host's frame union is
 * *extensible*, and only a hand-written reader can preserve a frame it does not
 * recognise instead of failing the whole decode.
 */
object Frames {

    /**
     * Read one server frame.
     *
     * @param text - the frame exactly as it arrived.
     * @returns what was read, or why it could not be.
     */
    fun decodeServer(text: String): FrameDecode {
        val root = try {
            WIRE_JSON.parseToJsonElement(text)
        } catch (_: Exception) {
            return FrameDecode.Malformed
        }
        val frame = root as? JsonObject ?: return FrameDecode.Malformed

        val version = frame["v"] ?: return FrameDecode.Malformed
        val versionNumber = version.intValue() ?: return FrameDecode.Malformed
        if (versionNumber != MIZAR_PROTOCOL_VERSION) return FrameDecode.VersionMismatch(version)

        val type = frame["type"].stringValue() ?: return FrameDecode.Malformed

        return when (type) {
            "welcome" -> {
                val hostId = frame["hostId"].stringValue() ?: return FrameDecode.Malformed
                val hostName = frame["hostName"].stringValue() ?: return FrameDecode.Malformed
                val protocolVersion = frame["protocolVersion"].intValue() ?: return FrameDecode.Malformed
                val home = frame["home"].stringValue() ?: return FrameDecode.Malformed
                val deviceId = frame["deviceId"].stringValue() ?: return FrameDecode.Malformed
                FrameDecode.Decoded(
                    ServerFrame.Welcome(hostId, hostName, protocolVersion, home, deviceId),
                )
            }

            "ok" -> {
                val id = frame["id"].stringValue() ?: return FrameDecode.Malformed
                FrameDecode.Decoded(ServerFrame.Ok(id, frame["result"]))
            }

            "error" -> {
                val code = frame["code"].stringValue() ?: return FrameDecode.Malformed
                val message = frame["message"].stringValue() ?: return FrameDecode.Malformed
                val retryable = frame["retryable"].boolValue() ?: false
                FrameDecode.Decoded(
                    ServerFrame.Failure(MizarError(code, message, retryable), frame["id"].stringValue()),
                )
            }

            "event" -> {
                val name = frame["event"].stringValue() ?: return FrameDecode.Malformed
                val data = frame["data"] ?: return FrameDecode.Malformed
                FrameDecode.Decoded(ServerFrame.Event(name, data))
            }

            else -> FrameDecode.Decoded(ServerFrame.Unknown(type, root))
        }
    }

    /**
     * The handshake frame.
     *
     * `id` is omitted when the caller has not asked for one, and the optional
     * metadata is omitted rather than sent as `null` — matching what the host's own
     * clients send, and what its `hello` handler's tolerance was written against.
     */
    fun encodeHello(
        token: String,
        appVersion: String? = null,
        deviceModel: String? = null,
        id: String? = null,
    ): String = buildJsonObject {
        put("v", JsonPrimitive(MIZAR_PROTOCOL_VERSION))
        put("type", JsonPrimitive("hello"))
        if (id != null) put("id", JsonPrimitive(id))
        put("token", JsonPrimitive(token))
        if (appVersion != null) put("appVersion", JsonPrimitive(appVersion))
        if (deviceModel != null) put("deviceModel", JsonPrimitive(deviceModel))
        put("protocolVersion", JsonPrimitive(MIZAR_PROTOCOL_VERSION))
    }.toString()

    /** A method call, with the id the host's answer must carry back. */
    fun encodeRequest(type: String, id: String, payload: JsonElement? = null): String =
        buildJsonObject {
            put("v", JsonPrimitive(MIZAR_PROTOCOL_VERSION))
            put("type", JsonPrimitive(type))
            put("id", JsonPrimitive(id))
            if (payload != null) put("payload", payload)
        }.toString()
}

/** `GET /mizar/v1/hello` — the unauthenticated "is anything there" answer. */
@Serializable
data class HelloResponse(
    val hostId: String,
    val hostName: String,
    val protocolVersion: Int,
    val pairingOpen: Boolean,
    val paired: Boolean,
)

/**
 * `POST /mizar/v1/pair`.
 *
 * `protocolVersion` is always sent: it is how a host tells an outdated app apart
 * from a wrong code, and the host has no other way to know.
 */
@Serializable
data class PairRequest(
    val code: String,
    val deviceName: String? = null,
    val deviceModel: String? = null,
    val appVersion: String? = null,
    val protocolVersion: Int = MIZAR_PROTOCOL_VERSION,
)

/** The answer to a successful pairing: the credential, and who it belongs to. */
@Serializable
data class PairResponse(
    val deviceToken: String,
    val deviceId: String,
    val hostId: String,
    val hostName: String,
    val protocolVersion: Int,
)

/** The body a non-200 pairing answer carries, when it carries one. */
@Serializable
data class PairErrorBody(@SerialName("error") val error: String? = null)
