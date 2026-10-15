//
//  AppModel.swift
//  DSH-Mizar
//
//  The app's whole mutable state.
//
//  Deliberately one object rather than several: there is exactly one
//  connection, one pairing and one selected session at a time, and splitting
//  that across stores would only create questions about which one owns a
//  reconnect.
//

import Foundation
import Observation
import MizarKit

@MainActor
@Observable
final class AppModel {
    /// Where the app is in its life: unpaired, connecting, or usable.
    enum Phase: Equatable {
        case launching
        case unpaired
        case connecting
        case ready
        case failed(String)
    }

    private(set) var phase: Phase = .launching
    /// The host this device is paired with, once known.
    private(set) var host: PairedHost?
    /// Every machine this phone is paired with, oldest pairing first.
    ///
    /// A list rather than one, because "one phone, one Mac" was an assumption
    /// the first version made and it is the wrong one: somebody with a laptop
    /// and a desktop should not have to unpair one to reach the other.
    private(set) var hosts: [PairedHost] = []
    /// The machine whose pairing just completed and has not been named yet.
    ///
    /// Naming is offered once, right after pairing, when the operator knows
    /// which machine they just scanned. Asking later means asking about a row
    /// they can no longer identify.
    var pendingNameHostId: String?
    /// The host's own identity report, once connected.
    private(set) var welcome: WelcomeFrame?
    /// Which route the live connection is using, for the UI to show.
    ///
    /// Worth surfacing because the two behave differently under load: a relayed
    /// connection carries a round trip through another machine, and an operator
    /// wondering why everything feels slow deserves to see why.
    private(set) var activeEndpoint: PairedHost.Endpoint?
    /// The sessions the host lists, newest activity first.
    private(set) var sessions: [SessionRow] = []

    /// The last thing that went wrong without being fatal.
    ///
    /// Separate from `phase`, and that separation is the fix for a real bug: a
    /// failed refresh used to set the whole app to `.failed`, so one dropped
    /// request looked exactly like the connection dying. Worse, the screen it
    /// landed on offered "Pair again", which forgot the pairing -- which is why
    /// a transient error could cost the operator their setup entirely.
    private(set) var lastError: String?

    /// Whether a reconnect is in flight, so the UI can say so.
    private(set) var reconnecting = false

    /// DSH's own title for a session, by id.
    ///
    /// Not in `session.list` -- the host assigns a title once a model has read
    /// the conversation, and it arrives with `session.stats`. Without it every
    /// row in a workspace showed the same string, because the workspace *is* the
    /// working directory: five sessions all reading "DSH-Mizar" tells you
    /// nothing about which is which.
    private(set) var titles: [String: String] = [:]

    /// Fetch titles for sessions that do not have one yet.
    ///
    /// Concurrently, and only for the sessions actually on screen, because this
    /// is one request per session and a workspace can hold dozens.
    ///
    /// - Parameter sessionIds: the sessions to look up.
    func loadTitles(for sessionIds: [String]) async {
        let missing = sessionIds.filter { titles[$0] == nil }
        guard !missing.isEmpty, connection != nil else { return }
        // One at a time. A task group across the actor trips Swift 6's
        // region-based isolation checker, and the caller only ever asks for the
        // rows it is about to draw -- ten of them.
        for sessionId in missing {
            guard let frame = await stats(for: sessionId) else { continue }
            if let title = frame.title, !title.isEmpty { titles[sessionId] = title }
        }
    }

    /// What a sync is doing, or `nil` when none is.
    ///
    /// A refresh used to be a spinner with no end and no idea how far along it
    /// was, over a link that can be a phone on cellular. Saying which session of
    /// how many is the difference between waiting and wondering.
    private(set) var syncProgress: SyncProgress?

    /// How a sync is going.
    struct SyncProgress: Sendable, Equatable {
        /// What is being fetched.
        var current: String
        /// How many sessions are done.
        var completed: Int
        /// How many there are to do.
        var total: Int

        var fraction: Double { total == 0 ? 0 : Double(completed) / Double(total) }
    }

