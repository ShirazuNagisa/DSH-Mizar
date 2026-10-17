package me.shirazu.dshmizar

import android.app.Application
import android.os.Build
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import me.shirazu.dshmizar.push.PushTokens
import me.shirazu.dshmizar.store.EncryptedCredentialStore
import me.shirazu.dshmizar.store.FileSessionIndexStore
import me.shirazu.mizar.kit.AcceptanceResult
import me.shirazu.mizar.kit.ApprovalOutcome
import me.shirazu.mizar.kit.Backoff
import me.shirazu.mizar.kit.Conversation
import me.shirazu.mizar.kit.ConversationItem
import me.shirazu.mizar.kit.ConversationTurn
import me.shirazu.mizar.kit.CreateSessionResult
import me.shirazu.mizar.kit.CredentialStore
import me.shirazu.mizar.kit.Diagnoses
import me.shirazu.mizar.kit.MizarConnection
import me.shirazu.mizar.kit.ModelCatalog
import me.shirazu.mizar.kit.ModelSelection
import me.shirazu.mizar.kit.PairedHost
import me.shirazu.mizar.kit.PairingTarget
import me.shirazu.mizar.kit.PairingClient
import me.shirazu.mizar.kit.PendingInteractions
import me.shirazu.mizar.kit.PermissionCatalog
import me.shirazu.mizar.kit.PromptResult
import me.shirazu.mizar.kit.QuestionAnswer
import me.shirazu.mizar.kit.SessionIndex
import me.shirazu.mizar.kit.SessionIndexStore
import me.shirazu.mizar.kit.SessionGrouping
import me.shirazu.mizar.kit.SessionListResult
import me.shirazu.mizar.kit.SessionMessagesResult
import me.shirazu.mizar.kit.SessionRecord
import me.shirazu.mizar.kit.SessionRow
import me.shirazu.mizar.kit.SessionStatsFrame
import me.shirazu.mizar.kit.SessionStatsResult
import me.shirazu.mizar.kit.ServerFrame
import me.shirazu.mizar.kit.WorkspaceGroup
import me.shirazu.mizar.kit.WorkspaceListResult
import me.shirazu.mizar.kit.get
import me.shirazu.mizar.kit.intValue
import me.shirazu.mizar.kit.jsonBool
import me.shirazu.mizar.kit.jsonString
import me.shirazu.mizar.kit.mergeConversations
import me.shirazu.mizar.kit.mergeTurns
import java.io.IOException
import java.util.UUID

/** Which screen the app is on, which is a property of the connection rather than of navigation. */
enum class Phase { LAUNCHING, UNPAIRED, CONNECTING, READY, FAILED }

/** Everything the UI draws. */
data class UiState(
    val phase: Phase = Phase.LAUNCHING,
    val hosts: List<PairedHost> = emptyList(),
    val host: PairedHost? = null,
    val welcome: ServerFrame.Welcome? = null,
    val sessions: List<SessionRow> = emptyList(),
    val titles: Map<String, String> = emptyMap(),
    val workspacePaths: Set<String> = emptySet(),
    val groups: List<WorkspaceGroup> = emptyList(),
    val selectedSessionId: String? = null,
    val conversation: List<ConversationItem> = emptyList(),
    val turns: List<ConversationTurn> = emptyList(),
    val oldestSeq: Int? = null,
    val hasMore: Boolean = false,
    val exhausted: Boolean = false,
    val stats: SessionStatsFrame? = null,
    val pending: PendingInteractions? = null,
    val modelCatalog: ModelCatalog? = null,
    val permissionCatalog: PermissionCatalog? = null,
    val modelChoice: Map<String, ModelSelection> = emptyMap(),
    val problem: String? = null,
    /** A dropped socket is being retried; the screen stays as it was. */
    val reconnecting: Boolean = false,
    /** Why the last connection ended, shown beside the reconnect notice. */
    val disconnectReason: String? = null,
    /**
     * The host refused this phone's credential: only pairing again can help, so the
     * screen must offer that instead of a retry that cannot work.
     */
    val needsPairing: Boolean = false,
    val statsError: String? = null,
    val conversationError: String? = null,
    val loadingConversation: Boolean = false,
    val busy: Boolean = false,
)

