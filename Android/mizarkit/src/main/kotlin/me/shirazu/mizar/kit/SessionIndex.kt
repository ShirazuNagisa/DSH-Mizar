package me.shirazu.mizar.kit

import kotlinx.serialization.Serializable

/**
 * What a host's session list looked like last time.
 *
 * Stored per host and loaded before the first request, so a phone that launches
 * without a network shows the sessions it knows about instead of an empty screen.
 * It is **additive**: a stored list never wipes what a live read has put on screen.
 */
@Serializable
data class SessionIndex(
    val hostId: String,
    val sessions: List<SessionRow> = emptyList(),
    val titles: Map<String, String> = emptyMap(),
    val workspacePaths: List<String> = emptyList(),
    val updatedAtMillis: Long = System.currentTimeMillis(),
)

/** Where an index lives. */
interface SessionIndexStore {
    /** The stored index, or `null` when there is none (or it is unreadable). */
    suspend fun load(hostId: String): SessionIndex?

    /** Replace it. */
    suspend fun save(index: SessionIndex)

    /** Forget one host. */
    suspend fun remove(hostId: String)

    /** Forget everything. */
    suspend fun clear()
}

/** A store that keeps nothing across launches. For tests, never as a fallback. */
class InMemorySessionIndexStore(initial: List<SessionIndex> = emptyList()) : SessionIndexStore {
    private val store = LinkedHashMap<String, SessionIndex>()

    init {
        for (index in initial) store[index.hostId] = index
    }

    override suspend fun load(hostId: String): SessionIndex? = store[hostId]

    override suspend fun save(index: SessionIndex) {
        store[index.hostId] = index
    }

    override suspend fun remove(hostId: String) {
        store.remove(hostId)
    }

    override suspend fun clear() {
        store.clear()
    }
}

/** One workspace's rows, ready to draw. */
data class WorkspaceGroup(
    val path: String,
    val title: String,
    val sessions: List<SessionRow>,
)

/**
 * Which sessions the list shows, and how they are grouped.
 *
 * These rules are the ones the iOS app arrived at after two rounds of "where did my
 * session go", and each has a reason:
 *
 *  - **Subagents and forks are hidden.** A delegated child has no row to open, so
 *    drawing one offers a tap that leads nowhere.
 *  - **Blank sessions are hidden** — unless it is the session the operator just
 *    created and is looking at, which would otherwise vanish on creation.
 *  - **The workspace set filters the list.** A session's directory outlives the
 *    workspace: deleting a workspace in DSH removes a registry entry, not the
 *    session log, so `session.list` still returns those sessions. Without this
 *    filter a deleted workspace stays on the phone forever. An *empty* answer means
 *    "this host could not tell us", not "there are none", and then nothing is
 *    filtered.
 */
object SessionGrouping {

    /** Whether a directory is one DSH still lists as a workspace. */
    fun isKnownWorkspace(cwd: String?, workspacePaths: Set<String>): Boolean =
        if (workspacePaths.isEmpty()) true else cwd != null && workspacePaths.contains(cwd)

    /** The sessions the list shows for a host. */
    fun visible(
        sessions: List<SessionRow>,
        workspacePaths: Set<String>,
        selectedSessionId: String?,
    ): List<SessionRow> = sessions.filter {
        !it.isSubagent &&
            (!it.blank || it.sessionId == selectedSessionId) &&
            isKnownWorkspace(it.cwd, workspacePaths)
    }

    /**
     * The groups, in the order they are drawn.
     *
     * Rows newest-activity first; groups by path ascending with the
     * no-workspace bucket **last**, because a bucket that means "unfiled" belongs at
     * the bottom rather than above the real work.
     */
    fun groups(
        sessions: List<SessionRow>,
        workspacePaths: Set<String>,
        selectedSessionId: String?,
    ): List<WorkspaceGroup> {
        val kept = visible(sessions, workspacePaths, selectedSessionId)
        val byPath = kept.groupBy { it.cwd ?: "" }

        // Two workspaces can share a last path component (`~/work/api` and
        // `~/other/api`). Naming both "api" is a list where one row is a guess, so
        // the collision falls back to the full path — the abbreviating the iOS app
        // does with `~` needs *its* home, which is not the Mac's.
        val ambiguous = byPath.keys
            .filter { it.isNotEmpty() }
            .groupBy { lastComponent(it) }
            .filterValues { it.size > 1 }
            .keys

        return byPath.entries
            .sortedWith(compareBy({ it.key.isEmpty() }, { it.key }))
            .map { (path, rows) ->
                WorkspaceGroup(
                    path = path,
                    title = when {
                        path.isEmpty() -> "No workspace"
                        lastComponent(path) in ambiguous -> path
                        else -> lastComponent(path)
                    },
                    sessions = rows.sortedByDescending { it.updatedAt },
                )
            }
    }

    /**
     * What to call one session.
     *
     * The host's title when it has one, otherwise the directory plus a short id —
     * a bare session id is not something anybody recognises, and the host reports no
     * title for most sessions.
     */
    fun sessionTitle(session: SessionRow, titles: Map<String, String>): String {
        titles[session.sessionId]?.takeIf { it.isNotBlank() }?.let { return it }
        val directory = session.cwd?.takeIf { it.isNotEmpty() }?.let { lastComponent(it) }
        return if (directory == null) session.sessionId else "$directory · ${session.sessionId.take(8)}"
    }

    /**
     * The last segment of a path, which is what a person calls a directory.
     *
     * Both separators, because a Windows host reports `E:\Projects\thing` while the
     * iOS client this was ported from only ever sees `/Users/you/thing`. Splitting on
     * `/` alone returned the whole path on Windows, so every workspace group was
     * titled with its full path and every session row read `E:\…\thing · 8c1f2a3b`
     * instead of `thing · 8c1f2a3b`.
     */
    fun lastComponent(path: String): String {
        val trimmed = path.trimEnd('/', '\\')
        if (trimmed.isEmpty()) return path
        val index = maxOf(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
        return if (index < 0) trimmed else trimmed.substring(index + 1).ifEmpty { trimmed }
    }
}
