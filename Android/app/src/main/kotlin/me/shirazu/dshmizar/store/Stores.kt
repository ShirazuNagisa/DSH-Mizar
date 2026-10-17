package me.shirazu.dshmizar.store

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.builtins.ListSerializer
import me.shirazu.mizar.kit.CredentialStore
import me.shirazu.mizar.kit.PairedHost
import me.shirazu.mizar.kit.SessionIndex
import me.shirazu.mizar.kit.SessionIndexStore
import me.shirazu.mizar.kit.WIRE_JSON
import java.io.File

/**
 * Paired hosts, in Keystore-backed storage.
 *
 * One blob holding every pairing, written update-then-add, which is how the iOS
 * client's Keychain item works and for the same reason: there must never be a
 * window with no credential on disk.
 *
 * Deliberately **not** a memory fallback. `InMemoryCredentialStore` exists for
 * tests; a real store that silently forgot a token would make pairing look like it
 * worked and lose it on the next launch, which is the failure that costs an
 * afternoon.
 */
class EncryptedCredentialStore(context: Context) : CredentialStore {

    private val prefs by lazy {
        val masterKey = MasterKey.Builder(context, MasterKey.DEFAULT_MASTER_KEY_ALIAS)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "mizar-credentials",
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }

    override suspend fun loadAll(): List<PairedHost> = withContext(Dispatchers.IO) {
        val stored = prefs.getString(KEY, null) ?: return@withContext emptyList()
        // A blob that will not decode reads as "not paired" rather than throwing: the
        // alternative is an app that cannot start until somebody clears its data.
        runCatching { WIRE_JSON.decodeFromString(ListSerializer(PairedHost.serializer()), stored) }
            .getOrDefault(emptyList())
            .sortedBy { it.pairedAtMillis }
    }

    override suspend fun save(host: PairedHost) = withContext(Dispatchers.IO) {
        val current = loadAll().associateBy { it.hostId }.toMutableMap()
        current[host.hostId] = host
        write(current.values.sortedBy { it.pairedAtMillis })
    }

    override suspend fun remove(hostId: String) = withContext(Dispatchers.IO) {
        val remaining = loadAll().filterNot { it.hostId == hostId }
        if (remaining.isEmpty()) prefs.edit().remove(KEY).apply() else write(remaining)
    }

    override suspend fun clear() = withContext(Dispatchers.IO) {
        prefs.edit().remove(KEY).apply()
    }

    private fun write(hosts: List<PairedHost>) {
        val body = WIRE_JSON.encodeToString(ListSerializer(PairedHost.serializer()), hosts)
        prefs.edit().putString(KEY, body).apply()
    }

    private companion object {
        const val KEY = "hosts"
    }
}

/**
 * Session lists, one JSON file per host.
 *
 * Files rather than `SharedPreferences` because a session list is a document, not a
 * setting: it grows, and it is rewritten whole every time the host answers.
 */
class FileSessionIndexStore(context: Context) : SessionIndexStore {

    private val directory = File(context.filesDir, "MizarIndex")

    override suspend fun load(hostId: String): SessionIndex? = withContext(Dispatchers.IO) {
        val file = fileFor(hostId)
        if (!file.isFile) return@withContext null
        val index = runCatching { WIRE_JSON.decodeFromString(SessionIndex.serializer(), file.readText()) }
            .getOrNull() ?: return@withContext null
        // A file saved for another host is not this host's list. Refusing it here
        // means a renamed or reused id can never show somebody else's sessions.
        if (index.hostId != hostId) null else index
    }

    override suspend fun save(index: SessionIndex) = withContext(Dispatchers.IO) {
        directory.mkdirs()
        val target = fileFor(index.hostId)
        val temporary = File(directory, "${target.name}.tmp")
        temporary.writeText(WIRE_JSON.encodeToString(SessionIndex.serializer(), index))
        // Atomic-ish: a crash mid-write leaves the previous list intact rather than a
        // half-written file that reads as "no sessions".
        if (!temporary.renameTo(target)) {
            target.writeText(temporary.readText())
            temporary.delete()
        }
    }

    override suspend fun remove(hostId: String) {
        withContext(Dispatchers.IO) { fileFor(hostId).delete() }
    }

    override suspend fun clear() {
        withContext(Dispatchers.IO) {
            directory.listFiles()?.forEach { it.delete() }
        }
    }

    private fun fileFor(hostId: String): File = File(directory, "${safe(hostId)}.json")

    /** `../../etc/passwd` becomes `.._.._etc_passwd`: one file, no traversal. */
    private fun safe(value: String): String = value.replace(Regex("[^A-Za-z0-9._-]"), "_")
}