/**
 * The app's one state holder.
 *
 * It owns the connection, the session list, the open conversation and the
 * interaction surface, because all four are views of the same socket: a fresh
 * connection invalidates every one of them together.
 *
 * Two behaviours here are ports of bugs the iOS app paid for:
 *
 *  - **A refresh that arrives while one is running is remembered, not dropped.**
 *    Dropping it made the screen ignore the operator asking it to refresh.
 *  - **A load that returns nothing on a live connection is retried once.** The first
 *    request after a launch lands while the socket is still settling, and without
 *    the retry the figures above the composer and the transcript both stay blank
 *    until the operator leaves the session and comes back.
 */
class AppViewModel(application: Application) : AndroidViewModel(application) {

    private val credentials: CredentialStore = EncryptedCredentialStore(application)
    private val indexStore: SessionIndexStore = FileSessionIndexStore(application)

    private val _state = MutableStateFlow(UiState())
    val state: StateFlow<UiState> = _state.asStateFlow()

    private var connection: MizarConnection? = null
    /** Watches the live connection's state, so a dropped socket is noticed. */
    private var connectionObserver: Job? = null
    /** The single automatic retry loop; never two at once. */
    private var reconnectJob: Job? = null
    /** Last presence we reported, re-asserted after a reconnect. */
    private var foreground = true
    private var watchers: Job? = null

    /** Guards the load, and remembers a request that arrived during one. */
    private var loading = false
    private var reloadWanted = false

    private val appVersion: String get() = BuildConfig.VERSION_NAME
    private val deviceModel: String
        get() = listOf(Build.MANUFACTURER, Build.MODEL).filter { it.isNotBlank() }.joinToString(" ")

    // ── launch, pairing, connection ──────────────────────────────────────────

    /** Load what is stored and connect to the most recent host. */
    fun start() {
        viewModelScope.launch {
            val hosts = credentials.loadAll().sortedBy { it.pairedAtMillis }
            val host = hosts.lastOrNull()
            if (host == null) {
                _state.update { it.copy(phase = Phase.UNPAIRED, hosts = emptyList()) }
                return@launch
            }
            _state.update { it.copy(phase = Phase.CONNECTING, hosts = hosts, host = host) }
            connect(host)
        }
    }

    /** Redeem a scanned or typed pairing code. */
    fun pair(target: PairingTarget, deviceName: String) {
        viewModelScope.launch {
            _state.update { it.copy(phase = Phase.CONNECTING, problem = null) }
            val client = PairingClient(appVersion = appVersion)
            try {
                val paired = client.pair(
                    code = target.code,
                    deviceName = deviceName.ifBlank { "Android" },
                    deviceModel = deviceModel,
                    authority = target.authority,
                    baseUrl = target.baseUrl,
                )
                credentials.save(paired)
                val hosts = credentials.loadAll().sortedBy { it.pairedAtMillis }
                _state.update { it.copy(hosts = hosts, host = paired) }
                connect(paired)
            } catch (error: Throwable) {
                _state.update { it.copy(phase = Phase.FAILED, problem = messageOf(error, target.authority ?: target.baseUrl)) }
            }
        }
    }

