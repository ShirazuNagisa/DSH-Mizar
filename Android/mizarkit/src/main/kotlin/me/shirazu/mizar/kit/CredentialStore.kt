package me.shirazu.mizar.kit

import kotlinx.serialization.Serializable

/**
 * One paired Mac.
 *
 * The device token is the whole credential: the host stores only its SHA-256, so
 * losing this record means pairing again, and leaking it means somebody else is this
 * phone.
 *
 * @property label the operator's own name for the machine, or `null` to use the
 *   host's. It is never sent anywhere.
 * @property authority `host:port` from the pairing code, when the code carried one.
 * @property baseUrl a relay base URL, when the host is behind one.
 */
@Serializable
data class PairedHost(
    val hostId: String,
    val hostName: String,
    val label: String? = null,
    val authority: String? = null,
    val baseUrl: String? = null,
    val deviceId: String,
    val deviceToken: String,
    val pairedAtMillis: Long = System.currentTimeMillis(),
) {
    /** What the UI calls this machine. */
    val displayName: String
        get() = label?.trim()?.takeIf { it.isNotEmpty() } ?: hostName

    /**
     * Where to try, in order.
     *
     * Direct before relay, because one QR code covers both "same Wi-Fi" and
     * "anywhere", and the good path should be the one taken when it is available.
     */
    val endpoints: List<MizarConnection.Endpoint>
        get() = buildList {
            authority?.takeIf { it.isNotEmpty() }?.let { add(MizarConnection.Endpoint.Direct(it)) }
            baseUrl?.takeIf { it.isNotEmpty() && PairingUri.isUsableBaseUrl(it) }
                ?.let { add(MizarConnection.Endpoint.Relay(it)) }
        }

    /** The connection settings for one endpoint. */
    fun configurationFor(endpoint: MizarConnection.Endpoint, appVersion: String?, deviceModel: String?) =
        when (endpoint) {
            is MizarConnection.Endpoint.Direct -> MizarConnection.Configuration(
                authority = endpoint.authority,
                token = deviceToken,
                appVersion = appVersion,
                deviceModel = deviceModel,
            )

            is MizarConnection.Endpoint.Relay -> MizarConnection.Configuration(
                baseUrl = endpoint.baseUrl,
                token = deviceToken,
                appVersion = appVersion,
                deviceModel = deviceModel,
                // A relay is reached over TLS and through nginx, so its handshake is
                // allowed to take longer than a LAN socket's.
                handshakeTimeoutMillis = 20_000,
            )
        }

    /**
     * This host, renamed. An empty label means "use the machine's own name".
     *
     * [movedTo] and [movedToRelay] deliberately drop the label, matching the Swift
     * client: after the address changes, a phone-local name that described the old
     * one is worse than the host's own.
     */
    fun renamed(to: String?): PairedHost = copy(label = to?.trim()?.takeIf { it.isNotEmpty() })

    /** The same host at a different direct address. */
    fun movedTo(authority: String): PairedHost = copy(authority = authority, label = null)

    /** The same host behind a different relay. */
    fun movedToRelay(baseUrl: String?): PairedHost = copy(baseUrl = baseUrl, label = null)
}

/**
 * Where paired hosts live.
 *
 * One blob for all of them, written update-then-add, and **never** a memory
 * fallback: silently degrading to memory makes a pairing look like it worked and
 * vanish on the next launch, which is the failure that costs an operator an
 * afternoon.
 */
interface CredentialStore {
    /** Every pairing, oldest first. */
    suspend fun loadAll(): List<PairedHost>

    /** Insert or replace by `hostId`. */
    suspend fun save(host: PairedHost)

    /** Forget one host. */
    suspend fun remove(hostId: String)

    /** Forget everything. */
    suspend fun clear()
}

/** The most recently paired host, which is the one a launch connects to. */
suspend fun CredentialStore.load(): PairedHost? = loadAll().maxByOrNull { it.pairedAtMillis }

/** A store that keeps nothing across launches. For tests, never as a fallback. */
class InMemoryCredentialStore(hosts: List<PairedHost> = emptyList()) : CredentialStore {
    private val store = LinkedHashMap<String, PairedHost>()

    init {
        for (host in hosts) store[host.hostId] = host
    }

    override suspend fun loadAll(): List<PairedHost> = store.values.toList()

    override suspend fun save(host: PairedHost) {
        store[host.hostId] = host
    }

    override suspend fun remove(hostId: String) {
        store.remove(hostId)
    }

    override suspend fun clear() {
        store.clear()
    }
}
