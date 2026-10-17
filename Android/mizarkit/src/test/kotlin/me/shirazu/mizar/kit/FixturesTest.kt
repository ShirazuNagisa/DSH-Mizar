package me.shirazu.mizar.kit

import kotlinx.serialization.json.JsonElement
import org.junit.jupiter.api.DisplayName
import org.junit.jupiter.api.Test
import java.io.File
import kotlin.test.*

/**
 * Golden frames captured from a live host.
 *
 * The frame tests check the parser against frames this repository wrote. These check
 * it against frames the *host* wrote, which is a different claim: a hand-written frame
 * and a real one agree only as long as someone remembers to keep them in sync, and
 * nothing fails when they stop.
 *
 * The files live at `protocol/fixtures/` and are read from there rather than copied
 * into the test source set, so the TypeScript suite validates the exact same bytes.
 * Refresh them with:
 *
 *     MIZAR_WRITE_FIXTURES=1 scripts/dev.sh smoke
 */
class FixturesTest {

    /** A fixture captured from a live host. */
    private data class Fixture(val name: String, val raw: String)

    /**
     * Every captured fixture.
     *
     * `fixturesDirectory()` walks up from the module directory and fails loudly when
     * it finds nothing, so a checkout that moved cannot turn the assertions below into
     * silent no-ops.
     */
    private fun loadFixtures(): List<Fixture> {
        val directory = fixturesDirectory()
        return (directory.listFiles() ?: emptyArray<File>())
            .filter { it.isFile && it.name.endsWith(".json") }
            .sortedBy { it.name }
            .map { Fixture(name = it.name.removeSuffix(".json"), raw = it.readText()) }
    }

    /** One named fixture, or a failed test — Swift's `#require(…first { … })`. */
    private fun fixtureNamed(name: String): Fixture =
        loadFixtures().firstOrNull { it.name == name } ?: fail("fixture $name is missing")

    /** A fixture as a server frame, failing the test when it will not read at all. */
    private fun frame(fixture: Fixture): ServerFrame = when (val decoded = Frames.decodeServer(fixture.raw)) {
        is FrameDecode.Decoded -> decoded.frame
        is FrameDecode.VersionMismatch -> fail("${fixture.name} speaks protocol version ${decoded.seen}")
        FrameDecode.Malformed -> fail("${fixture.name} is not a frame this build can read")
    }

    @Test
    fun `the fixture set is present`() {
        val fixtures = loadFixtures()
        // A missing directory would make every assertion below vacuously pass.
        assertTrue(fixtures.isNotEmpty(), "no fixtures at ${fixturesDirectory().path}")
        for (expected in listOf(
            "welcome", "host-info", "session-list", "session-stats",
            "model-catalog", "permissions-catalog", "interactions-pending", "error-frame",
        )) {
            assertTrue(fixtures.any { it.name == expected }, "fixture $expected is missing")
        }
    }

    @Test
    fun `every fixture decodes as a server frame this build understands`() {
        for (fixture in loadFixtures()) {
            val decoded = frame(fixture)
            if (decoded is ServerFrame.Unknown) {
                fail("fixture ${fixture.name} decoded as an unknown frame type ${decoded.type}")
            }
        }
    }

    @Test
    fun `the welcome fixture matches the model`() {
        val welcome = assertIs<ServerFrame.Welcome>(frame(fixtureNamed("welcome")))
        assertEquals(MIZAR_PROTOCOL_VERSION, welcome.protocolVersion)
        assertTrue(welcome.hostId.isNotEmpty())
        assertTrue(welcome.hostName.isNotEmpty())
    }

    // Swift spelled this `the host.info fixture decodes into HostInfo`; the JVM forbids
    // a `.` in a method name, so the exact sentence is carried by the display name.
    @Test
    @DisplayName("the host.info fixture decodes into HostInfo")
    fun `the host info fixture decodes into HostInfo`() {
        val result = frame(fixtureNamed("host-info")).resultValue ?: fail("expected an ok frame with a result")
        val info = result.decodeAs<HostInfo>()
        assertEquals(MIZAR_PROTOCOL_VERSION, info.protocolVersion)
        assertTrue(info.hostName.isNotEmpty())
    }