    private suspend fun connect(host: PairedHost) {
        stopWatchers()
        connection?.disconnect()
        connection = null

        // The stored list first: a phone with no network still shows what it knows.
        indexStore.load(host.hostId)?.let { applyIndex(it) }

        var failure: Throwable? = null
        for (endpoint in host.endpoints) {
            val candidate = MizarConnection(host.configurationFor(endpoint, appVersion, deviceModel))
            try {
                val welcome = candidate.connect()
                connection = candidate
                _state.update {
                    it.copy(phase = Phase.READY, welcome = welcome, problem = null, needsPairing = false)
                }
                startWatchers(candidate)
                watchConnection(candidate, host)
                refreshSessions()
                registerPush(candidate)
                return
            } catch (error: Throwable) {
                failure = error
                candidate.disconnect()
            }
        }

        val address = host.authority ?: host.baseUrl
        _state.update {
            it.copy(
                phase = Phase.FAILED,
                problem = messageOf(failure ?: IOException("no address answered"), address),
                needsPairing = failure?.isRepairNeeded() == true,
            )
        }
    }

    /**
     * Notice when the live connection dies, and reconnect.
     *
     * The connection layer already reports a close — `closeSocket` ends on
     * `State.Failed` — but nothing in this app ever watched that state. So a dropped
     * socket left the app looking connected: sessions still listed, every poll failing
     * silently, no error anywhere, and no way back except relaunching the app. That is
     * exactly what a host restart used to do to the phone.
     */
    private fun watchConnection(socket: MizarConnection, host: PairedHost) {
        connectionObserver?.cancel()
        connectionObserver = viewModelScope.launch {
            socket.state.collect { state ->
                // Only the connection on screen may start a reconnect: a replaced one
                // failing later is old news, and two loops would fight.
                if (state is MizarConnection.State.Failed && connection === socket) {
                    beginReconnect(host, state.message)
                }
            }
        }
    }

    /**
     * Retry a dropped connection on the documented backoff, without disturbing the screen.
     *
     * `phase` deliberately stays READY. The operator may be reading a conversation, and
     * throwing them back to the list for a two-second blip is worse than a banner that
     * says what is happening. The schedule is the protocol's own (0.5 s → 10 s with
     * jitter) and it is finite: exhausting it means the host is really gone, which is
     * the failure screen's job to say.
     *
     * @param host - the host to dial again.
     * @param reason - what the connection said when it ended, shown beside the banner.
     */
    private fun beginReconnect(host: PairedHost, reason: String) {
        if (reconnectJob?.isActive == true) return
        reconnectJob = viewModelScope.launch {
            stopWatchers()
            _state.update { it.copy(reconnecting = true, disconnectReason = reason) }
            val backoff = Backoff.standard
            repeat(6) {
                delay((backoff.nextDelay() * 1000).toLong())
                _state.update { it.copy(problem = null) }
                try {
                    connect(host)
                } catch (error: Throwable) {
                    // A refused credential ends the whole affair: the host answered and
                    // said it does not know this phone, so every further attempt is the
                    // same rejection. Stop, and send the operator to pairing.
                    if (error.isRepairNeeded()) {
                        _state.update {
                            it.copy(
                                phase = Phase.FAILED,
                                reconnecting = false,
                                needsPairing = true,
                                problem = messageOf(error, host.authority ?: host.baseUrl),
                            )
                        }
                        return@launch
                    }
                    // `connect` marks the phase FAILED on every failure; during a retry
                    // that would swap the screen for the failure page between attempts,
                    // which is worse than the banner. Put the phase back and keep going.
                    _state.update { if (it.reconnecting) it.copy(phase = Phase.READY) else it }
                    return@repeat
                }
                if (_state.value.phase == Phase.READY) {
                    backoff.reset()
                    _state.update { it.copy(reconnecting = false, disconnectReason = null) }
                    // The host forgot we were on screen while we were away.
                    setPresence(foreground)
                    return@launch
                }
            }
            _state.update {
                it.copy(
                    phase = Phase.FAILED,
                    reconnecting = false,
                    problem = "lost the connection to ${host.displayName}: $reason",
                )
            }
        }
    }

    /** Stop any automatic retry; a caller that dials something else owns the socket now. */
    private fun cancelReconnect() {
        reconnectJob?.cancel()
        reconnectJob = null
    }

