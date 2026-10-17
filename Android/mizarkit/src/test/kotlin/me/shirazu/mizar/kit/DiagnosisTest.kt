package me.shirazu.mizar.kit

import org.junit.jupiter.api.Test
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import kotlin.test.*

/**
 * The failure this exists for: a phone on cellular timing out against a tailnet address,
 * and the app answering with a page of NSError.
 *
 * Ported from `DiagnosisTests.swift`. The Swift cases keyed off `URLError.Code`; the JVM
 * transport throws `SocketTimeoutException`, `ConnectException` and
 * `UnknownHostException` instead, and "this device has no network" is not derivable from
 * an exception at all — the app supplies it, which the offline case pins.
 */
class DiagnosisTest {

    /**
     * The Swift test's `Boom`.
     *
     * There it was a `LocalizedError` and its `errorDescription` was the text that
     * survived; the JVM classifier reads `Throwable.message`, so the text lives there.
     */
    private class Boom : Exception("something specific")

    @Test
    fun `recognises the tailnet IPv4 block`() {
        // 100.64.0.0/10, so the second octet runs 64 through 127.
        assertTrue(Diagnoses.isTailnet("100.64.0.1:19390"))
        assertTrue(Diagnoses.isTailnet("100.100.172.14:19390"))
        assertTrue(Diagnoses.isTailnet("100.127.255.254"))
        assertFalse(Diagnoses.isTailnet("100.63.0.1"))
        assertFalse(Diagnoses.isTailnet("100.128.0.1"))
        assertFalse(Diagnoses.isTailnet("192.168.1.5"))
    }

    @Test
    fun `recognises the tailnet IPv6 prefix`() {
        assertTrue(Diagnoses.isTailnet("fd7a:115c:a1e0::7401:acde"))
        assertTrue(Diagnoses.isTailnet("[fd7a:115c:a1e0::1]:19390"))
        assertFalse(Diagnoses.isTailnet("fd00::1"))
    }

    @Test
    fun `a timeout against a tailnet address means the phone is not on it`() {
        // `URLError(.timedOut)` on the Swift side is a `SocketTimeoutException` here.
        val authority = "100.100.172.14:19390"
        val diagnosis = Diagnoses.of(SocketTimeoutException(), authority = authority)
        assertEquals(Diagnosis.OutsideTailnet(authority), diagnosis)
        // The message has to name the action, not the symptom. Swift read this off
        // `diagnosis.message`; the phrasing lives in `Diagnoses.message` in Kotlin.
        assertTrue(Diagnoses.message(diagnosis).contains("Tailscale"))
        assertTrue(Diagnoses.message(diagnosis).contains(authority))
    }

    @Test
    fun `a timeout on a LAN address is a different problem with a different fix`() {
        val authority = "192.168.1.5:19390"
        val diagnosis = Diagnoses.of(SocketTimeoutException(), authority = authority)
        assertEquals(Diagnosis.Silent(authority), diagnosis)
        // Opening Tailscale would not help here, so it must not be suggested.
        assertFalse(Diagnoses.message(diagnosis).contains("Tailscale"))
    }

    @Test
    fun `a refused connection means the tailnet is fine and the host is not`() {
        // `URLError(.cannotConnectToHost)` on the Swift side is a `ConnectException`.
        val authority = "100.100.172.14:19390"
        val diagnosis = Diagnoses.of(ConnectException(), authority = authority)
        assertEquals(Diagnosis.TailnetPeerSilent(authority), diagnosis)
        assertTrue(Diagnoses.message(diagnosis).contains("DSH is running"))
    }

    @Test
    fun `no network is reported as no network`() {
        // Swift read this off `URLError.notConnectedToInternet` and `.dataNotAllowed`.
        // A JVM exception carries no such flag — the app asks `ConnectivityManager` and
        // passes the answer in — so both Swift codes collapse into the `offline`
        // argument, which is what these two calls pin.
        assertEquals(Diagnosis.Offline, Diagnoses.of(IOException("offline"), authority = "x", offline = true))
        assertEquals(Diagnosis.Offline, Diagnoses.of(ConnectException("offline"), authority = "x", offline = true))
    }

    @Test
    fun `an unresolvable name is reported as one`() {
        // `URLError(.cannotFindHost)`/`.dnsLookupFailed` → `UnknownHostException`.
        val authority = "nope.local:1"
        val diagnosis = Diagnoses.of(UnknownHostException(authority), authority = authority)
        assertEquals(Diagnosis.UnknownHost(authority), diagnosis)
        assertTrue(Diagnoses.message(diagnosis).contains(authority))
    }

    @Test
    fun `an unrelated error keeps the system's own words`() {
        assertEquals(Diagnosis.Other("something specific"), Diagnoses.of(Boom(), authority = "x"))
    }

    @Test
    fun `never shows a raw NSError dump`() {
        // The original bug: the screen showed the whole UserInfo dictionary. The JVM has
        // no such dictionary, so these strings can only appear if a future change starts
        // formatting one into a message — the assertions are kept as that guard.
        for (authority in listOf("100.100.172.14:19390", "192.168.1.5:19390", "nope.local:1")) {
            val message = Diagnoses.message(Diagnoses.of(SocketTimeoutException(), authority = authority))
            assertFalse(message.contains("UserInfo"))
            assertFalse(message.contains("_kCFStreamErrorCodeKey"))
            assertFalse(message.contains("NSURLErrorDomain"))
        }
    }

    @Test
    fun `a refused credential is a re-pairing problem, not a network one`() {
        // Measured on the device: the phone kept a token from a host that had since
        // forgotten it, so every attempt was answered and rejected. Classifying that as
        // "nothing answered" sent the operator to check Wi-Fi, and the retry loop ran
        // forever against a host that was perfectly reachable.
        for (code in listOf("UNAUTHENTICATED", "DEVICE_REVOKED")) {
            val authority = "192.168.1.5:19390"
            val diagnosis = Diagnoses.of(MizarError(code, "no"), authority = authority)
            assertEquals(Diagnosis.RequiresRepairing(authority), diagnosis)
            val message = Diagnoses.message(diagnosis)
            assertTrue(message.contains("no longer recognises"))
            assertTrue(message.contains(authority))
        }
    }

    @Test
    fun `a refused credential outranks the offline hint`() {
        // Both facts cannot be true at once in a useful way: the host answered. Trusting
        // the platform's "no network" here would hide the one action that helps.
        assertEquals(
            Diagnosis.RequiresRepairing("h:1"),
            Diagnoses.of(MizarError("UNAUTHENTICATED", "no"), authority = "h:1", offline = true),
        )
    }

    @Test
    fun `other host errors keep their network classification`() {
        // Only the two credential codes mean "pair again"; a busy writer or a timeout is
        // still a transient problem, so it keeps the host's own words (and the app's
        // retry path) rather than being reclassified as a pairing failure.
        assertEquals(
            Diagnosis.Other("slow"),
            Diagnoses.of(MizarError("REQUEST_TIMEOUT", "slow"), authority = "h:1"),
        )
        assertEquals(
            Diagnosis.Other("busy"),
            Diagnoses.of(MizarError("WRITER_HELD", "busy"), authority = "h:1"),
        )
    }
}
