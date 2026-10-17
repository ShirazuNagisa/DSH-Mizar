package me.shirazu.mizar.kit

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.decodeFromJsonElement
import java.io.File

/**
 * Shared scaffolding for the kit's tests.
 *
 * Ported from `TestSupport.swift`. The scripted `WebSocketTransport` stub is **not**
 * here: it exists to stand in for `URLSessionWebSocketTask`, which has no JVM twin in
 * this module, so the stub and its `eventually` helper would have nothing to drive.
 * What remains is the half the frame tests need — writing a server frame to *wire
 * text*, so the parser is fed bytes rather than objects, which is the only way to
 * test a decoder honestly.
 */

/** A server frame exactly as it would arrive on the socket. */
fun serverFrame(vararg members: Pair<String, JsonElement?>): String =
    jsonObjectOf(*members).toString()

/**
 * A `welcome` frame.
 *
 * `version` feeds both `v` and `protocolVersion`: they are separate keys on the wire,
 * and a test that moved one without the other would pin a host that cannot exist.
 */
fun welcomeFrame(
    hostId: String = "host-1",
    hostName: String = "mac",
    version: Int = MIZAR_PROTOCOL_VERSION,
): String = serverFrame(
    "v" to jsonInt(version),
    "type" to jsonString("welcome"),
    "hostId" to jsonString(hostId),
    "hostName" to jsonString(hostName),
    "protocolVersion" to jsonInt(version),
    "home" to jsonString("/home/dsh"),
    "deviceId" to jsonString("device-1"),
)

/**
 * An `ok` frame, carrying a result when the test asked for one.
 *
 * A `null` result is dropped rather than written as `"result": null`, which is what
 * the host does too — and what makes the "no result" case in the tests a real absent
 * key rather than an explicit null.
 */
fun okFrame(id: String, result: JsonElement? = null): String = serverFrame(
    "v" to jsonInt(MIZAR_PROTOCOL_VERSION),
    "type" to jsonString("ok"),
    "id" to jsonString(id),
    "result" to result,
)

/** An `error` frame. */
fun errorFrame(code: String, message: String = "nope", id: String? = null): String = serverFrame(
    "v" to jsonInt(MIZAR_PROTOCOL_VERSION),
    "type" to jsonString("error"),
    "code" to jsonString(code),
    "message" to jsonString(message),
    "retryable" to jsonBool(false),
    "id" to id?.let { jsonString(it) },
)

/** An unsolicited `event` frame. */
fun eventFrame(name: String, data: JsonElement = JsonNull): String = serverFrame(
    "v" to jsonInt(MIZAR_PROTOCOL_VERSION),
    "type" to jsonString("event"),
    "event" to jsonString(name),
    "data" to data,
)

/**
 * Decode a JSON value into a typed model.
 *
 * Swift spelled this `JSONValue.decoded(as:)`; the Kotlin reader is `kotlinx`'s, so
 * the call site names the type instead.
 */
inline fun <reified T> JsonElement.decodeAs(): T = WIRE_JSON.decodeFromJsonElement<T>(this)

/**
 * The repository's `protocol/fixtures/` directory.
 *
 * The golden frames are read from the repository rather than copied into a test
 * resource bundle, because the TypeScript suite validates the same bytes: a copy
 * would let the two drift apart with nothing failing, which is the exact failure the
 * fixtures exist to catch.
 *
 * Gradle runs tests with the working directory set to the module directory
 * (`Android/mizarkit`), so this walks *up* from `user.dir` until it finds
 * `protocol/fixtures/welcome.json`. Finding nothing is a hard failure rather than a
 * skip: an empty fixture list would make every assertion in `FixturesTest` pass
 * vacuously.
 */
fun fixturesDirectory(start: File = File(System.getProperty("user.dir"))): File {
    var directory: File? = start.absoluteFile
    while (directory != null) {
        val candidate = File(directory, "protocol/fixtures/welcome.json")
        if (candidate.isFile) return candidate.parentFile
        directory = directory.parentFile
    }
    throw AssertionError(
        "no protocol/fixtures/welcome.json above ${start.absolutePath}: the golden frames are " +
            "read from the repository, so these tests have to run inside a checkout",
    )
}