    /** Try the stored host again, patiently. */
    fun retry() {
        cancelReconnect()
        val host = _state.value.host
        if (host == null) {
            start()
            return
        }
        viewModelScope.launch {
            _state.update { it.copy(phase = Phase.CONNECTING, problem = null) }
            connect(host)
        }
    }

    /**
     * Open another Mac that is already paired.
     *
     * The session list and the open conversation are cleared first: they belong to
     * the previous host, and leaving them on screen while the new one connects shows
     * one machine's conversations under another machine's name.
     */
    fun openHost(hostId: String) {
        cancelReconnect()
        viewModelScope.launch {
            val host = credentials.loadAll().firstOrNull { it.hostId == hostId } ?: return@launch
            _state.update {
                it.copy(
                    host = host,
                    phase = Phase.CONNECTING,
                    selectedSessionId = null,
                    sessions = emptyList(),
                    groups = emptyList(),
                    titles = emptyMap(),
                    conversation = emptyList(),
                    turns = emptyList(),
                    stats = null,
                    problem = null,
                )
            }
            connect(host)
        }
    }

    /**
     * Go to the pairing screen without forgetting anything.
     *
     * The connection is dropped while pairing, because a code is redeemed by a phone
     * that is not yet a client of anything.
     */
    fun startPairing() {
        cancelReconnect()
        viewModelScope.launch {
            stopWatchers()
            connection?.disconnect()
            connection = null
            _state.update {
                it.copy(phase = Phase.UNPAIRED, problem = null, needsPairing = false, selectedSessionId = null)
            }
        }
    }

    /** Forget one Mac, here and at the relay. */
    fun forget(hostId: String) {
        viewModelScope.launch {
            val wasOpen = _state.value.host?.hostId == hostId
            if (wasOpen) {
                cancelReconnect()
                runCatching { connection?.call<AcceptanceResult>("push.unregister") }
                stopWatchers()
                connection?.disconnect()
                connection = null
            }
            credentials.remove(hostId)
            indexStore.remove(hostId)
            val hosts = credentials.loadAll().sortedBy { it.pairedAtMillis }
            if (wasOpen) {
                _state.value = UiState(phase = if (hosts.isEmpty()) Phase.UNPAIRED else Phase.CONNECTING, hosts = hosts)
                hosts.lastOrNull()?.let { connect(it) }
            } else {
                _state.update { it.copy(hosts = hosts) }
            }
        }
    }

    // ── sessions ────────────────────────────────────────────────────────────

    fun refreshSessions() {
        viewModelScope.launch { refreshSessionsNow() }
    }

    private suspend fun refreshSessionsNow() {
        val socket = connection ?: return
        val list = try {
            socket.call<SessionListResult>("session.list")
        } catch (error: Throwable) {
            _state.update { it.copy(problem = messageOf(error, addressOf())) }
            return
        }

        // Best effort, and an empty answer is treated as no answer: a host that
        // genuinely has no workspaces is a host with no sessions, and clearing the
        // set here would empty the list it is used to filter.
        val paths = runCatching {
            socket.call<WorkspaceListResult>("workspace.list").items.map { it.path }.toSet()
        }.getOrNull()

        _state.update { current ->
            current.copy(
                sessions = list.items,
                workspacePaths = if (paths.isNullOrEmpty()) current.workspacePaths else paths,
                problem = null,
            )
        }
        regroup()
        persistIndex()
    }

    /** Load titles for rows about to be drawn, one request per session, once each. */
    fun loadTitles(sessionIds: List<String>) {
        viewModelScope.launch {
            val socket = connection ?: return@launch
            var learned = false
            for (id in sessionIds) {
                if (_state.value.titles.containsKey(id)) continue
                val title = runCatching { socket.call<SessionStatsResult>("session.stats", payload("sessionId" to jsonString(id))).stats?.title }
                    .getOrNull()
                if (!title.isNullOrBlank()) {
                    _state.update { it.copy(titles = it.titles + (id to title)) }
                    learned = true
                }
            }
            if (learned) persistIndex()
        }
    }

