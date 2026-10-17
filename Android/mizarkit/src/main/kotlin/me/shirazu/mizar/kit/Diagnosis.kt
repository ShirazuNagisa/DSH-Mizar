package me.shirazu.mizar.kit

import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/**
 * What went wrong reaching a host, in a form the UI can phrase.
 *
 * Structured rather than pre-rendered, which is a deliberate divergence from the
 * iOS client: there the diagnosis *is* an English sentence, so the one message an
 * operator reads when nothing works is in a language they may not read. Here the
 * app maps the case to a localized string and only falls back to [message].
 */
sealed interface Diagnosis {
    /** A `100.64.0.0/10` or `fd7a:…` address: a tailnet this device is not on. */
    data class OutsideTailnet(val authority: String) : Diagnosis

    /** A tailnet address that did not answer: the peer, not the network. */
    data class TailnetPeerSilent(val authority: String) : Diagnosis

    /** A plain address that did not answer. */
    data class Silent(val authority: String) : Diagnosis

    /** This device has no network at all. */
    data object Offline : Diagnosis

    /**
     * The host refused this phone's credential.
     *
     * Not a network failure: the socket was reachable and answered. Retrying cannot
     * fix it — the stored token is dead, and only pairing again will produce a new one.
     */
    data class RequiresRepairing(val authority: String) : Diagnosis

    /** The name did not resolve. */
    data class UnknownHost(val authority: String) : Diagnosis

    /** Anything else, with the underlying description. */
    data class Other(val detail: String) : Diagnosis
}

/** Turning a failed connection into something the operator can act on. */
object Diagnoses {

    /**
     * Whether an authority is inside a Tailscale range.
     *
     * Two spellings: the `100.64.0.0/10` carrier-grade NAT block and Tailscale's
     * IPv6 prefix `fd7a:115c:a1e0::/48`. It is a heuristic and it is stated as one —
     * but the alternative is telling somebody on a tailnet to "check your Wi-Fi",
     * which is advice that cannot work.
     */
    fun isTailnet(authority: String): Boolean {
        val lowered = authority.lowercase()
        // Checked before any port stripping: splitting `fd7a:115c:a1e0::1` on `:`
        // leaves `fd7a`, which is not the prefix anybody would compare against.
        if (lowered.startsWith("fd7a:115c:a1e0:")) return true
        if (lowered.startsWith("[fd7a:115c:a1e0:")) return true

        val host = lowered.substringBefore(':')
        val parts = host.split('.')
        if (parts.size != 4) return false
        val numbers = parts.map { it.toIntOrNull() ?: return false }
        return numbers[0] == 100 && numbers[1] in 64..127
    }

    /**
     * Classify a failed attempt.
     *
     * @param error what the transport threw.
     * @param authority the address that was dialled, when one is known.
     * @param offline whether the platform says this device has no network; supplied
     *   by the caller because only the app can ask (`ConnectivityManager` is an
     *   Android API and this module has no Android in it).
     */
    fun of(error: Throwable, authority: String? = null, offline: Boolean = false): Diagnosis {
        val address = authority?.takeIf { it.isNotBlank() }

        // Checked before every network branch, and before `offline`: the host answered
        // and said "I do not know you", which is a fact about the credential, not about
        // the network. Reporting it as "nothing answered" sends the operator to check
        // Wi-Fi for a problem retrying can never solve.
        if (error is MizarError && error.requiresRepairing) {
            return Diagnosis.RequiresRepairing(address ?: "")
        }

        if (offline) return Diagnosis.Offline
        if (address == null) return Diagnosis.Other(describe(error))

        val tailnet = isTailnet(address)
        return when (error) {
            is SocketTimeoutException -> if (tailnet) Diagnosis.OutsideTailnet(address) else Diagnosis.Silent(address)
            is UnknownHostException -> Diagnosis.UnknownHost(address)
            is NoRouteToHostException -> Diagnosis.Offline
            is ConnectException -> {
                // "Network is unreachable" arrives as a ConnectException on the JVM
                // and is an offline device, not a silent one.
                if (error.message?.contains("unreachable", ignoreCase = true) == true) {
                    Diagnosis.Offline
                } else if (tailnet) {
                    Diagnosis.TailnetPeerSilent(address)
                } else {
                    Diagnosis.Silent(address)
                }
            }
            is IOException -> {
                if (error.message?.contains("network is unreachable", ignoreCase = true) == true) {
                    Diagnosis.Offline
                } else if (tailnet) {
                    Diagnosis.TailnetPeerSilent(address)
                } else {
                    Diagnosis.Silent(address)
                }
            }
            else -> Diagnosis.Other(describe(error))
        }
    }

    /**
     * The English phrasing, used when the caller has no localized string.
     *
     * Every message names an action rather than a symptom: "nothing answered" is a
     * symptom, "make sure DSH is running" is something the reader can do.
     */
    fun message(diagnosis: Diagnosis): String = when (diagnosis) {
        is Diagnosis.OutsideTailnet ->
            "${diagnosis.authority} is a Tailscale address, but this device is not on that tailnet. " +
                "Join the same Tailscale network on this phone, or pair again over a direct address."

        is Diagnosis.TailnetPeerSilent ->
            "${diagnosis.authority} is on your Tailscale network but nothing answered. " +
                "Make sure DSH is running on the Mac and that the Mizar panel shows it listening."

        is Diagnosis.Silent ->
            "Nothing answered at ${diagnosis.authority}. Make sure DSH is running on the Mac and " +
                "that this phone is on the same network."

        Diagnosis.Offline ->
            "This device has no network connection."

        is Diagnosis.RequiresRepairing ->
            if (diagnosis.authority.isEmpty()) {
                "This computer no longer recognises this phone. Pair it again from the DSH-Mizar panel."
            } else {
                "${diagnosis.authority} answered, but it no longer recognises this phone. " +
                    "Pair it again: scan the code or enter the code the DSH-Mizar panel shows."
            }

        is Diagnosis.UnknownHost ->
            "The name ${diagnosis.authority} did not resolve. Check the address from the pairing code."

        is Diagnosis.Other -> diagnosis.detail
    }

    /** One line, with no platform internals in it. */
    private fun describe(error: Throwable): String =
        error.message?.takeIf { it.isNotBlank() } ?: error::class.simpleName ?: "unknown failure"
}