    @Test
    fun `the session list decodes into rows`() {
        val result = frame(fixtureNamed("session-list")).resultValue ?: fail("expected an ok frame with a result")
        val list = result.decodeAs<SessionListResult>()
        assertTrue(list.items.isNotEmpty())
        for (row in list.items) {
            assertTrue(row.sessionId.isNotEmpty())
            assertTrue(row.updatedAt > 0)
        }
    }

    @Test
    fun `the usage fixture decodes into a stats frame`() {
        val result = frame(fixtureNamed("session-stats")).resultValue ?: fail("expected an ok frame with a result")
        val stats = result.decodeAs<SessionStatsResult>()
        // The four counters the cache-hit formula needs must survive decoding.
        val usage = stats.stats?.tokenUsage ?: fail("expected token usage")
        assertEquals(
            usage.billedInputTokens,
            usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
        )
    }

    @Test
    fun `the model catalog decodes, including reasoning efforts`() {
        val result = frame(fixtureNamed("model-catalog")).resultValue ?: fail("expected an ok frame with a result")
        val catalog = result.decodeAs<ModelCatalog>()
        assertTrue(catalog.providers.isNotEmpty())
        for (provider in catalog.providers) {
            for (model in provider.models) {
                assertTrue(model.id.isNotEmpty())
                // Swift's decoder folded an absent `efforts` into an empty list; the
                // Kotlin model is non-null for the same reason, because the picker
                // branches on emptiness.
                for (effort in model.efforts) {
                    assertTrue(effort.id.isNotEmpty())
                }
            }
        }
    }

    // Swift's name quotes `custom` in backticks, which a Kotlin backticked name cannot
    // contain; the exact sentence is carried by the display name.
    @Test
    @DisplayName("the permission catalog decodes and never offers `custom` as a target")
    fun `the permission catalog decodes and never offers custom as a target`() {
        val result = frame(fixtureNamed("permissions-catalog")).resultValue ?: fail("expected an ok frame with a result")
        val catalog = result.decodeAs<PermissionCatalog>()
        assertTrue(catalog.options.isNotEmpty())
        // `custom` is derived-only: it can be the current value but must never be a
        // selectable row.
        assertFalse(catalog.options.any { it.value == "custom" })
        for (option in catalog.options) {
            assertTrue(option.name.isNotEmpty())
        }
    }

    @Test
    fun `the pending interactions fixture decodes`() {
        val result = frame(fixtureNamed("interactions-pending")).resultValue ?: fail("expected an ok frame with a result")
        // Swift discarded the value; the assertion is that decoding does not throw.
        result.decodeAs<PendingInteractions>()
    }

    @Test
    fun `the error fixture carries a code this build classifies`() {
        val failure = assertIs<ServerFrame.Failure>(frame(fixtureNamed("error-frame")))
        assertTrue(failure.error.code.isNotEmpty())
        assertTrue(failure.error.message.isNotEmpty())
    }

    @Test
    fun `no fixture leaks a credential`() {
        // These files are committed. A device token or a token hash reaching one would
        // be a credential in version control.
        for (fixture in loadFixtures()) {
            assertFalse(fixture.raw.contains("deviceToken"), "${fixture.name} contains a device token")
            assertFalse(fixture.raw.contains("tokenHash"), "${fixture.name} contains a token hash")
            assertFalse(fixture.raw.contains("mz_"), "${fixture.name} contains a token")
        }
    }
}

/**
 * The `result` of an `ok` frame, for the fixtures that are all `ok`.
 *
 * Swift wrote this as a `ServerFrame` extension in `FixtureTests.swift`; the Kotlin
 * reader spells the same idea as a cast to the one case that carries a result.
 */
private val ServerFrame.resultValue: JsonElement?
    get() = (this as? ServerFrame.Ok)?.result