    fun selectSession(sessionId: String?) {
        _state.update {
            it.copy(
                selectedSessionId = sessionId,
                conversation = emptyList(),
                turns = emptyList(),
                stats = null,
                oldestSeq = null,
                hasMore = false,
                exhausted = false,
                conversationError = null,
                statsError = null,
                pending = null,
            )
        }
        if (sessionId == null) return
        viewModelScope.launch {
            reload()
            refreshInteractions()
        }
    }

    /** Create a session in a directory, which the host turns into a workspace. */
    fun createSession(cwd: String) {
        viewModelScope.launch {
            val socket = connection ?: return@launch
            _state.update { it.copy(busy = true) }
            try {
                // Only `cwd`. The host resolves it to a workspace and creates one when
                // DSH has none; sending `workspaceId` as well is refused outright, and
                // a session that belongs to no workspace is one the Mac never lists.
                val created = socket.call<CreateSessionResult>(
                    "session.create",
                    buildJsonObject { put("cwd", cwd) },
                )
                // Workspaces too, or the new session's directory is not in the set the
                // list filters by and the session would vanish from this screen.
                refreshSessionsNow()
                selectSession(created.sessionId)
            } catch (error: Throwable) {
                _state.update { it.copy(problem = messageOf(error, addressOf())) }
            } finally {
                _state.update { it.copy(busy = false) }
            }
        }
    }

    // ── the open conversation ───────────────────────────────────────────────

    /** Load the open session, with the latch and the retry described on this class. */
    suspend fun reload() {
        if (loading) {
            reloadWanted = true
            return
        }
        loading = true
        try {
            loadOnce()
            val current = _state.value
            if (current.phase == Phase.READY && (current.stats == null || current.conversation.isEmpty())) {
                delay(700)
                loadOnce()
            }
            while (reloadWanted) {
                reloadWanted = false
                loadOnce()
            }
        } finally {
            loading = false
        }
    }

    private suspend fun loadOnce() {
        val socket = connection ?: return
        val sessionId = _state.value.selectedSessionId ?: return
        _state.update { it.copy(loadingConversation = true) }

        try {
            val page = socket.call<SessionMessagesResult>(
                "session.messages",
                payload("sessionId" to jsonString(sessionId), "maxMessages" to me.shirazu.mizar.kit.jsonInt(200)),
            )
            val fresh = Conversation.items(page)
            val freshTurns = Conversation.turns(page)
            val oldest = page.records.firstNotNullOfOrNull { SessionRecord(it).payload["seq"].intValue() }
            _state.update { current ->
                current.copy(
                    conversation = mergeConversations(current.conversation, fresh),
                    turns = mergeTurns(current.turns, freshTurns),
                    oldestSeq = listOfNotNull(current.oldestSeq, oldest).minOrNull(),
                    hasMore = page.hasMore,
                    conversationError = null,
                )
            }
        } catch (error: Throwable) {
            _state.update { it.copy(conversationError = messageOf(error, addressOf())) }
        }

        try {
            val stats = socket.call<SessionStatsResult>("session.stats", payload("sessionId" to jsonString(sessionId)))
            _state.update { it.copy(stats = stats.stats, statsError = null) }
        } catch (error: Throwable) {
            _state.update { it.copy(statsError = messageOf(error, addressOf())) }
        }

        _state.update { it.copy(loadingConversation = false) }
    }

