package me.shirazu.mizar.kit

import org.junit.jupiter.api.Test
import kotlin.test.*

/**
 * The rules that decide which sessions the list shows and how they are arranged.
 *
 * These are the rules the iOS app arrived at after two rounds of "where did my
 * session go" (`WorkspaceListView.workspaces` in `MainView.swift`, plus the caching
 * store pinned by `SessionIndexTests.swift`), and each one has a reason that is worth
 * a test rather than a comment:
 *
 *  - a delegated child has no row to open, so drawing one offers a tap that leads
 *    nowhere;
 *  - a blank session reads as `&lt;dir&gt; · session-` with a timestamp, which is
 *    indistinguishable from a real conversation;
 *  - the workspace set is the only thing standing between a deleted workspace and a
 *    row that stays on the phone forever -- and an *empty* set means "this host could
 *    not tell us", not "there are none".
 */
class SessionGroupingTest {

    private fun row(
        id: String,
        cwd: String? = "/Users/you/projects/demo",
        updatedAt: Double = 1_700_000_000_000.0,
        blank: Boolean = false,
        running: Boolean = false,
        agentAvailable: Boolean = true,
        parentSessionId: String? = null,
        origin: String? = null,
    ): SessionRow = SessionRow(
        sessionId = id,
        updatedAt = updatedAt,
        running = running,
        blank = blank,
        agentAvailable = agentAvailable,
        cwd = cwd,
        parentSessionId = parentSessionId,
        origin = origin,
    )

    // MARK: - visible

    @Test
    fun `subagents are hidden`() {
        // Marked by `origin`. They are real sessions, but they are the agent's
        // bookkeeping rather than the operator's work.
        val sessions = listOf(row("mine"), row("child", origin = "subagent"))
        assertEquals(listOf("mine"), SessionGrouping.visible(sessions, emptySet(), null).map { it.sessionId })
    }

    @Test
    fun `forks are hidden`() {
        // `isSubagent` rather than `parentSessionId`: a delegated child is marked by
        // *either* fact, and matching on only one leaves the other kind on the list.
        val sessions = listOf(row("mine"), row("fork", parentSessionId = "mine"))
        assertEquals(listOf("mine"), SessionGrouping.visible(sessions, emptySet(), null).map { it.sessionId })
        assertTrue(sessions[1].isSubagent)
    }

    @Test
    fun `blank sessions are hidden`() {
        // A session nobody has typed into yet has no title, no turns and no
        // messages. Measured against a live host, one workspace held eight rows of
        // which five were subagents and two were blank.
        val sessions = listOf(row("typed"), row("empty", blank = true))
        assertEquals(listOf("typed"), SessionGrouping.visible(sessions, emptySet(), null).map { it.sessionId })
    }

    @Test
    fun `the selected blank session is exempt`() {
        // A session created from the phone starts blank, and hiding it the moment
        // it is created would make the row the operator just tapped vanish under
        // their finger.
        val sessions = listOf(row("typed"), row("empty", blank = true))
        assertEquals(
            listOf("typed", "empty"),
            SessionGrouping.visible(sessions, emptySet(), selectedSessionId = "empty").map { it.sessionId },
        )
    }

    @Test
    fun `selecting one session does not unblank another`() {
        val sessions = listOf(row("empty-a", blank = true), row("empty-b", blank = true))
        assertEquals(
            listOf("empty-b"),
            SessionGrouping.visible(sessions, emptySet(), selectedSessionId = "empty-b").map { it.sessionId },
        )
    }

    @Test
    fun `a blank subagent stays hidden even when it is selected`() {
        // The exemption is for blankness only; a subagent has no row to open, and
        // that is true whether or not somebody is looking at it.
        val sessions = listOf(row("child", blank = true, origin = "subagent"))
        assertTrue(SessionGrouping.visible(sessions, emptySet(), selectedSessionId = "child").isEmpty())
    }

    // MARK: - isKnownWorkspace

    @Test
    fun `an empty workspace set means unknown and filters nothing`() {
        // The old behaviour is the safe one to fall back to, because hiding a
        // workspace somebody is working in is worse than showing one they deleted.
        assertTrue(SessionGrouping.isKnownWorkspace("/Users/you/projects/demo", emptySet()))
        assertTrue(SessionGrouping.isKnownWorkspace(null, emptySet()))
        val sessions = listOf(row("known"), row("gone", cwd = "/tmp/deleted"), row("unfiled", cwd = null))
        assertEquals(
            listOf("known", "gone", "unfiled"),
            SessionGrouping.visible(sessions, emptySet(), null).map { it.sessionId },
        )
    }