    /// Whether a sync is running.
    var isSyncing: Bool { syncProgress != nil }
    /// The session the conversation screen is showing.
    var selectedSessionId: String? {
        didSet {
            guard selectedSessionId != oldValue else { return }
            pending = nil
            Task { await refreshInteractions() }
        }
    }
    /// Everything waiting on the operator right now.
    ///
    /// The host pushes `interactions.changed` the moment its pending set moves,
    /// so this is normally current within a round trip. The timer below is the
    /// safety net for a notification lost to a dropped socket, not the mechanism.
    private(set) var pending: PendingInteractions?
    /// What each session was last told to use, so the picker can show it.
    ///
    /// Not persisted: it is a display of what this app asked for, and after a
    /// relaunch the plugin's own config is the truth. Showing a stale tick would
    /// be worse than showing none.
    private(set) var modelChoice: [String: ModelChoice] = [:]

    /// A provider, model and reasoning effort as chosen on this device.
    struct ModelChoice: Sendable, Equatable {
        let provider: String
        let model: String
        let effort: String?
    }

    /// The models this host offers.
    private(set) var modelCatalog: ModelCatalog?
    /// The permission presets this host offers.
    private(set) var permissionCatalog: PermissionCatalog?
    /// The idempotency key for the prompt currently being submitted.
    private var lastRequestId: String?
    /// The poll that watches for pending interactions.
    private var interactionPoll: Task<Void, Never>?
    /// The task consuming host-pushed events.
    private var eventListener: Task<Void, Never>?

    /// Host events that mean the pending set moved.
    ///
    /// `interactions.changed` covers every case on its own, and the four
    /// specific names are listed because they predate it: a host built before
    /// the summary frame existed sends only those, and a client that ignored
    /// them would fall back to the slow timer for no reason.
    private static let interactionEvents: Set<String> = [
        "interactions.changed",
        "approval.request",
        "approval.resolved",
        "question.request",
        "question.resolved",
    ]

    /// How often to re-read pending interactions when nothing has been pushed.
    ///
    /// Deliberately slow. The host announces changes, so a short interval would
    /// be pure traffic; this only exists so that a notification lost to a
    /// reconnect cannot leave a card on screen that no longer exists.
    private static let interactionPollSeconds: Duration = .seconds(45)

    private let credentials: any CredentialStore
    /// Conversations kept on the phone, so history survives a lost network.
    let conversations: any ConversationCache
    private var connection: MizarConnection?

    init(
        credentials: any CredentialStore = KeychainCredentialStore(),
        conversations: any ConversationCache = FileConversationCache(),
    ) {
        self.credentials = credentials
        self.conversations = conversations
    }

    /// Load any stored pairing and, if there is one, connect.
    ///
    /// A pairing URI passed on the command line takes precedence, which is what
    /// makes the app drivable from `simctl launch` and from a UI test without
    /// typing into fields or tapping through an alert. It is the same payload
    /// the QR carries, so the path exercised is the real one.
    func start() async {
        if let raw = Self.launchPairingURI, let target = PairingURI.parse(raw) {
            await pair(with: target, deviceName: "iPhone")
            return
        }
        do {
            hosts = try await credentials.loadAll().sorted { $0.pairedAt < $1.pairedAt }
            guard let stored = hosts.last else {
                phase = .unpaired
                return
            }
            host = stored
            try await connect(using: stored)
        } catch {
            phase = .failed(Self.describe(error, authority: host?.authority))
        }
    }

    /// Open a different machine from the list.
    /// - Parameter hostId: the machine to open.
    func open(hostId: String) async {
        guard let next = hosts.first(where: { $0.hostId == hostId }) else { return }
        disconnectCurrent()
        host = next
        do {
            try await connect(using: next)
        } catch {
            phase = .failed(Self.describe(error, authority: next.authority ?? next.baseURL))
        }
    }

