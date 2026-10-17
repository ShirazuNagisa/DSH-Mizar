package me.shirazu.mizar.kit

import java.net.URI
import java.net.URLDecoder
import java.net.URLEncoder

/** The custom scheme the QR encodes. */
const val PAIRING_SCHEME: String = "mizar"

/** The host part of a pairing URI. */
const val PAIRING_URI_PREFIX: String = "$PAIRING_SCHEME://pair"

/**
 * A decoded pairing URI.
 *
 * @property authority `host:port` to dial directly, or `null` when the host is
 *   reachable only through a relay. An IPv6 literal arrives already bracketed and
 *   is kept verbatim.
 * @property code the pairing code, in display form.
 * @property hostName the host's display name, when it was included.
 * @property protocolVersion the version the host speaks, when it was included.
 * @property baseUrl a reverse tunnel's base URL, when the host is behind one. It
 *   is a *base*, not an authority, because the room is a path segment:
 *   `https://relay.example.com/r/ABCD1234`.
 */
data class PairingTarget(
    val authority: String?,
    val code: String,
    val hostName: String?,
    val protocolVersion: Int?,
    val baseUrl: String?,
)

/**
 * Parsing and building for `mizar://pair?...`.
 *
 * The authority of this file is the **TypeScript** side
 * (`src/protocol/pairing-uri.ts`), because that is what the panel renders: the
 * app parses what the panel wrote. Where the Swift client and the TypeScript one
 * disagree, the disagreement is called out in a comment and covered by a test
 * rather than silently resolved:
 *
 *  - query encoding uses `application/x-www-form-urlencoded` (space is `+`),
 *    which is what `URLSearchParams` produces — Swift's `URLComponents` produces
 *    `%20` instead, so a host name with a space round-trips differently;
 *  - `v=` (present but empty) parses as version **0** through `Number("")`,
 *    while Swift's `Int("")` yields `nil`.
 */
object PairingUri {

    /** Build the URI a QR code carries, or `null` when there is nowhere to dial. */
    fun build(
        authority: String,
        code: String,
        hostName: String,
        protocolVersion: Int,
        baseUrl: String? = null,
    ): String? {
        // A QR with no address at all scans successfully and then fails with
        // nothing useful to say. Refusing to build one beats rendering it.
        if (authority.isEmpty() && baseUrl.isNullOrEmpty()) return null

        val query = StringBuilder()
        fun add(name: String, value: String) {
            if (query.isNotEmpty()) query.append('&')
            query.append(name).append('=').append(encode(value))
        }
        if (authority.isNotEmpty()) add("h", authority)
        if (!baseUrl.isNullOrEmpty()) add("u", baseUrl)
        add("c", code)
        add("n", hostName)
        add("v", protocolVersion.toString())
        return "$PAIRING_URI_PREFIX?$query"
    }

    /**
     * Parse a pairing URI.
     *
     * Returns `null` for anything unrecognised rather than throwing: a scanned code
     * is untrusted input from a camera, and a different QR in front of the lens is a
     * normal thing to meet.
     */
    fun parse(input: String): PairingTarget? {
        val trimmed = input.trim()
        if (!trimmed.startsWith("$PAIRING_URI_PREFIX?")) return null

        val params = try {
            decodeQuery(trimmed.substring(PAIRING_URI_PREFIX.length + 1))
        } catch (_: Exception) {
            return null
        }

        val authority = params["h"]?.trim() ?: ""
        val baseUrl = params["u"]?.trim() ?: ""
        val code = params["c"]?.trim() ?: ""

        // The code is the one thing that must always be present; an address may
        // arrive through either parameter, but one of them has to arrive.
        if (code.isEmpty()) return null
        if (authority.isEmpty() && baseUrl.isEmpty()) return null
        if (baseUrl.isNotEmpty() && !isUsableBaseUrl(baseUrl)) return null

        // `Number(...)` semantics, not `Int(...)`: `Number('')` is 0 while
        // `Int('')` is null, so a URI written as `v=` answers 0 here and null in
        // the Swift client. Neither is reachable from the panel, which always
        // writes a version; the behaviour is pinned by a test so the difference is
        // a decision rather than a surprise.
        val version = params["v"]?.let { text ->
            if (text.isBlank()) {
                0
            } else {
                text.toDoubleOrNull()
                    ?.takeIf { it.isFinite() && it == Math.floor(it) }
                    ?.toInt()
            }
        }

        return PairingTarget(
            authority = authority.ifEmpty { null },
            code = code,
            hostName = params["n"],
            protocolVersion = version,
            baseUrl = baseUrl.ifEmpty { null },
        )
    }