    @Test
    fun `a known set keeps only the directories in it`() {
        // A session is not a workspace. Deleting a workspace removes the host's
        // registry entry and leaves the session log on disk, so `session.list` keeps
        // returning sessions from directories DSH no longer recognises.
        val known = setOf("/Users/you/projects/demo")
        assertTrue(SessionGrouping.isKnownWorkspace("/Users/you/projects/demo", known))
        assertFalse(SessionGrouping.isKnownWorkspace("/tmp/deleted", known))

        val sessions = listOf(row("kept"), row("dropped", cwd = "/tmp/deleted"))
        assertEquals(listOf("kept"), SessionGrouping.visible(sessions, known, null).map { it.sessionId })
    }

    @Test
    fun `a known set drops a session with no directory`() {
        // `null` is not in any set, and a session whose directory the host did not
        // report cannot be shown to belong to a workspace it still lists.
        val known = setOf("/Users/you/projects/demo")
        assertFalse(SessionGrouping.isKnownWorkspace(null, known))
        val sessions = listOf(row("kept"), row("unfiled", cwd = null))
        assertEquals(listOf("kept"), SessionGrouping.visible(sessions, known, null).map { it.sessionId })
    }

    @Test
    fun `the workspace filter does not exempt the selected session`() {
        // The exemption is for blankness. A session in a workspace DSH no longer
        // lists is a row with nothing to open it in.
        val selected = row("selected", cwd = "/tmp/deleted")
        assertTrue(SessionGrouping.visible(listOf(selected), setOf("/Users/you"), "selected").isEmpty())
    }

    // MARK: - groups

    @Test
    fun `sessions are grouped by directory`() {
        val sessions = listOf(
            row("a", cwd = "/work/alpha"),
            row("b", cwd = "/work/beta"),
            row("c", cwd = "/work/alpha"),
        )
        val groups = SessionGrouping.groups(sessions, emptySet(), null)
        assertEquals(listOf("/work/alpha", "/work/beta"), groups.map { it.path })
        assertEquals(listOf("a", "c"), groups[0].sessions.map { it.sessionId })
    }

    @Test
    fun `rows come back newest first inside a group`() {
        val sessions = listOf(
            row("old", cwd = "/work/alpha", updatedAt = 1_000.0),
            row("new", cwd = "/work/alpha", updatedAt = 3_000.0),
            row("middle", cwd = "/work/alpha", updatedAt = 2_000.0),
        )
        val groups = SessionGrouping.groups(sessions, emptySet(), null)
        assertEquals(listOf("new", "middle", "old"), groups[0].sessions.map { it.sessionId })
    }

    @Test
    fun `groups come back by path, with the unfiled bucket last`() {
        // A bucket that means "unfiled" belongs at the bottom rather than above the
        // real work: those are the sessions an operator can least identify, so they
        // should not lead.
        val sessions = listOf(
            row("z", cwd = "/work/zeta"),
            row("none", cwd = null),
            row("a", cwd = "/work/alpha"),
        )
        val groups = SessionGrouping.groups(sessions, emptySet(), null)
        assertEquals(listOf("/work/alpha", "/work/zeta", ""), groups.map { it.path })
        assertEquals("No workspace", groups.last().title)
    }

    @Test
    fun `a group is titled by its last path component`() {
        val groups = SessionGrouping.groups(
            listOf(row("a", cwd = "/Users/you/projects/demo")),
            emptySet(),
            null,
        )
        assertEquals("demo", groups[0].title)
        assertEquals("/Users/you/projects/demo", groups[0].path)
    }

    @Test
    fun `two workspaces that share a last component are titled in full`() {
        // Two workspaces can share a last path component (`~/work/api` and
        // `~/other/api`). Naming both "api" is a list where one row is a guess, so
        // the collision falls back to the full path.
        val groups = SessionGrouping.groups(
            listOf(row("a", cwd = "/Users/you/work/api"), row("b", cwd = "/Users/you/other/api")),
            emptySet(),
            null,
        )
        assertEquals(listOf("/Users/you/other/api", "/Users/you/work/api"), groups.map { it.title })
    }

    @Test
    fun `groups drop what the row-level filters drop`() {
        val sessions = listOf(
            row("kept", cwd = "/work/alpha"),
            row("blank", cwd = "/work/alpha", blank = true),
            row("child", cwd = "/work/alpha", origin = "subagent"),
            row("deleted", cwd = "/tmp/deleted"),
        )
        val groups = SessionGrouping.groups(sessions, setOf("/work/alpha"), null)
        assertEquals(1, groups.size)
        assertEquals(listOf("kept"), groups[0].sessions.map { it.sessionId })
    }

    @Test
    fun `a host that knows of no workspaces still groups what it has`() {
        val groups = SessionGrouping.groups(listOf(row("unfiled", cwd = null)), emptySet(), null)
        assertEquals(1, groups.size)
        assertEquals("", groups[0].path)
        assertEquals("No workspace", groups[0].title)
    }

