package me.shirazu.mizar.kit

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import org.junit.jupiter.api.Test
import kotlin.test.*

/**
 * The wire contract.
 *
 * The cases that matter most are the tolerant ones: a host newer than this build must
 * not be able to break the socket, and a failure the app does not recognise must still
 * be classifiable. Ported from `FrameTests.swift`, whose four suites — server frames,
 * client frames, `MizarError` and the JSON reader — are the sections below.
 */
class FramesTest {

    /** Read a frame the way the socket loop does, failing the test when it will not read. */
    private fun decode(text: String): ServerFrame = when (val decoded = Frames.decodeServer(text)) {
        is FrameDecode.Decoded -> decoded.frame
        is FrameDecode.VersionMismatch -> fail("expected a readable frame, got a version mismatch: ${decoded.seen}")
        FrameDecode.Malformed -> fail("expected a readable frame, got malformed text: $text")
    }

    /** Read encoder output back as an object, the way the Swift test re-decoded it. */
    private fun membersOf(text: String): JsonObject =
        WIRE_JSON.parseToJsonElement(text) as? JsonObject ?: fail("expected a JSON object, got: $text")

    // MARK: - Server frames

    @Test
    fun `decodes a welcome`() {
        val welcome = assertIs<ServerFrame.Welcome>(
            decode(welcomeFrame(hostId = "h1", hostName = "studio")),
        )
        assertEquals("h1", welcome.hostId)
        assertEquals("studio", welcome.hostName)
        assertEquals(MIZAR_PROTOCOL_VERSION, welcome.protocolVersion)
        assertEquals("device-1", welcome.deviceId)
    }

    @Test
    fun `decodes an ok frame with and without a result`() {
        val ok = assertIs<ServerFrame.Ok>(decode(okFrame(id = "r1", result = jsonObjectOf("a" to jsonInt(1)))))
        assertEquals("r1", ok.id)
        assertEquals(1, ok.result["a"].intValue())

        val bare = assertIs<ServerFrame.Ok>(decode(okFrame(id = "r2")))
        assertEquals("r2", bare.id)
        assertNull(bare.result)
    }

    @Test
    fun `decodes an error with and without a correlation id`() {
        val failure = assertIs<ServerFrame.Failure>(decode(errorFrame(code = "WRITER_HELD", id = "r1")))
        assertEquals("WRITER_HELD", failure.error.code)
        assertEquals(MizarErrorCode.WRITER_HELD, failure.error.known)
        assertEquals("r1", failure.id)

        val unsolicited = assertIs<ServerFrame.Failure>(decode(errorFrame(code = "INTERNAL")))
        assertNull(unsolicited.id)
    }

    @Test
    fun `decodes an event`() {
        val event = assertIs<ServerFrame.Event>(
            decode(eventFrame(name = "approval.request", data = jsonObjectOf("requestId" to jsonString("ap-1")))),
        )
        assertEquals("approval.request", event.name)
        assertEquals("ap-1", event.data["requestId"].stringValue())
    }

    @Test
    fun `preserves a frame type it does not know instead of failing`() {
        // A host newer than this build must not make the socket unparseable.
        val text = serverFrame(
            "v" to jsonInt(MIZAR_PROTOCOL_VERSION),
            "type" to jsonString("something.new"),
            "payload" to jsonString("kept"),
        )
        val unknown = assertIs<ServerFrame.Unknown>(decode(text))
        assertEquals("something.new", unknown.type)
        assertEquals("kept", unknown.payload["payload"].stringValue())
    }

    @Test
    fun `rejects a frame from an incompatible protocol version`() {
        val text = serverFrame(
            "v" to jsonInt(2),
            "type" to jsonString("ok"),
            "id" to jsonString("r1"),
        )
        // Swift threw a `MizarError` from its decoder here. The Kotlin reader reports
        // the same condition as its own outcome — `VersionMismatch`, which the socket
        // loop treats as fatal — so the assertion moves from the throw to the case.
        assertIs<FrameDecode.VersionMismatch>(Frames.decodeServer(text))
    }

    @Test
    fun `reports the correlation id only where one exists`() {
        assertEquals("r1", decode(okFrame(id = "r1")).correlationId)
        assertEquals("r2", decode(errorFrame(code = "INTERNAL", id = "r2")).correlationId)
        assertNull(decode(welcomeFrame()).correlationId)
        assertNull(decode(eventFrame(name = "x")).correlationId)
    }

    // MARK: - Client frames