    /// Give a machine the name the operator chose for it, on this phone only.
    ///
    /// - Parameters:
    ///   - label: the name, or `nil` to fall back to the host's own.
    ///   - hostId: the machine to rename.
    func rename(hostId: String, to label: String?) async {
        guard let index = hosts.firstIndex(where: { $0.hostId == hostId }) else { return }
        let trimmed = label?.trimmingCharacters(in: .whitespacesAndNewlines)
        let renamed = hosts[index].renamed(to: (trimmed?.isEmpty ?? true) ? nil : trimmed)
        hosts[index] = renamed
        if host?.hostId == hostId { host = renamed }
        try? await credentials.save(renamed)
        pendingNameHostId = nil
    }

    /// Forget one machine, leaving the others paired.
    /// - Parameter hostId: the machine to forget.
    func forget(hostId: String) async {
        try? await credentials.remove(hostId: hostId)
        hosts.removeAll { $0.hostId == hostId }
        guard host?.hostId == hostId else { return }
        disconnectCurrent()
        if let next = hosts.last {
            host = next
            try? await connect(using: next)
        } else {
            host = nil
            phase = .unpaired
        }
    }

    /// Tear the live connection down without touching what is stored.
    private func disconnectCurrent() {
        interactionPoll?.cancel()
        eventListener?.cancel()
        Task { await connection?.disconnect() }
        connection = nil
        welcome = nil
        sessions = []
        selectedSessionId = nil
        phase = .launching
    }

    /// A `mizar://pair` URI from the launch arguments, when one was passed.
    private static var launchPairingURI: String? {
        launchArgument("-mizarPairURI")
    }

    /// A session to open on launch, from the launch arguments.
    ///
    /// `first` means the newest session. Paired with `-mizarPairURI` this is the
    /// whole automation entry point: it makes any screen reachable from
    /// `simctl launch` without a tap, which is the difference between a UI that
    /// is built and a UI that has been seen working.
    private static var launchSelectedSession: String? {
        launchArgument("-mizarSelectSession")
    }