    /**
     * Load an older page.
     *
     * @returns the number of items added, `0` when the host says there is nothing
     *   older, or `null` when it could not be asked — which must never be read as
     *   "the top of the conversation".
     */
    suspend fun loadOlder(): Int? {
        val socket = connection ?: return null
        val current = _state.value
        val sessionId = current.selectedSessionId ?: return null
        val before = current.oldestSeq ?: return null
        if (!current.hasMore) {
            _state.update { it.copy(exhausted = true) }
            return 0
        }

        return try {
            val page = socket.call<SessionMessagesResult>(
                "session.messages",
                payload(
                    "sessionId" to jsonString(sessionId),
                    "maxMessages" to me.shirazu.mizar.kit.jsonInt(200),
                    "beforeSeq" to me.shirazu.mizar.kit.jsonInt(before),
                ),
            )
            val reached = page.records.firstNotNullOfOrNull { SessionRecord(it).payload["seq"].intValue() }
            if (reached == null || reached == before || page.records.isEmpty()) {
                _state.update { it.copy(exhausted = true, hasMore = false) }
                return 0
            }
            val fresh = Conversation.items(page)
            val freshTurns = Conversation.turns(page)
            val before_count = _state.value.conversation.size
            _state.update {
                it.copy(
                    conversation = mergeConversations(it.conversation, fresh),
                    turns = mergeTurns(it.turns, freshTurns),
                    oldestSeq = listOfNotNull(before, reached).minOrNull(),
                    hasMore = page.hasMore,
                )
            }
            _state.value.conversation.size - before_count
        } catch (_: Throwable) {
            null
        }
    }

    fun sendPrompt(text: String) {
        if (text.isBlank()) return
        viewModelScope.launch {
            val socket = connection ?: return@launch
            val sessionId = _state.value.selectedSessionId ?: return@launch
            // A fresh key per submission: reusing one would make a second identical
            // message look like a retry of the first and be dropped by the host.
            val requestId = UUID.randomUUID().toString()
            try {
                val result = socket.call<PromptResult>(
                    "session.prompt",
                    payload(
                        "sessionId" to jsonString(sessionId),
                        "text" to jsonString(text),
                        "requestId" to jsonString(requestId),
                    ),
                )
                if (!result.accepted) {
                    _state.update { it.copy(problem = "the host did not accept the message") }
                    return@launch
                }
                awaitPromptRecorded(text)
                reload()
            } catch (error: Throwable) {
                _state.update { it.copy(problem = messageOf(error, addressOf())) }
            }
        }
    }

    /**
     * Wait for the host to record what was just sent.
     *
     * The log is written asynchronously, so a single read after an accepted prompt
     * usually does not contain it — which looks exactly like a message that was
     * silently dropped.
     */
    private suspend fun awaitPromptRecorded(text: String) {
        repeat(8) {
            loadOnce()
            val recorded = _state.value.conversation.any {
                it is ConversationItem.Message && it.role == ConversationItem.Role.USER && it.text == text
            }
            if (recorded) return
            delay(500)
        }
    }

    fun cancelTurn() {
        viewModelScope.launch {
            val socket = connection ?: return@launch
            val sessionId = _state.value.selectedSessionId ?: return@launch
            runCatching { socket.call<AcceptanceResult>("session.cancel", payload("sessionId" to jsonString(sessionId))) }
            reload()
        }
    }

    // ── interactions ────────────────────────────────────────────────────────

    fun refreshInteractions() {
        viewModelScope.launch { refreshInteractionsNow() }
    }

    private suspend fun refreshInteractionsNow() {
        val socket = connection ?: return
        // One retry: a refresh that loses a race with a reconnect, or that lands in
        // the same instant as the host restarting, would otherwise leave a card the
        // operator cannot see until the next poll -- and an agent is blocked the
        // whole time it is unseen.
        val pending = runCatching { socket.call<PendingInteractions>("interactions.pending") }
            .getOrElse {
                delay(500)
                runCatching { socket.call<PendingInteractions>("interactions.pending") }.getOrNull()
            } ?: return
        _state.update { it.copy(pending = pending) }
    }

    fun answerApproval(requestId: String, outcome: ApprovalOutcome) {
        viewModelScope.launch {
            val socket = connection ?: return@launch
            runCatching {
                socket.call<AcceptanceResult>(
                    "approval.answer",
                    payload("requestId" to jsonString(requestId), "outcome" to jsonString(outcome.wire)),
                )
            }.onFailure { error -> _state.update { it.copy(problem = messageOf(error, addressOf())) } }
            refreshInteractionsNow()
        }
    }

