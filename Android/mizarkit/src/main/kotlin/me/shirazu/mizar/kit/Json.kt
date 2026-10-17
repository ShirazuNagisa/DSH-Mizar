package me.shirazu.mizar.kit

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlin.math.roundToLong

/**
 * The JSON the wire is decoded through.
 *
 * Mirrors Swift's `JSONValue`, and the rules that matter are not obvious:
 *
 *  - **A string is not a number and not a boolean.** `kotlinx`'s
 *    `booleanOrNull`/`doubleOrNull` happily read `"true"` and `"3"` out of a JSON
 *    *string*, which Swift's `JSONValue` never does. Every accessor here checks
 *    `isString` first, so a host that sends a number as a string reads as absent
 *    rather than as a plausible value.
 *  - **Integrality is checked, not truncated.** `intValue` accepts `3.0` and
 *    rejects `3.5`, because `seq` and `updatedAt` arrive as JSON numbers that may
 *    legitimately be doubles, and silently flooring one would mis-order a
 *    conversation instead of dropping it.
 *  - **A missing key and an explicit `null` are both absent** for typed reads,
 *    which is what makes "missing ≠ zero" workable: the caller sees `null` and
 *    renders "—".
 */
val WIRE_JSON: Json = Json {
    ignoreUnknownKeys = true
    // The host omits fields rather than sending nulls, and this client does the
    // same: a `null` on the wire is a value the host chose to send.
    explicitNulls = false
    encodeDefaults = false
    isLenient = false
}

/** The string value, or `null` when this is not a JSON string. */
fun JsonElement?.stringValue(): String? {
    val primitive = this as? JsonPrimitive ?: return null
    if (primitive is JsonNull || !primitive.isString) return null
    return primitive.content
}

/** The boolean value, or `null` when this is not a JSON boolean. */
fun JsonElement?.boolValue(): Boolean? {
    val primitive = this as? JsonPrimitive ?: return null
    if (primitive is JsonNull || primitive.isString) return null
    return primitive.booleanOrNull
}

/** The numeric value as a double, or `null` when this is not a JSON number. */
fun JsonElement?.doubleValue(): Double? {
    val primitive = this as? JsonPrimitive ?: return null
    if (primitive is JsonNull || primitive.isString) return null
    return primitive.doubleOrNull
}

/**
 * The numeric value as an `Int`, or `null`.
 *
 * Only when the number is exactly integral and inside `Int`'s range — see the
 * note on the file.
 */
fun JsonElement?.intValue(): Int? {
    val number = doubleValue() ?: return null
    if (!number.isFinite()) return null
    if (number.roundToLong().toDouble() != number) return null
    if (number < Int.MIN_VALUE.toDouble() || number > Int.MAX_VALUE.toDouble()) return null
    return number.toInt()
}

/**
 * The numeric value as a `Long`, or `null`.
 *
 * Separate from [intValue] because the protocol's timestamps are epoch
 * milliseconds: ~1.79e12 truncated into an `Int` is a moment in 1970, and a
 * reader that did that would sort every session by nothing.
 */
fun JsonElement?.longValue(): Long? {
    val number = doubleValue() ?: return null
    if (!number.isFinite()) return null
    if (number.roundToLong().toDouble() != number) return null
    if (number < Long.MIN_VALUE.toDouble() || number > Long.MAX_VALUE.toDouble()) return null
    return number.roundToLong()
}

/** This element when it is a JSON array, otherwise `null`. */
fun JsonElement?.arrayValue(): JsonArray? = this as? JsonArray

/** This element when it is a JSON object, otherwise `null`. */
fun JsonElement?.objectValue(): JsonObject? = this as? JsonObject

/**
 * A member of this object, or `null`.
 *
 * Chained reads are safe: a missing link is `null` rather than an exception, which
 * is how a newer host's nested shape stays readable by an older client.
 */
operator fun JsonElement?.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)

/** Build an object, dropping members whose value is `null`. */
fun jsonObjectOf(vararg members: Pair<String, JsonElement?>): JsonObject =
    JsonObject(members.mapNotNull { (key, value) -> value?.let { key to it } }.toMap())

/** A JSON string. */
fun jsonString(value: String): JsonElement = JsonPrimitive(value)

/** A JSON number from an integer. */
fun jsonInt(value: Int): JsonElement = JsonPrimitive(value)

/** A JSON number from a long. */
fun jsonLong(value: Long): JsonElement = JsonPrimitive(value)

/** A JSON boolean. */
fun jsonBool(value: Boolean): JsonElement = JsonPrimitive(value)
