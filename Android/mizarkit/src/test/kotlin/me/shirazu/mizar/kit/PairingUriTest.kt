package me.shirazu.mizar.kit

import org.junit.jupiter.api.Test
import java.net.URI
import kotlin.test.*

/**
 * The pairing URI.
 *
 * It is shared with the TypeScript side, so these cases mirror `dsh/test/panel.test.ts`
 * case for case. A disagreement between the two implementations does not surface as an
 * error — it silently dials the wrong host — so both sides are pinned to the same
 * expectations.
 *
 * The Kotlin implementation follows the **panel**, not the Swift client, in three
 * places; each has its own case below so the difference is a decision rather than a
 * surprise:
 *
 *  - query encoding is `application/x-www-form-urlencoded`, so a space is `+` where
 *    `URLComponents` wrote `%20`;
 *  - `v=` (present, empty) is version **0**, from `Number('')`, where `Int('')` was
 *    `nil`;
 *  - a duplicated parameter resolves to its **first** occurrence, as
 *    `URLSearchParams.get` does.
 */
class PairingUriTest {

    @Test
    fun `round-trips every field`() {
        val uri = PairingUri.build(
            authority = "100.64.0.1:19390",
            code = "AB2C-D3EF",
            hostName = "shirazu-mac",
            protocolVersion = 1,
        )
        val target = assertNotNull(PairingUri.parse(assertNotNull(uri)))
        assertEquals("100.64.0.1:19390", target.authority)
        assertEquals("AB2C-D3EF", target.code)
        assertEquals("shirazu-mac", target.hostName)
        assertEquals(1, target.protocolVersion)
    }

    @Test
    fun `survives an IPv6 authority`() {
        val uri = PairingUri.build(
            authority = "[fd7a:115c:a1e0::1]:19390",
            code = "AB2C-D3EF",
            hostName = "mac",
            protocolVersion = 1,
        )
        val target = assertNotNull(PairingUri.parse(assertNotNull(uri)))
        assertEquals("[fd7a:115c:a1e0::1]:19390", target.authority)
    }

    @Test
    fun `survives a host name needing escaping`() {
        val uri = PairingUri.build(
            authority = "10.0.0.1:19390",
            code = "AB2C-D3EF",
            hostName = "Shirazu's MacBook Pro",
            protocolVersion = 1,
        )
        val target = assertNotNull(PairingUri.parse(assertNotNull(uri)))
        assertEquals("Shirazu's MacBook Pro", target.hostName)
    }

    @Test
    fun `tolerates whitespace from a scanner`() {
        val uri = assertNotNull(
            PairingUri.build(
                authority = "10.0.0.1:19390",
                code = "AB2C-D3EF",
                hostName = "mac",
                protocolVersion = 1,
            ),
        )
        val target = assertNotNull(PairingUri.parse("  $uri\n"))
        assertEquals("10.0.0.1:19390", target.authority)
    }

    @Test
    fun `rejects anything that is not a pairing URI`() {
        // A camera pointed at the wrong QR is a normal event, not an error.
        assertNull(PairingUri.parse("https://example.com"))
        assertNull(PairingUri.parse("mizar://other?h=x&c=y"))
        assertNull(PairingUri.parse(""))
    }

    @Test
    fun `rejects a URI missing the host or the code`() {
        assertNull(PairingUri.parse("mizar://pair?c=AB2C"))
        assertNull(PairingUri.parse("mizar://pair?h=10.0.0.1:19390"))
    }

    @Test
    fun `reports a missing or unparsable version as nil rather than a guess`() {
        assertNull(PairingUri.parse("mizar://pair?h=h&c=c")?.protocolVersion)
        assertNull(PairingUri.parse("mizar://pair?h=h&c=c&v=two")?.protocolVersion)
    }