    /// Read a `-flag value` pair from the launch arguments.
    /// - Parameter flag: the flag to look for.
    /// - Returns: the value, or `nil` when the flag is absent.
    private static func launchArgument(_ flag: String) -> String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: flag),
              arguments.index(after: index) < arguments.endIndex
        else { return nil }
        return arguments[arguments.index(after: index)]
    }

    /// React to what the host pushes, and fall back to asking occasionally.
    private func startInteractionPoll() {
        interactionPoll?.cancel()
        interactionPoll = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshInteractions()
                try? await Task.sleep(for: Self.interactionPollSeconds)
            }
        }

        eventListener?.cancel()
        eventListener = Task { [weak self] in
            guard let stream = await self?.connection?.events() else { return }
            for await frame in stream {
                guard case .event(let name, _) = frame else { continue }
                // Any other event name is for a future build; ignoring it is not
                // the same as failing on it.
                guard Self.interactionEvents.contains(name) else { continue }
                await self?.refreshInteractions()
            }
        }
    }

    /// Read the pending approvals and questions.
    func refreshInteractions() async {
        guard let connection else { return }
        pending = try? await connection.call("interactions.pending", as: PendingInteractions.self)
    }

    /// Answer an approval.
    ///
    /// - Parameters:
    ///   - approval: the request being answered.
    ///   - outcome: what to do with it.
    func answerApproval(_ approval: PendingApproval, outcome: ApprovalOutcome) async {
        guard let connection else { return }
        let payload = JSONValue.object([
            "requestId": .string(approval.requestId),
            "outcome": .string(outcome.rawValue),
        ])
        _ = try? await connection.call("approval.answer", payload: payload, as: AcceptanceResult.self)
        // Re-read rather than removing locally: the host is the authority on
        // what is still outstanding, and a racing device may have answered it.
        await refreshInteractions()
    }

    /// Answer a whole question batch.
    /// - Parameters:
    ///   - question: the batch being answered.
    ///   - answers: one answer per question, in the batch's order.
    func answerQuestion(_ question: PendingQuestion, answers: [QuestionAnswer]) async {
        guard let connection else { return }
        let payload = JSONValue.object(["callId": .string(question.callId)])
        let batch = QuestionAnswerBatch(answers: answers)
        guard let encoded = try? JSONEncoder().encode(batch),
              let value = try? JSONDecoder().decode(JSONValue.self, from: encoded)
        else { return }
        var merged = payload
        if case .object(var fields) = merged, case .object(let batchFields) = value {
            for (key, fieldValue) in batchFields { fields[key] = fieldValue }
            merged = .object(fields)
        }
        _ = try? await connection.call("question.answer", payload: merged, as: AcceptanceResult.self)
        await refreshInteractions()
    }

    /// Load the model and permission catalogs, once.
    func loadCatalogs() async {
        guard let connection else { return }
        if modelCatalog == nil {
            modelCatalog = try? await connection.call("model.catalog", as: ModelCatalog.self)
        }
        if permissionCatalog == nil {
            permissionCatalog = try? await connection.call("permissions.catalog", as: PermissionCatalog.self)
        }
    }

    /// Send a prompt to a session.
    ///
    /// - Parameters:
    ///   - text: what to say.
    ///   - sessionId: the session to say it to.
    /// - Returns: whether the host accepted it.
    @discardableResult
    func sendPrompt(_ text: String, to sessionId: String) async -> Bool {
        guard let connection, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return false
        }
        // A fresh key per submission: the host uses it to make a retry of the
        // same prompt idempotent, and reusing one would make a second, genuinely
        // different prompt look like a duplicate.
        let requestId = UUID().uuidString
        let payload = JSONValue.object([
            "sessionId": .string(sessionId),
            "text": .string(text),
            "requestId": .string(requestId),
        ])
        do {
            let result = try await connection.call("session.prompt", payload: payload, as: PromptResult.self)
            if result.accepted { lastRequestId = result.requestId }
            return result.accepted
        } catch {
            phase = .failed(Self.describe(error, authority: host?.authority))
            return false
        }
    }

    /// Every working directory the host has already used, newest first.
    ///
    /// Derived from the session list rather than a workspace API: the host
    /// reports a `cwd` for each session, and those are exactly the directories
    /// the operator works in. Offerring them costs nothing and avoids asking a
    /// question the host has already answered.
    var knownWorkingDirectories: [String] {
        var seen = Set<String>()
        return sessions.compactMap(\.cwd).filter { seen.insert($0).inserted }
    }

    /// Start a session in a directory.
    ///
    /// - Parameter cwd: the directory to work in.
    /// - Returns: the new session's id, or `nil` when the host refused.
    func createSession(cwd: String) async -> String? {
        guard let connection else { return nil }
        let payload = JSONValue.object(["cwd": .string(cwd)])
        do {
            let result = try await connection.call("session.create", payload: payload, as: CreateSessionResult.self)
            await refreshSessions()
            selectedSessionId = result.sessionId
            return result.sessionId
        } catch {
            phase = .failed(Self.describe(error, authority: host?.authority))
            return nil
        }
    }

    /// Ask the host to stop the current turn.
    func cancelTurn(sessionId: String) async {
        guard let connection else { return }
        let payload = JSONValue.object(["sessionId": .string(sessionId)])
        _ = try? await connection.call("session.cancel", payload: payload, as: AcceptanceResult.self)
    }

    /// Switch the session's model, and optionally its reasoning effort.
    /// - Parameters:
    ///   - provider: the provider id.
    ///   - model: the model id.
    ///   - effort: the reasoning level, or `nil` for the provider default.
    ///   - sessionId: the session to change.
    func setModel(provider: String, model: String, effort: String?, sessionId: String) async {
        // Remembered before the call, not after. The host has no "what is this
        // session using" read on the phone's side of the protocol, so this is
        // what lets the picker show a checkmark when it is reopened -- without
        // it the picker started blank every time, and there was no way to tell
        // what was selected.
        modelChoice[sessionId] = ModelChoice(provider: provider, model: model, effort: effort)
        guard let connection else { return }
        var fields: [String: JSONValue] = [
            "sessionId": .string(sessionId),
            "provider": .string(provider),
            "model": .string(model),
        ]
        if let effort { fields["reasoningEffort"] = .string(effort) }
        _ = try? await connection.call(
            "session.model.set",
            payload: .object(fields),
            as: SelectModelResult.self,
        )
    }

    /// Switch the session's permission preset.
    /// - Parameters:
    ///   - preset: the preset value.
    ///   - sessionId: the session to change.
    /// - Returns: the host's report, or `nil` when it could not be reached.
    func setPermission(_ preset: String, sessionId: String) async -> SetPermissionResult? {
        guard let connection else { return nil }
        let payload = JSONValue.object([
            "sessionId": .string(sessionId),
            "preset": .string(preset),
        ])
        return try? await connection.call("session.permission.set", payload: payload, as: SetPermissionResult.self)
    }

    /// Forget every pairing and return to the pairing screen.
    ///
    /// Distinct from forgetting one machine: this is "start over", which is what
    /// a reinstall or a shared phone needs.
    func unpair() async {
        interactionPoll?.cancel()
        eventListener?.cancel()
        await connection?.disconnect()
        connection = nil
        welcome = nil
        sessions = []
        selectedSessionId = nil
        host = nil
        hosts = []
        try? await credentials.clear()
        phase = .unpaired
    }

    /// Refresh the session list.
    func refreshSessions() async {
        await refreshSessions(reconnectingIfNeeded: true)
    }

    /// Refresh the session list, reconnecting first when the socket is gone.
    ///
    /// - Parameter reconnectingIfNeeded: whether a failure should be retried
    ///   over a fresh connection.
    private func refreshSessions(reconnectingIfNeeded: Bool) async {
        guard connection != nil else { return }
        do {
            let result = try await call("session.list", as: SessionListResult.self)
            sessions = result.items
            lastError = nil
        } catch {
            if reconnectingIfNeeded, await reconnect() {
                await refreshSessions(reconnectingIfNeeded: false)
                return
            }
            // Reported, not fatal. The pairing is still good and most of the
            // screen is still usable; throwing the operator out to a failure
            // screen over one dropped request is a worse answer than saying so.
            lastError = Self.describe(error).isEmpty ? nil : Self.describe(error)
        }
    }

    /// Run one call, reconnecting once if the socket has gone away.
    ///
    /// - Parameters:
    ///   - method: the method name.
    ///   - type: the result type.
    /// - Returns: the decoded result.
    /// - Throws: when the call fails twice.
    /// Run one call, reconnecting once if the socket has gone away.
    ///
    /// - Parameters:
    ///   - method: the method name.
    ///   - payload: the arguments, when the method takes any.
    ///   - type: the result type.
    /// - Returns: the decoded result.
    /// - Throws: when the call fails twice.
    private func call<T: Decodable & Sendable>(
        _ method: String,
        payload: JSONValue? = nil,
        as type: T.Type,
    ) async throws -> T {
        guard let connection else {
            throw MizarError(code: "NO_CONNECTION", message: "not connected to the Mac")
        }
        do {
            return try await connection.call(method, payload: payload, as: type)
        } catch {
            guard await reconnect() else { throw error }
            guard let fresh = self.connection else { throw error }
            return try await fresh.call(method, payload: payload, as: type)
        }
    }

    /// Open a fresh connection to the current machine.
    ///
    /// The app had no way back from a dropped socket: `URLSessionWebSocketTask`
    /// does not reconnect, and every screen simply failed until the app was
    /// restarted. A phone changes networks constantly -- walking out of Wi-Fi
    /// range is enough -- so this is the common case, not an edge one.
    ///
    /// - Returns: whether a connection is now open.
    @discardableResult
    func reconnect() async -> Bool {
        guard let host, !reconnecting else { return connection != nil }
        reconnecting = true
        defer { reconnecting = false }

        eventListener?.cancel()
        interactionPoll?.cancel()
        await connection?.disconnect()
        connection = nil

        for attempt in 0..<3 {
            if attempt > 0 {
                try? await Task.sleep(for: .milliseconds(400 * attempt))
            }
            guard let next = makeConnection(for: host) else { continue }
            do {
                _ = try await next.connect()
                connection = next
                lastError = nil
                startInteractionPoll()
                return true
            } catch {
                let message = Self.describe(error, authority: host.authority ?? host.baseURL)
                lastError = message.isEmpty ? nil : message
            }
        }
        return false
    }

    /// Read a session's conversation from the phone's own storage.
    ///
    /// - Parameter sessionId: the session.
    /// - Returns: the cached conversation, or `nil` when none is stored.
    func cachedConversation(for sessionId: String) async -> CachedConversation? {
        await conversations.load(sessionId: sessionId)
    }

    /// Sync every session's history to this phone.
    ///
    /// Run on first pairing and from the refresh button. Paging rather than
    /// asking for everything at once: a page that does not arrive costs the
    /// freshness of one screen, which is the lesson the two-megabyte page
    /// taught.
    func syncAllConversations() async {
        guard connection != nil else { return }
        await refreshSessions()
        guard !sessions.isEmpty else { return }

        let runnable = sessions.filter { $0.parentSessionId == nil }
        syncProgress = SyncProgress(current: "", completed: 0, total: runnable.count)

        for (index, session) in runnable.enumerated() {
            syncProgress?.current = session.cwd.map { ($0 as NSString).lastPathComponent } ?? session.sessionId
            await syncConversation(for: session.sessionId)
            syncProgress?.completed = index + 1
        }
        syncProgress = nil
    }

    /// Fetch one session's page and fold it into the cache.
    ///
    /// - Parameter sessionId: the session to sync.
    /// - Returns: the items now known, oldest first.
    @discardableResult
    func syncConversation(for sessionId: String) async -> [ConversationItem] {
        do {
            let result = try await call(
                "session.messages",
                payload: .object([
                    "sessionId": .string(sessionId),
                    // The host trims the page to what the transport can carry;
                    // asking for more only costs a bigger request.
                    "maxMessages": .number(200),
                ]),
                as: SessionMessagesResult.self,
            )
            let fresh = result.conversationItems()
            let freshTurns = result.conversationTurns()
            let cached = await conversations.load(sessionId: sessionId)
            let merged = mergeConversations(cached: cached?.items ?? [], fresh: fresh)
            // Grouped on the fresh page and kept beside it, because a page is
            // where the turn boundaries are -- they are in the records, and the
            // merged item list has already lost which step belonged to what.
            let mergedTurns = mergeTurns(cached: cached?.turns ?? [], fresh: freshTurns)
            await conversations.save(
                CachedConversation(
                    sessionId: sessionId,
                    items: merged,
                    throughSeq: result.asOfSeq,
                    hasMore: result.hasMore,
                    turns: mergedTurns,
                ),
            )
            lastError = nil
            return merged
        } catch {
            let message = Self.describe(error, authority: host?.authority ?? host?.baseURL)
            if !message.isEmpty { lastError = message }
            return await conversations.load(sessionId: sessionId)?.items ?? []
        }
    }

    /// Read a session's recent log, as items a view can draw.
    ///
    /// - Parameter sessionId: the session to read.
    /// - Returns: the items, oldest first.
    func conversation(for sessionId: String) async -> [ConversationItem] {
        guard let connection else { return [] }
        do {
            let payload = JSONValue.object([
                "sessionId": .string(sessionId),
                // Enough to cover a working session's history. It counts
                // messages, not records, and a single prompt emits about nine
                // records -- so the response is large and the alternative is an
                // app that only ever shows the last few exchanges.
                "maxMessages": .number(200),
            ])
            let result = try await connection.call(
                "session.messages",
                payload: payload,
                as: SessionMessagesResult.self,
            )
            lastError = nil
            return result.conversationItems()
        } catch {
            // Said out loud. This used to return an empty array, which drew the
            // same "no messages" screen as a session that genuinely has none --
            // so a broken read looked like an empty conversation, and there was
            // nothing on screen to say which it was.
            let message = Self.describe(error, authority: host?.authority ?? host?.baseURL)
            if !message.isEmpty { lastError = message }
            return []
        }
    }

    /// Read one session's usage frame.
    /// - Parameter sessionId: the session to read.
    /// - Returns: the frame, or `nil` when it could not be read.
    func stats(for sessionId: String) async -> SessionStatsFrame? {
        guard connection != nil else { return nil }
        do {
            let payload = JSONValue.object(["sessionId": .string(sessionId)])
            let result = try await call(
                "session.stats",
                payload: payload,
                as: SessionStatsResult.self,
            )
            return result.stats
        } catch {
            // Reported rather than swallowed. This returned `nil` for every
            // failure, so a decode problem and a session with no usage looked
            // the same on screen -- which is how "the usage screen never loads"
            // stayed unexplained through several rounds.
            let message = Self.describe(error, authority: host?.authority ?? host?.baseURL)
            if !message.isEmpty { lastError = message }
            return nil
        }
    }

    /// Complete pairing with a scanned target.
    /// - Parameters:
    ///   - target: the decoded QR payload.
    ///   - deviceName: what to call this device in the host's roster.
    func pair(with target: PairingTarget, deviceName: String) async {
        phase = .connecting
        do {
            let client = PairingClient()
            let paired = try await client.pair(
                authority: target.authority,
                code: target.code,
                deviceName: deviceName,
                deviceModel: Self.deviceModel,
                // Without this the pairing request goes to an address that does
                // not exist, and the failure reads as "" not being dialable --
                // which is what a simulator run against a relay-only QR found.
                baseURL: target.baseURL,
            )
            try await credentials.save(paired)
            hosts = try await credentials.loadAll().sorted { $0.pairedAt < $1.pairedAt }
            host = paired
            // Offered once, now, while the operator still knows which machine
            // they just scanned. The connection is opened first so the name is
            // asked for over a working screen rather than a spinner.
            pendingNameHostId = paired.hostId
            try await connect(using: paired)
            // First pairing pulls the history down, so the phone has something
            // to show the next time the network is not there. Deliberately after
            // the screen is up: the operator should see the app working, not a
            // progress dialog, and the sync reports itself in the toolbar.
            Task { await syncAllConversations() }
        } catch {
            phase = .failed(
                Self.describe(error, authority: target.authority ?? target.baseURL),
            )
        }
    }

    /// Open the socket and load the first screen's data.
    ///
    /// Every route the pairing knows about is tried in order, direct first,
    /// because the two fail for entirely different reasons and only one of them
    /// is usually available. A Mac on the same Wi-Fi answers on its LAN address;
    /// a Mac on a network that blocks inbound traffic answers only through the
    /// relay. One QR code carries both, and this is what makes that useful.
    ///
    /// A failed attempt costs its own timeout, so the direct attempt is given a
    /// short one. Waiting the full default before falling back would make every
    /// connection on a hostile network feel broken.
    ///
    /// - Parameter host: the pairing to connect with.
    private func connect(using host: PairedHost) async throws {
        phase = .connecting
        let endpoints = host.endpoints
        guard !endpoints.isEmpty else {
            let error = MizarError(
                code: "NO_ENDPOINT",
                message: "this pairing has no address to dial",
            )
            phase = .failed(error.message)
            throw error
        }

        var lastError: (any Error)?
        for (index, endpoint) in endpoints.enumerated() {
            do {
                try await open(host: host, endpoint: endpoint)
                return
            } catch {
                lastError = error
                // Nothing left to fall back to, so this is the answer.
                guard index < endpoints.count - 1 else { break }
                // Back to connecting rather than failed: the next route has
                // not been tried yet, and showing a failure while an attempt is
                // in flight is a lie the operator would act on.
                phase = .connecting
            }
        }

        let failure = lastError ?? MizarError(code: "UNREACHABLE", message: "the host did not answer")
        phase = .failed(Self.describe(failure, authority: host.authority ?? host.baseURL))
        throw failure
    }

    /// Open one connection over one route, and load the first screen's data.
    ///
    /// - Parameters:
    ///   - host: the pairing to connect with.
    ///   - endpoint: which route to take.
    /// Build a connection for one route, not yet opened.
    ///
    /// - Parameters:
    ///   - host: the pairing to connect with.
    ///   - endpoint: which route to take.
    /// - Returns: the connection.
    private func makeConnection(
        host: PairedHost,
        endpoint: PairedHost.Endpoint,
    ) -> MizarConnection {
        // Only the direct attempt gets a short leash. A relay that is reachable
        // but slow should be waited for rather than abandoned for a route that
        // has already been ruled out.
        let timeout: TimeInterval
        switch endpoint {
        case .direct: timeout = 6
        case .relay: timeout = 20
        }

        let configuration: MizarConnection.Configuration
        switch endpoint {
        case .direct(let authority):
            configuration = .init(
                authority: authority,
                token: host.deviceToken,
                appVersion: Self.appVersion,
                deviceModel: Self.deviceModel,
            )
        case .relay(let baseURL):
            configuration = .init(
                authority: nil,
                token: host.deviceToken,
                appVersion: Self.appVersion,
                deviceModel: Self.deviceModel,
                baseURL: baseURL,
            )
        }

        return MizarConnection(
            configuration: configuration,
            makeTransport: { URLSessionWebSocketTransport(timeout: timeout) },
        )
    }

    /// The route a reconnect should try first: whichever one worked.
    ///
    /// Falling back to the first candidate each time would make a relay-only
    /// phone pay the direct timeout on every reconnect, and a phone that walks
    /// out of Wi-Fi range reconnects often.
    ///
    /// - Parameter host: the pairing to connect with.
    /// - Returns: the connection, or `nil` when there is no route to try.
    private func makeConnection(for host: PairedHost) -> MizarConnection? {
        if let activeEndpoint {
            return makeConnection(host: host, endpoint: activeEndpoint)
        }
        guard let first = host.endpoints.first else { return nil }
        return makeConnection(host: host, endpoint: first)
    }

    /// Open one connection over one route, and load the first screen's data.
    ///
    /// - Parameters:
    ///   - host: the pairing to connect with.
    ///   - endpoint: which route to take.
    private func open(host: PairedHost, endpoint: PairedHost.Endpoint) async throws {
        let connection = makeConnection(host: host, endpoint: endpoint)
        self.connection = connection

        let welcome = try await connection.connect()
        self.welcome = welcome
        self.activeEndpoint = endpoint
        phase = .ready
        await refreshSessions()
        startInteractionPoll()

        if let requested = Self.launchSelectedSession {
            selectedSessionId = requested == "first" ? sessions.first?.sessionId : requested
        }
    }

    /// The hardware model, for the host's device roster.
    private static var deviceModel: String {
        #if targetEnvironment(simulator)
        "iOS Simulator"
        #else
        var info = utsname()
        uname(&info)
        let mirror = Mirror(reflecting: info.machine)
        let identifier = mirror.children.reduce(into: "") { partial, element in
            guard let value = element.value as? Int8, value != 0 else { return }
            partial.append(Character(UnicodeScalar(UInt8(value))))
        }
        return identifier.isEmpty ? "iPhone" : identifier
        #endif
    }

    /// The app's marketing version.
    private static var appVersion: String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "unknown"
    }

    /// Whether an error is something the operator should be told about.
    ///
    /// A cancelled task is not a failure: it is a screen that went away or a
    /// request that got superseded, and both happen constantly in a list that
    /// reloads as you scroll. Showing them put "未能完成操作。（CancellationError
    /// 错误1。）" on screen for something nobody did wrong.
    ///
    /// - Parameter error: the error to judge.
    /// - Returns: whether to surface it.
    private static func isWorthReporting(_ error: any Error) -> Bool {
        if error is CancellationError { return false }
        if let urlError = error as? URLError, urlError.code == .cancelled { return false }
        return true
    }

    /// Render an error for a human.
    ///
    /// `String(describing:)` on a `URLError` produces the entire `UserInfo`
    /// dictionary, which is what this screen used to show: a page of
    /// `_kCFStreamErrorCodeKey=-2102` that is accurate and useless. A failure to
    /// reach a tailnet address now says so and names the fix.
    ///
    /// - Parameters:
    ///   - error: the error to describe.
    ///   - authority: the address that was being reached, when known.
    /// - Returns: text to put in front of the operator.
    private static func describe(_ error: any Error, authority: String? = nil) -> String {
        if !isWorthReporting(error) { return "" }
        if let mizar = error as? MizarError { return mizar.message }
        guard let authority else { return error.localizedDescription }
        return ConnectionDiagnosis.of(error, authority: authority).message
    }
}