    /**
     * Whether a base URL is one this client can dial.
     *
     * A scanned code is untrusted input, and this URL decides where a device token
     * gets sent. Restricting the scheme to what the protocol actually speaks keeps
     * a crafted QR from pointing the app somewhere it would never otherwise go.
     */
    fun isUsableBaseUrl(value: String): Boolean {
        val parsed = try {
            URI(value)
        } catch (_: Exception) {
            return false
        }
        val scheme = parsed.scheme?.lowercase() ?: return false
        if (scheme != "http" && scheme != "https") return false
        return !parsed.host.isNullOrEmpty()
    }

    /**
     * The WebSocket URL for a relay base URL.
     *
     * The room is a path segment and must survive: losing `/r/ROOM` connects to the
     * relay and reaches nobody.
     */
    fun relayWebSocketUrl(baseUrl: String): String? {
        val parsed = try {
            URI(baseUrl)
        } catch (_: Exception) {
            return null
        }
        val scheme = when (parsed.scheme?.lowercase()) {
            "https" -> "wss"
            "http" -> "ws"
            else -> return null
        }
        val authority = parsed.rawAuthority ?: return null
        if (authority.isEmpty()) return null
        val path = (parsed.rawPath ?: "").replace(Regex("/+$"), "")
        return "$scheme://$authority$path$MIZAR_WEBSOCKET_PATH"
    }

    /** The pairing HTTP URL for a relay base URL. */
    fun relayHttpUrl(baseUrl: String, path: String): String? {
        val parsed = try {
            URI(baseUrl)
        } catch (_: Exception) {
            return null
        }
        if (parsed.host.isNullOrEmpty()) return null
        return baseUrl + path
    }

    /**
     * A URL for one authority.
     *
     * The host is checked explicitly: `ws:///path` is a perfectly valid URI with an
     * *empty* host, so a blank or malformed authority would otherwise produce
     * something that looks dialable and fails later with a confusing error.
     */
    fun url(authority: String, path: String, scheme: String): String? {
        val trimmed = authority.trim()
        if (trimmed.isEmpty()) return null
        val candidate = "$scheme://$trimmed$path"
        val parsed = try {
            URI(candidate)
        } catch (_: Exception) {
            return null
        }
        if (parsed.host.isNullOrEmpty()) return null
        return candidate
    }

    /** The WebSocket URL for a direct authority. */
    fun webSocketUrl(authority: String, secure: Boolean = false): String? =
        url(authority, MIZAR_WEBSOCKET_PATH, if (secure) "wss" else "ws")

    /** The HTTP URL for a direct authority. */
    fun httpUrl(authority: String, path: String, secure: Boolean = false): String? =
        url(authority, path, if (secure) "https" else "http")

    /** `application/x-www-form-urlencoded`, as `URLSearchParams` writes it. */
    private fun encode(value: String): String = URLEncoder.encode(value, Charsets.UTF_8)

    /** Decode a query string; the first occurrence of a name wins, as in `URLSearchParams.get`. */
    private fun decodeQuery(query: String): Map<String, String> {
        val result = LinkedHashMap<String, String>()
        for (pair in query.split('&')) {
            if (pair.isEmpty()) continue
            val index = pair.indexOf('=')
            val name = if (index < 0) pair else pair.substring(0, index)
            val value = if (index < 0) "" else pair.substring(index + 1)
            val decodedName = URLDecoder.decode(name, Charsets.UTF_8)
            // First wins: `URLSearchParams.get` returns the first value, and a
            // crafted QR with two `h=` parameters must not be able to change which
            // address this client dials by appending one.
            if (!result.containsKey(decodedName)) {
                result[decodedName] = URLDecoder.decode(value, Charsets.UTF_8)
            }
        }
        return result
    }
}