    @Test
    fun `builds the WebSocket URL from the authority`() {
        val url = assertNotNull(PairingUri.webSocketUrl(authority = "100.64.0.1:19390"))
        assertEquals("ws://100.64.0.1:19390/mizar/v1/ws", url)

        val secure = assertNotNull(PairingUri.webSocketUrl(authority = "100.64.0.1:19390", secure = true))
        assertEquals("wss://100.64.0.1:19390/mizar/v1/ws", secure)
    }

    @Test
    fun `builds the HTTP URL from the authority`() {
        val url = assertNotNull(PairingUri.httpUrl(authority = "10.0.0.1:19390", path = "/mizar/v1/pair"))
        assertEquals("http://10.0.0.1:19390/mizar/v1/pair", url)
    }

    @Test
    fun `refuses an authority it cannot dial`() {
        assertNull(PairingUri.webSocketUrl(authority = ""))
        assertNull(PairingUri.webSocketUrl(authority = "has spaces"))
    }

    // MARK: - Relay

    @Test
    fun `carries a relay base URL alongside a direct authority`() {
        val uri = PairingUri.build(
            authority = "100.64.0.1:19390",
            code = "AB2C-D3EF",
            hostName = "shirazu-mac",
            protocolVersion = 1,
            baseUrl = "https://relay.example.com/r/WBKW0NZVT5QZ",
        )
        val target = assertNotNull(PairingUri.parse(assertNotNull(uri)))
        assertEquals("100.64.0.1:19390", target.authority)
        assertEquals("https://relay.example.com/r/WBKW0NZVT5QZ", target.baseUrl)
    }

    @Test
    fun `carries a relay with no direct authority at all`() {
        val uri = PairingUri.build(
            authority = "",
            code = "AB2C-D3EF",
            hostName = "shirazu-mac",
            protocolVersion = 1,
            baseUrl = "https://relay.example.com/r/ROOM",
        )
        val target = assertNotNull(PairingUri.parse(assertNotNull(uri)))
        assertNull(target.authority)
        assertEquals("https://relay.example.com/r/ROOM", target.baseUrl)
    }

    @Test
    fun `refuses to build a URI with no address to dial`() {
        // A QR that scans and then fails, with nothing useful to say about why, is
        // worse than no QR at all.
        assertNull(PairingUri.build(authority = "", code = "C", hostName = "n", protocolVersion = 1))
    }

    @Test
    fun `builds the old shape when there is no relay`() {
        val uri = assertNotNull(
            PairingUri.build(authority = "10.0.0.1:1", code = "C", hostName = "n", protocolVersion = 1),
        )
        assertFalse(uri.contains("u="))
        assertNull(PairingUri.parse(uri)?.baseUrl)
    }

    @Test
    fun `parses a URI written before the relay existed`() {
        val target = PairingUri.parse("mizar://pair?h=10.0.0.1:19390&c=AB2C-D3EF&n=mac&v=1")
        assertEquals("10.0.0.1:19390", target?.authority)
        assertNull(target?.baseUrl)
    }

    @Test
    fun `refuses a relay scheme the client cannot dial`() {
        // A scanned code is untrusted input from a camera, and this URL decides where a
        // device token gets sent.
        assertNull(PairingUri.parse("mizar://pair?u=file:///etc/passwd&c=C&v=1"))
        assertNull(PairingUri.parse("mizar://pair?u=javascript:alert(1)&c=C&v=1"))
        assertNull(PairingUri.parse("mizar://pair?u=rdp://host/x&c=C&v=1"))
    }

    @Test
    fun `refuses a URI with a code but no address`() {
        assertNull(PairingUri.parse("mizar://pair?c=AB2C-D3EF&n=mac&v=1"))
    }

    @Test
    fun `accepts a plain http relay for a LAN or a test`() {
        assertEquals(
            "http://127.0.0.1:8787/r/R",
            PairingUri.parse("mizar://pair?u=http://127.0.0.1:8787/r/R&c=C&v=1")?.baseUrl,
        )
    }