    fun answerQuestions(callId: String, answers: List<QuestionAnswer>) {
        viewModelScope.launch {
            val socket = connection ?: return@launch
            runCatching {
                socket.call<AcceptanceResult>(
                    "question.answer",
                    buildJsonObject {
                        put("callId", callId)
                        putJsonArray("answers") {
                            for (answer in answers) {
                                add(
                                    buildJsonObject {
                                        put("id", answer.id)
                                        putJsonArray("selected") { answer.selected.forEach { add(it) } }
                                        answer.custom?.let { put("custom", it) }
                                    },
                                )
                            }
                        }
                    },
                )
            }.onFailure { error -> _state.update { it.copy(problem = messageOf(error, addressOf())) } }
            refreshInteractionsNow()
        }
    }

    // ── catalogs, model, permissions ────────────────────────────────────────

    fun loadCatalogs() {
        viewModelScope.launch {
            val socket = connection ?: return@launch
            if (_state.value.modelCatalog == null) {
                runCatching { socket.call<ModelCatalog>("model.catalog") }
                    .onSuccess { catalog -> _state.update { it.copy(modelCatalog = catalog) } }
            }
            if (_state.value.permissionCatalog == null) {
                runCatching { socket.call<PermissionCatalog>("permissions.catalog") }
                    .onSuccess { catalog -> _state.update { it.copy(permissionCatalog = catalog) } }
            }
        }
    }

    fun setModel(selection: ModelSelection) {
        val sessionId = _state.value.selectedSessionId ?: return
        // Remembered before the call: there is no read-back, so a failure must still
        // leave the picker showing what was asked for rather than snapping back.
        _state.update { it.copy(modelChoice = it.modelChoice + (sessionId to selection)) }
        viewModelScope.launch {
            val socket = connection ?: return@launch
            runCatching {
                socket.call<JsonObject>(
                    "session.model.set",
                    buildJsonObject {
                        put("sessionId", sessionId)
                        put("provider", selection.provider)
                        put("model", selection.model)
                        selection.reasoningEffort?.let { put("reasoningEffort", it) }
                    },
                )
            }.onFailure { error -> _state.update { it.copy(problem = messageOf(error, addressOf())) } }
        }
    }

    fun setPermission(preset: String) {
        val sessionId = _state.value.selectedSessionId ?: return
        viewModelScope.launch {
            val socket = connection ?: return@launch
            runCatching {
                socket.call<JsonObject>(
                    "session.permission.set",
                    payload("sessionId" to jsonString(sessionId), "preset" to jsonString(preset)),
                )
            }.onFailure { error -> _state.update { it.copy(problem = messageOf(error, addressOf())) } }
            loadOnce()
        }
    }

    // ── push ────────────────────────────────────────────────────────────────

    /** Tell the host this device's push token, and that it is on screen. */
    fun registerPush(candidate: MizarConnection? = connection) {
        viewModelScope.launch {
            val socket = candidate ?: return@launch
            val context = getApplication<Application>()
            // The stored copy first (written by the token callback), and a fresh
            // request only when there is none: a build with no Firebase project
            // answers `null` and nothing else changes.
            val token = PushTokens.current(context) ?: PushTokens.refresh(context)
            if (token != null) {
                runCatching {
                    socket.call<JsonObject>(
                        "push.register",
                        buildJsonObject {
                            put("token", token)
                            // Android has no APNs environment, and the relay routes on
                            // this field: without it the token would be sent to Apple.
                            put("platform", "android")
                            put("locale", java.util.Locale.getDefault().toLanguageTag())
                        },
                    )
                }
            }
            runCatching {
                socket.call<AcceptanceResult>("push.presence", buildJsonObject { put("foreground", true) })
            }
        }
    }