    @Test
    fun `the empty list is an empty list of groups`() {
        assertTrue(SessionGrouping.visible(emptyList(), emptySet(), null).isEmpty())
        assertTrue(SessionGrouping.groups(emptyList(), emptySet(), null).isEmpty())
    }

    // MARK: - sessionTitle

    @Test
    fun `sessionTitle prefers the host's title`() {
        val session = row("abcdef1234567890", cwd = "/Users/you/projects/demo")
        assertEquals(
            "Refactor the parser",
            SessionGrouping.sessionTitle(session, mapOf("abcdef1234567890" to "Refactor the parser")),
        )
    }

    @Test
    fun `sessionTitle falls back to the directory and a short id`() {
        // The host reports no title for most sessions, and a bare session id is not
        // something anybody recognises.
        val session = row("abcdef1234567890", cwd = "/Users/you/projects/demo")
        assertEquals("demo · abcdef12", SessionGrouping.sessionTitle(session, emptyMap()))
    }

    @Test
    fun `sessionTitle ignores a blank title`() {
        // A title of only spaces is a title the host has not really assigned; the
        // row would read as whitespace.
        val session = row("abcdef1234567890", cwd = "/Users/you/projects/demo")
        assertEquals("demo · abcdef12", SessionGrouping.sessionTitle(session, mapOf("abcdef1234567890" to "   ")))
        assertEquals("demo · abcdef12", SessionGrouping.sessionTitle(session, mapOf("abcdef1234567890" to "")))
    }

    @Test
    fun `sessionTitle falls back to the id alone when there is no directory`() {
        val session = row("abcdef1234567890", cwd = null)
        assertEquals("abcdef1234567890", SessionGrouping.sessionTitle(session, emptyMap()))
        assertEquals("abcdef1234567890", SessionGrouping.sessionTitle(row("abcdef1234567890", cwd = ""), emptyMap()))
    }

    @Test
    fun `sessionTitle of an empty id is the empty id`() {
        // Nothing to shorten and nothing to name it by -- and no crash, which is
        // what `take` on a short id has to be checked for.
        assertEquals("", SessionGrouping.sessionTitle(row("", cwd = null), emptyMap()))
        assertEquals("short", SessionGrouping.sessionTitle(row("short", cwd = null), emptyMap()))
    }

    // MARK: - lastComponent

    @Test
    fun `lastComponent is the last segment of a path`() {
        assertEquals("demo", SessionGrouping.lastComponent("/Users/you/projects/demo"))
        assertEquals("demo", SessionGrouping.lastComponent("/Users/you/projects/demo/"))
        assertEquals("demo", SessionGrouping.lastComponent("/Users/you/projects/demo///"))
        assertEquals("demo", SessionGrouping.lastComponent("demo"))
    }

    @Test
    fun `lastComponent of nothing is nothing`() {
        // The empty-path bucket is a real bucket, and its name must not become the
        // empty segment after the slash.
        assertEquals("", SessionGrouping.lastComponent(""))
        assertEquals("/", SessionGrouping.lastComponent("/"))
    }

    @Test
    fun `lastComponent keeps a directory with an emoji or a space`() {
        assertEquals("emoji 😀", SessionGrouping.lastComponent("/Users/you/项目/emoji 😀"))
        assertEquals("my project", SessionGrouping.lastComponent("/Users/you/work/my project"))
    }

    @Test
    fun `lastComponent understands a Windows path`() {
        // Found on the device, not in a test: a Windows host reports
        // `E:\Projects\DSH-Mizar`, and splitting on `/` alone returned the whole
        // path — so every workspace group was titled with its full path and every
        // session row read `E:\…\thing · 8c1f2a3b`. The iOS client never met a
        // backslash; this port has to.
        assertEquals("DSH-Mizar", SessionGrouping.lastComponent("E:\\Projects\\DSH-Mizar"))
        assertEquals("DSH-Mizar", SessionGrouping.lastComponent("E:\\Projects\\DSH-Mizar\\"))
        assertEquals(".devhome", SessionGrouping.lastComponent("E:\\Projects\\DSH-Mizar\\.devhome"))
        assertEquals("thing", SessionGrouping.lastComponent("C:\\thing"))

        // And the same path through the title, which is what the row draws.
        val session = row("abcdef1234567890", cwd = "E:\\Projects\\DSH-Mizar")
        assertEquals("DSH-Mizar · abcdef12", SessionGrouping.sessionTitle(session, emptyMap()))

        // Two Windows workspaces sharing a last component still resolve to full
        // paths rather than two identical labels.
        val groups = SessionGrouping.groups(
            listOf(
                row("s1", cwd = "E:\\one\\api"),
                row("s2", cwd = "E:\\two\\api"),
            ),
            workspacePaths = setOf("E:\\one\\api", "E:\\two\\api"),
            selectedSessionId = null,
        )
        assertEquals(listOf("E:\\one\\api", "E:\\two\\api"), groups.map { it.title })
    }
}