    @Test
    fun `turns a relay base URL into its WebSocket URL`() {
        assertEquals(
            "wss://relay.example.com/r/ROOM/mizar/v1/ws",
            PairingUri.relayWebSocketUrl(baseUrl = "https://relay.example.com/r/ROOM"),
        )
    }

    @Test
    fun `keeps the room in the relay WebSocket path`() {
        // The room is what routes the request to the right Mac; losing it would produce
        // a URL that connects to the relay and reaches nobody.
        val url = assertNotNull(
            PairingUri.relayWebSocketUrl(baseUrl = "https://relay.example.com/r/WBKW0NZVT5QZ"),
        )
        // Swift read `.path` off a `URL`; the Kotlin helper returns the URL text, so
        // `URI` supplies the same "path" reading here.
        assertTrue(URI(url).path.contains("/r/WBKW0NZVT5QZ/"), url)
    }

    @Test
    fun `builds the relay HTTP URL for pairing`() {
        assertEquals(
            "https://relay.example.com/r/ROOM/mizar/v1/pair",
            PairingUri.relayHttpUrl(baseUrl = "https://relay.example.com/r/ROOM", path = "/mizar/v1/pair"),
        )
    }

    @Test
    fun `a relay-only target has no direct authority but does have a base URL`() {
        // The gap this pins: the parser can understand `u` perfectly while the pairing
        // call never passes it on, which shows up only when something tries to dial the
        // relay. A simulator run against a relay-only QR is what found it.
        val target = assertNotNull(
            PairingUri.parse("mizar://pair?u=https://relay.example.com/r/ROOM&c=AB2C-D3EF&v=1"),
        )
        assertNull(target.authority)
        assertEquals("https://relay.example.com/r/ROOM", target.baseUrl)
        // Both legs must be constructible from the base URL alone, since that is all a
        // relay-only scan provides.
        val baseUrl = assertNotNull(target.baseUrl)
        assertNotNull(PairingUri.relayHttpUrl(baseUrl = baseUrl, path = "/mizar/v1/pair"))
        assertNotNull(PairingUri.relayWebSocketUrl(baseUrl = baseUrl))
    }

    // MARK: - Divergences from the Swift client

    @Test
    fun `writes a space as a plus, as the panel's URLSearchParams does`() {
        // Swift's `URLComponents` wrote `%20` and read `+` literally, so a host name
        // with a space crossed the two clients as different strings; the panel is the
        // writer this client actually has to agree with.
        val uri = assertNotNull(
            PairingUri.build(
                authority = "10.0.0.1:19390",
                code = "AB2C-D3EF",
                hostName = "Shirazu's MacBook Pro",
                protocolVersion = 1,
            ),
        )
        assertTrue(uri.contains("n=Shirazu%27s+MacBook+Pro"), uri)
        assertFalse(uri.contains("%20"), uri)
        assertEquals("Shirazu's MacBook Pro", PairingUri.parse(uri)?.hostName)
    }

    @Test
    fun `reads an empty version as zero rather than as absent`() {
        // `Number('')` is 0 while Swift's `Int('')` was nil. The panel always writes a
        // version, so neither is reachable from it — which is exactly why the behaviour
        // is pinned here instead of being left to chance.
        assertEquals(0, PairingUri.parse("mizar://pair?h=h&c=c&v=")?.protocolVersion)
    }

    @Test
    fun `keeps the first of a duplicated query parameter`() {
        // `URLSearchParams.get` returns the first value, and that has to be the rule: a
        // QR could otherwise append `&h=…` to choose the address this client dials, and
        // the device token goes wherever that address points.
        val target = assertNotNull(
            PairingUri.parse("mizar://pair?h=10.0.0.1:19390&h=attacker.example:1&c=C&v=1"),
        )
        assertEquals("10.0.0.1:19390", target.authority)
    }
}