    /** Report whether the app is on screen, which decides who gets notified. */
    fun setPresence(foreground: Boolean) {
        // Remembered, because a reconnect has to re-assert it: the host forgets which
        // client is on screen the moment the socket drops, and a phone that looks
        // backgrounded gets notifications instead of the inline cards.
        this.foreground = foreground
        viewModelScope.launch {
            val socket = connection ?: return@launch
            runCatching {
                socket.call<AcceptanceResult>("push.presence", buildJsonObject { put("foreground", foreground) })
            }
        }
    }

    // ── internals ───────────────────────────────────────────────────────────

    private fun startWatchers(socket: MizarConnection) {
        watchers = viewModelScope.launch {
            // The pushed signals, plus a safety-net poll. Notifications are best
            // effort, and a notification lost to a reconnect must not leave a card on
            // screen that no longer exists.
            launch {
                socket.events().collect { frame ->
                    if (frame is me.shirazu.mizar.kit.ServerFrame.Event && frame.name in INTERACTION_EVENTS) {
                        refreshInteractionsNow()
                    }
                }
            }
            while (true) {
                delay(INTERACTION_POLL_MILLIS)
                refreshInteractionsNow()
            }
        }
    }

    private fun stopWatchers() {
        watchers?.cancel()
        watchers = null
    }

    private fun regroup() {
        _state.update { current ->
            current.copy(
                groups = SessionGrouping.groups(current.sessions, current.workspacePaths, current.selectedSessionId),
            )
        }
    }

    private fun applyIndex(index: SessionIndex) {
        // Additive only: a stored list must never wipe what a live read put on screen.
        _state.update { current ->
            current.copy(
                sessions = if (current.sessions.isEmpty()) index.sessions else current.sessions,
                titles = index.titles + current.titles,
                workspacePaths = if (current.workspacePaths.isEmpty()) index.workspacePaths.toSet() else current.workspacePaths,
            )
        }
        regroup()
    }

    private suspend fun persistIndex() {
        val current = _state.value
        val host = current.host ?: return
        indexStore.save(
            SessionIndex(
                hostId = host.hostId,
                sessions = current.sessions,
                titles = current.titles,
                workspacePaths = current.workspacePaths.toList(),
            ),
        )
    }

    private fun addressOf(): String? = _state.value.host?.let { it.authority ?: it.baseUrl }

    private fun messageOf(error: Throwable, address: String?): String {
        // A refused credential gets the phrasing that names the action (pair again),
        // not the host's terse "unknown or revoked token", which reads like a bug.
        if (error.isRepairNeeded()) return Diagnoses.message(Diagnoses.of(error, address))
        val mizar = error as? me.shirazu.mizar.kit.MizarError
        if (mizar != null) return mizar.message
        return Diagnoses.message(Diagnoses.of(error, address))
    }

    /** The host answered and refused this phone: retrying cannot fix that. */
    private fun Throwable.isRepairNeeded(): Boolean =
        this is me.shirazu.mizar.kit.MizarError && requiresRepairing

    private fun payload(vararg members: Pair<String, kotlinx.serialization.json.JsonElement>): JsonObject =
        buildJsonObject { for ((key, value) in members) put(key, value) }

    fun dismissProblem() {
        _state.update { it.copy(problem = null) }
    }

    private companion object {
        /** The five names that all mean "the pending set changed": refresh it. */
        val INTERACTION_EVENTS = setOf(
            "interactions.changed",
            "approval.request",
            "approval.resolved",
            "question.request",
            "question.resolved",
        )

        /**
         * The documented safety net, not the mechanism -- and short, because the thing
         * it backs up is an agent that is stopped until somebody answers.
         *
         * It was 45 s, which is long enough to watch a blocked turn sit there and
         * conclude the app is broken. Ten seconds costs one round trip on a link that
         * is a LAN or a USB tunnel, and bounds the worst case to something an operator
         * will wait through.
         */
        const val INTERACTION_POLL_MILLIS = 10_000L
    }
}