    @Test
    fun `encodes hello with its optional metadata`() {
        val members = membersOf(
            Frames.encodeHello(token = "mz_x", appVersion = "0.1.0", deviceModel = "iPhone 18 Pro"),
        )
        assertEquals(MIZAR_PROTOCOL_VERSION, members["v"].intValue())
        assertEquals("hello", members["type"].stringValue())
        assertEquals("mz_x", members["token"].stringValue())
        assertEquals("0.1.0", members["appVersion"].stringValue())
        assertEquals("iPhone 18 Pro", members["deviceModel"].stringValue())
        assertEquals(MIZAR_PROTOCOL_VERSION, members["protocolVersion"].intValue())
    }

    @Test
    fun `omits absent hello metadata rather than sending null`() {
        val members = membersOf(Frames.encodeHello(token = "mz_x"))
        assertNull(members["appVersion"])
        assertNull(members["deviceModel"])
        assertNull(members["id"])
    }

    @Test
    fun `encodes a request with and without a payload`() {
        val withPayload = membersOf(
            Frames.encodeRequest(type = "session.stats", id = "r1", payload = jsonObjectOf("sessionId" to jsonString("s1"))),
        )
        assertEquals("r1", withPayload["id"].stringValue())
        assertEquals("session.stats", withPayload["type"].stringValue())
        assertEquals("s1", withPayload["payload"]["sessionId"].stringValue())

        val bare = membersOf(Frames.encodeRequest(type = "ping", id = "r2"))
        assertEquals("r2", bare["id"].stringValue())
        assertNull(bare["payload"])
    }

    // MARK: - MizarError

    @Test
    fun `recognises the codes this build knows`() {
        assertEquals(MizarErrorCode.WRITER_HELD, MizarError(code = "WRITER_HELD", message = "").known)
        assertEquals(MizarErrorCode.MODEL_UNAVAILABLE, MizarError(code = "MODEL_UNAVAILABLE", message = "").known)
        assertEquals(MizarErrorCode.INTERNAL, MizarError(code = "INTERNAL", message = "").known)
    }

    @Test
    fun `keeps a code from a newer host without claiming to know it`() {
        // Classifying an unknown code as a decoding failure would make a newer host
        // unusable rather than merely less helpful.
        val error = MizarError(code = "SOMETHING_NEW", message = "from the future")
        assertNull(error.known)
        assertEquals("SOMETHING_NEW", error.code)
        assertEquals("from the future", error.message)
    }

    @Test
    fun `tells the app when repairing is the only way forward`() {
        assertTrue(MizarError(code = "UNAUTHENTICATED", message = "").requiresRepairing)
        assertTrue(MizarError(code = "DEVICE_REVOKED", message = "").requiresRepairing)
        // A busy session is retryable and must not send the operator back to pairing.
        assertFalse(MizarError(code = "WRITER_HELD", message = "").requiresRepairing)
        assertFalse(MizarError(code = "REQUEST_TIMEOUT", message = "").requiresRepairing)
    }

    // MARK: - JSONValue

    @Test
    fun `chained reads are safe at every step`() {
        val value = jsonObjectOf("a" to jsonObjectOf("b" to jsonObjectOf("c" to jsonString("found"))))
        assertEquals("found", value["a"]["b"]["c"].stringValue())
        // Any missing link yields null instead of throwing.
        assertNull(value["a"]["missing"]["c"])
        assertNull(value["nope"]["b"])
        // Indexing a non-object is null, not a crash.
        assertNull(jsonString("x")["a"])
    }

    /** The Swift test's `Row`: a typed model the reader has to produce from raw JSON. */
    @Serializable
    private data class Row(val sessionId: String, val running: Boolean)

    @Test
    fun `round-trips into a typed model`() {
        val value = jsonObjectOf("sessionId" to jsonString("s1"), "running" to jsonBool(true))
        // Swift went through its own `decoded(as:)`; the Kotlin path is `kotlinx`'s
        // serializer, and what the test pins is that a decoded subtree is still
        // decodable into a typed model.
        val row = WIRE_JSON.decodeFromJsonElement<Row>(value)
        assertEquals("s1", row.sessionId)
        assertTrue(row.running)
    }

    @Test
    fun `distinguishes an integral number from a fractional one`() {
        assertEquals(3, jsonInt(3).intValue())
        assertNull(JsonPrimitive(3.5).intValue())
        assertNull(jsonString("3").intValue())
    }
}
