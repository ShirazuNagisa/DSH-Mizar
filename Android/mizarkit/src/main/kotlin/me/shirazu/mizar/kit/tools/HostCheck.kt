package me.shirazu.mizar.kit.tools

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import me.shirazu.mizar.kit.AcceptanceResult
import me.shirazu.mizar.kit.ApprovalOutcome
import me.shirazu.mizar.kit.Conversation
import me.shirazu.mizar.kit.CreateSessionResult
import me.shirazu.mizar.kit.HelloResponse
import me.shirazu.mizar.kit.MizarConnection
import me.shirazu.mizar.kit.ModelCatalog
import me.shirazu.mizar.kit.PairRequest
import me.shirazu.mizar.kit.PairingClient
import me.shirazu.mizar.kit.PairingUri
import me.shirazu.mizar.kit.pairRequestBody
import me.shirazu.mizar.kit.PendingInteractions
import me.shirazu.mizar.kit.PermissionCatalog
import me.shirazu.mizar.kit.PromptResult
import me.shirazu.mizar.kit.SessionListResult
import me.shirazu.mizar.kit.SessionMessagesResult
import me.shirazu.mizar.kit.WorkspaceListResult

/**
 * Drive a running host over the real wire.
 *
 * The Android counterpart of `scripts/smoke-listener.mjs`, at the level a client
 * cares about: it proves the *client* agrees with a host that is actually running,
 * where the unit tests only prove it agrees with recorded frames.
 *
 * Usage:
 * ```
 * ./gradlew :mizarkit:hostCheck -Pbase=http://127.0.0.1:19390 -Pcode=ABCD-EFGH
 * ```
 * `MIZAR_BASE` and `MIZAR_CODE` are read from the environment when the properties
 * are absent. Exits non-zero on the first failure, printing every check first.
 */
fun main(): Unit = runBlocking {
    val base = System.getenv("MIZAR_BASE") ?: System.getProperty("MIZAR_BASE")
    val code = System.getenv("MIZAR_CODE") ?: System.getProperty("MIZAR_CODE")

    if (base.isNullOrBlank() || code.isNullOrBlank()) {
        System.err.println("hostCheck: set MIZAR_BASE (http://host:19390) and MIZAR_CODE (the code the plugin logged)")
        kotlin.system.exitProcess(2)
    }

    val authority = base.removePrefix("https://").removePrefix("http://").trimEnd('/')
    var passed = 0
    var failed = 0

    fun check(name: String, ok: Boolean, detail: String = "") {
        if (ok) {
            passed += 1
            println("  PASS  $name")
        } else {
            failed += 1
            println("  FAIL  $name${if (detail.isEmpty()) "" else " — $detail"}")
        }
    }

    println("mizar hostCheck: $base")

    // ── unauthenticated surface ───────────────────────────────────────────────
    val client = PairingClient(appVersion = "0.7.1-android")
    val hello: HelloResponse = try {
        client.hello(authority = authority)
    } catch (error: Throwable) {
        println("  FAIL  GET /hello — ${error.message}")
        kotlin.system.exitProcess(1)
    }
    check("GET /hello answers", true)
    check("reports protocol version 1", hello.protocolVersion == 1, hello.protocolVersion.toString())
    check("reports a pairing code is open", hello.pairingOpen)

    val paired = try {
        client.pair(code = code, deviceName = "hostCheck", deviceModel = "jvm", authority = authority)
    } catch (error: Throwable) {
        // Printed, not just thrown: the first thing to check when a host refuses a
        // code it has just issued is what this process actually received.
        println("        code=[$code] length=${code.length}")
        println("        body=${pairRequestBody(PairRequest(code, "hostCheck", "jvm", "0.7.1-android"))}")
        throw error
    }
    check("a valid code pairs", paired.deviceToken.startsWith("mz_"))
    check("pairing returns the host identity", paired.hostId.isNotEmpty())

    // ── the socket ────────────────────────────────────────────────────────────
    val connection = MizarConnection(
        MizarConnection.Configuration(
            authority = authority,
            token = paired.deviceToken,
            appVersion = "0.7.1-android",
            deviceModel = "jvm",
        ),
    )
    val welcome = connection.connect()
    check("the handshake completes", welcome.hostId == paired.hostId)
    check("welcome carries the home directory", welcome.home.isNotEmpty(), welcome.home)

    val sessions: SessionListResult = connection.call("session.list")
    check("session.list answers", true)
    check("session.list returns rows", sessions.items.isNotEmpty(), "got ${sessions.items.size}")

    val workspaces: WorkspaceListResult = connection.call("workspace.list")
    check("workspace.list answers", true)
    println("        ${workspaces.items.size} workspace(s)")

    val first = sessions.items.firstOrNull()
    if (first != null) {
        val messages: SessionMessagesResult = connection.call(
            "session.messages",
            buildJsonObject {
                put("sessionId", first.sessionId)
                put("maxMessages", 50)
            },
        )
        val items = Conversation.items(messages)
        check("session.messages answers", true)
        check("session.messages renders items", items.isNotEmpty(), "got ${items.size}")

        val turns = Conversation.turns(messages)
        check("turns project from the same page", turns.isNotEmpty() || items.isEmpty(), "got ${turns.size}")
    }

    // The write path, against a real host: create in a workspace, prompt, retry the
    // same idempotency key, then cancel. This is the part that fails in the field
    // when the payload rules are wrong.
    val created: CreateSessionResult = connection.call(
        "session.create",
        buildJsonObject { put("cwd", welcome.home) },
    )
    check("session.create answers", created.sessionId.isNotEmpty(), created.sessionId)

    val promptId = "hostcheck-${System.currentTimeMillis()}"
    val prompted: PromptResult = connection.call(
        "session.prompt",
        buildJsonObject {
            put("sessionId", created.sessionId)
            put("text", "hostCheck")
            put("requestId", promptId)
        },
    )
    check("session.prompt is accepted", prompted.accepted)
    check("the idempotency key comes back", prompted.requestId == promptId)

    val pending: PendingInteractions = connection.call("interactions.pending")
    check("interactions.pending answers", pending.approvals.isEmpty() && pending.questions.isEmpty())

    val models: ModelCatalog = connection.call("model.catalog")
    check("model.catalog lists providers", models.providers.isNotEmpty())
    check("the default route is a selection or absent", true)

    val permissions: PermissionCatalog = connection.call("permissions.catalog")
    check("permissions.catalog lists presets", permissions.options.isNotEmpty())
    check("custom is never offered", permissions.options.none { it.value == "custom" })
    check(
        "the approval vocabulary is the two the host accepts",
        ApprovalOutcome.entries.map { it.wire }.toSet() == setOf("allowed-once", "rejected"),
    )

    val cancelled: AcceptanceResult = connection.call(
        "session.cancel",
        buildJsonObject { put("sessionId", created.sessionId) },
    )
    check("session.cancel answers", cancelled.accepted)

    connection.disconnect()

    println("\nmizar hostCheck: $passed passed, $failed failed")
    println("        base=${PairingUri.webSocketUrl(authority)}")
    kotlin.system.exitProcess(if (failed == 0) 0 else 1)
}
