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
import UserNotifications
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

    /// The workspaces DSH has, as paths.
    ///
    /// Kept because the session list cannot answer this on its own: a session
    /// outlives the workspace it was created in, so grouping sessions by their
    /// working directory draws a row for a workspace the operator deleted. From
    /// the machine this was reported from, DSH had 4 workspaces and the phone
    /// showed 10.
    ///
    /// Empty means "the host did not say", and the screen falls back to grouping
    /// sessions on their working directory. A failure here must never remove a
    /// workspace somebody is using.
    private(set) var workspacePaths: Set<String> = []

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
        var learned = false
        for sessionId in missing {
            guard let frame = await stats(for: sessionId) else { continue }
            if let title = frame.title, !title.isEmpty {
                titles[sessionId] = title
                learned = true
            }
        }
        // Titles are one request per session over a link that may not answer;
        // a title that has been learned once is kept, so the second visit to a
        // workspace is not a second round of requests that can fail.
        if learned { await persistIndex() }
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
        /// How many there are to do, or `0` while that is not known yet.
        var total: Int
        /// When this pass began, which is what an estimate is measured from.
        var startedAt: Date = Date()

        var fraction: Double { total == 0 ? 0 : Double(completed) / Double(total) }

        /// How much longer, once a rate can be measured at all.
        ///
        /// `nil` until at least one session has finished, and the restraint is
        /// the point: an estimate from no samples is not a small estimate, it is
        /// no estimate, and a countdown that starts at a made-up number and then
        /// changes is worse than a progress bar on its own.
        ///
        /// Measured per *session* rather than per byte, because the size of a
        /// conversation is not known before it is fetched and the number of them
        /// is.
        var remaining: TimeInterval? {
            guard completed > 0, total > completed else { return nil }
            let elapsed = Date().timeIntervalSince(startedAt)
            guard elapsed > 0 else { return nil }
            return (elapsed / Double(completed)) * Double(total - completed)
        }
    }

    /// Whether a sync is running.
    var isSyncing: Bool { syncProgress != nil }

    /// Why the last sync produced nothing to report, when it did.
    ///
    /// The window that reports a refresh has a branch for "there is nothing
    /// running right now", and before this that branch said "Up to date. Every
    /// conversation on this Mac is stored on this phone." -- which is a claim
    /// about the operator's data, made out of a request that was never sent.
    /// Tapping refresh with the Mac unreachable said it.
    private(set) var syncProblem: String?

    /// Whether there is a stored session list for the current machine.
    ///
    /// This is what decides whether an unreachable Mac is a dead end or a
    /// banner over data that is still here. The phone is opened on trains, in
    /// lifts and on the far side of a relay having a bad day, and a screen that
    /// replaces a conversation the operator already has with "cannot reach the
    /// Mac" is a screen that threw away the answer to the question they opened
    /// it with.
    private(set) var hasStoredIndex = false

    /// The thing that is currently wrong, if anything.
    ///
    /// One accessor for two sources -- a failure of the connection itself and a
    /// request that did not land -- because the screen shows one banner and does
    /// not care which of them it is describing.
    var problem: String? {
        if case .failed(let message) = phase { return lastError ?? message }
        return lastError
    }

    /// Whether this pairing's first download is running.
    ///
    /// A flag rather than a second set of numbers: the full-screen view draws
    /// the same progress the sheet does, and two trackers would be two things to
    /// keep in step for no gain. `nil`-ing `syncProgress` between the phases of
    /// a sync is why this cannot simply be `syncProgress != nil`.
    private(set) var firstLoad = false
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
    /// The session list, its titles and the workspaces, kept on the phone.
    ///
    /// Separate from `conversations` because it answers a different question.
    /// The two are written at different moments and fail differently: a
    /// conversation that will not load is a screen with no messages, an index
    /// that will not load is a list with no rows.
    private let indexStore: any SessionIndexStore
    private var connection: MizarConnection?

    init(
        credentials: any CredentialStore = KeychainCredentialStore(),
        conversations: any ConversationCache = FileConversationCache(),
        index: any SessionIndexStore = FileSessionIndexStore(),
    ) {
        self.credentials = credentials
        self.conversations = conversations
        self.indexStore = index
    }

    /// Put what this phone already knows on screen, before asking anybody.
    ///
    /// The point of the stored index. Every one of these three used to be the
    /// result of a request made while the screen was opening, so a phone on a
    /// slow link showed an empty list and unnamed sessions until the round trip
    /// came back -- and showed them forever if it never did.
    ///
    /// - Parameter hostId: the machine to read for.
    private func loadIndex(for hostId: String) async {
        guard let stored = await indexStore.load(hostId: hostId) else {
            hasStoredIndex = false
            return
        }
        hasStoredIndex = !stored.sessions.isEmpty
        // Only ever adds. A stored list that is empty must not be able to wipe
        // what a live read has already put on screen.
        if !stored.sessions.isEmpty { sessions = stored.sessions }
        if !stored.titles.isEmpty { titles.merge(stored.titles) { _, stored in stored } }
        if !stored.workspacePaths.isEmpty { workspacePaths.formUnion(stored.workspacePaths) }
    }

    /// Write down what is on screen, so a later launch starts from it.
    ///
    /// Called after every successful update rather than on a timer: the stored
    /// index is then always the last thing the host actually said, and never a
    /// mixture of that and something this app inferred.
    private func persistIndex() async {
        guard let hostId = host?.hostId else { return }
        await indexStore.save(
            SessionIndex(
                hostId: hostId,
                sessions: sessions,
                titles: titles,
                workspacePaths: Array(workspacePaths),
            ),
        )
    }

    /// Load any stored pairing and, if there is one, connect.
    ///
    /// A pairing URI passed on the command line takes precedence, which is what
    /// makes the app drivable from `simctl launch` and from a UI test without
    /// typing into fields or tapping through an alert. It is the same payload
    /// the QR carries, so the path exercised is the real one.
    func start() async {
        if Self.launchResetsCache {
            // Before the first read, not after: everything below loads what is
            // stored, so this is the only place where "start empty" can be true.
            //
            // Both stores, because "start from nothing" is a claim about the
            // whole app: leaving the index behind would show a fixture's session
            // list under a fresh install's pairing.
            await conversations.clear()
            await indexStore.clear()
        }
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
        // The machine is gone, so what this phone remembers of it is gone too.
        // Leaving it would show one Mac's sessions under another's name the next
        // time somebody paired a machine that reused the id.
        await indexStore.remove(hostId: hostId)
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
        statsError = nil
        conversationError = nil
        // Per-machine facts, cleared with the machine. `workspacePaths` is a
        // filter: leaving the last Mac's set in place and unioning the new one's
        // into it means this Mac's deleted workspaces are drawn again the moment
        // its own `workspace.list` fails -- which the code itself says older
        // hosts do.
        titles = [:]
        workspacePaths = []
        hasStoredIndex = false
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

    /// Whether to throw the stored conversations away before anything loads.
    ///
    /// The cache is meant to be long-lived -- being able to see yesterday's
    /// conversation without a network is the point of it -- so it survives
    /// relaunches and, in the simulator, it survives reinstalls of the same
    /// bundle. That makes a UI test lie: measure a screen against a fixture and
    /// the screen may be showing a fixture from a week ago, merged with the new
    /// one, which is exactly what "the turn has 5 steps and is still running"
    /// turned out to be.
    ///
    /// A test that asserts on a fixture has to say it wants the fixture and
    /// nothing else.
    private static var launchResetsCache: Bool {
        ProcessInfo.processInfo.arguments.contains("-mizarFreshStart")
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
        // Before the socket goes: this is the last chance to tell the host that
        // this phone should stop being woken for a machine it is leaving.
        await forgetPushRegistration()
        interactionPoll?.cancel()
        eventListener?.cancel()
        await connection?.disconnect()
        connection = nil
        welcome = nil
        sessions = []
        selectedSessionId = nil
        // Captured first. Iterating `hosts` after `hosts = []` walked an empty
        // array, so "start over" left every stored session list on disk.
        let forgetting = hosts.map(\.hostId)
        host = nil
        hosts = []
        try? await credentials.clear()
        for forgotten in forgetting { await indexStore.remove(hostId: forgotten) }
        titles = [:]
        workspacePaths = []
        hasStoredIndex = false
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
            await refreshWorkspaces()
            lastError = nil
            // Written after the workspaces, so the two halves of one answer land
            // together rather than as a list with the previous workspace set.
            await persistIndex()
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

    /// Re-read which workspaces DSH has.
    ///
    /// Best effort, and deliberately silent on failure. The workspaces are a
    /// filter over a list the screen can draw without them, so a host that does
    /// not answer leaves the previous answer in place rather than emptying the
    /// screen.
    private func refreshWorkspaces() async {
        // `connection.call`, not `call`: the shared helper reconnects the whole
        // socket when a request fails, and this is a best-effort read of a
        // method an older host does not implement. Going through it meant one
        // unimplemented method tore down the connection every time the session
        // list refreshed -- which the context figure above the composer noticed
        // before anything else did.
        guard let connection else { return }
        do {
            let result = try await connection.call("workspace.list", as: WorkspaceListResult.self)
            // An empty answer is treated as "no answer". A host that genuinely
            // has no workspaces is a host with no sessions, and then there is
            // nothing to filter anyway.
            guard !result.items.isEmpty else { return }
            workspacePaths = Set(result.items.map(\.path))
        } catch {
            // Left alone on purpose. See above.
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
    /// Two callers want different things from it. A call that has just failed
    /// wants one quick retry before it reports, so those paths get three fast
    /// attempts. The failure screen's button is a person asking again, and there
    /// the only honest answer is to keep trying while their network comes back:
    /// three attempts inside a second is a formality, not a retry. The device log
    /// from the phone that prompted this reads `-1009`, "not connected to the
    /// internet" -- no number of sub-second retries outlasts that.
    ///
    /// - Parameter patient: whether to keep trying long enough to outlast a
    ///   phone that has lost its network.
    /// - Returns: whether a connection is now open.
    @discardableResult
    func reconnect(patient: Bool = false) async -> Bool {
        guard let host else { return connection != nil }
        if reconnecting {
            // Someone else is already bringing the socket back; wait for them.
            //
            // This used to `return connection != nil`, which reports "still
            // down" rather than "wait" -- because the attempt already in flight
            // clears `connection` at its top, so during the whole of a reconnect
            // every concurrent caller was told there was no connection and threw.
            //
            // Two reads run together on the session screen, usage and the
            // conversation, and they share one socket: one dropped request made
            // them fail as a pair. That is the reported symptom exactly -- the
            // Usage tab empty and the message list sitting at a strange offset,
            // together, and only sometimes.
            // Wait for the attempt in flight -- but never on itself, and never
            // without end.
            //
            // This loop deadlocked the whole app. `reconnect` used to refresh
            // the session list before releasing the flag, and that refresh can
            // itself fail and call `reconnect`: the inner call arrived while the
            // flag was still held, waited here for the outer one to finish, and
            // the outer one was blocked waiting for the inner. Neither ever
            // returned, `reconnecting` stayed true for the life of the process,
            // and from then on every failed request waited here forever -- which
            // is why every conversation sat on a spinner while the connection
            // underneath was healthy and answering. The refresh no longer
            // happens inside the lock; the deadline and the cancellation check
            // are so that a future mistake of the same shape stalls a request
            // instead of the app.
            let deadline = ContinuousClock.now.advanced(by: .seconds(20))
            while reconnecting, ContinuousClock.now < deadline {
                do {
                    try await Task.sleep(for: .milliseconds(50))
                } catch {
                    break
                }
            }
            return connection != nil
        }
        reconnecting = true
        defer { reconnecting = false }

        eventListener?.cancel()
        interactionPoll?.cancel()
        await connection?.disconnect()
        connection = nil

        let attempts = patient ? 8 : 3
        for attempt in 0..<attempts {
            if attempt > 0 {
                let pause = patient ? min(4_000, 400 << attempt) : 400 * attempt
                try? await Task.sleep(for: .milliseconds(pause))
            }
            guard let next = makeConnection(for: host) else { continue }
            do {
                _ = try await next.connect()
                connection = next
                lastError = nil
                startInteractionPoll()
                // `phase` decides which screen is on. This never touched it, so
                // a retry that *succeeded* left the operator looking at "Cannot
                // reach the Mac" with a working connection behind it -- the
                // button did its job and the screen never said so. That was the
                // bug: "Try again does nothing" was true on the only screen
                // where it could be seen.
                phase = .ready
                // The session list is *not* refreshed here. It used to be, and
                // that call is what closed the deadlock above; every caller
                // either refreshes for itself or is about to.
                return true
            } catch {
                let message = Self.describe(error, authority: host.authority ?? host.baseURL)
                lastError = message.isEmpty ? nil : message
                // Keep the screen's text current. A retry that fails for a new
                // reason -- no internet rather than the Mac being unreachable --
                // should say so instead of repeating the line from before.
                if case .failed = phase, !message.isEmpty { phase = .failed(message) }
            }
        }
        return false
    }

    /// Fetch the page before the oldest one held, and fold it in.
    ///
    /// What scrolling to the top of a conversation asks for. The host pages by
    /// `beforeSeq`, so the position to ask for is the oldest log entry the phone
    /// already has -- and when it has none, there is nothing to page from.
    ///
    /// - Parameter sessionId: the session to extend.
    /// - Returns: how many new items arrived, `0` when the host was asked and
    ///   has nothing older, or `nil` when the question could not be asked at
    ///   all. The caller must not treat `nil` as the end of the conversation:
    ///   every early exit here is a condition that can clear on its own.
    @discardableResult
    func loadOlder(sessionId: String) async -> Int? {
        guard connection != nil else { return nil }
        guard let cached = await conversations.load(sessionId: sessionId),
              let before = cached.oldestSeq
        else { return nil }
        // Nothing older to ask for. Without this the scroll-to-top would fire a
        // request on every appearance for a page that cannot change. This one is
        // definitive: the host said so, not a transient failure of ours.
        guard cached.hasMore else { return 0 }

        do {
            let result = try await call(
                "session.messages",
                payload: .object([
                    "sessionId": .string(sessionId),
                    "maxMessages": .number(200),
                    "beforeSeq": .number(Double(before)),
                ]),
                as: SessionMessagesResult.self,
            )
            let fresh = result.conversationItems()
            let reached = result.oldestSeq
            // The host answers with the tail before `beforeSeq`, so the same
            // page coming back means there is nothing further; stopping is what
            // keeps a scroll at the top from looping.
            if reached == nil || reached == before || fresh.isEmpty { return 0 }

            // Folded in as one step, so a reload landing at the same moment
            // cannot have its write undone by this one.
            let stored = await conversations.update(sessionId: sessionId) { current in
                // `current` rather than the `cached` read before the request:
                // that one is several round trips old by now, and anything the
                // time it took fetched would be thrown away.
                let known = current ?? cached
                return CachedConversation(
                    sessionId: sessionId,
                    items: mergeConversations(cached: known.items, fresh: fresh),
                    throughSeq: known.throughSeq,
                    hasMore: result.hasMore,
                    turns: mergeTurns(cached: known.turns ?? [], fresh: result.conversationTurns()),
                    oldestSeq: [before, reached].compactMap { $0 }.min(),
                    stats: known.stats,
                )
            }
            lastError = nil
            return stored.items.count - cached.items.count
        } catch {
            let message = Self.describe(error, authority: host?.authority ?? host?.baseURL)
            if !message.isEmpty { lastError = message }
            return nil
        }
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
        // One at a time, and the flag is released on every exit.
        //
        // This has no other guard: the button that starts it is disabled while
        // `isSyncing`, but `syncProgress` was only set after the session list
        // came back, so a second tap in that window started a second full pass
        // over every session. Measured on a real run, seven passes' worth of
        // pages were fetched for one refresh -- about five megabytes each, over
        // a relay, on a phone.
        //
        // The `defer` matters more than the guard. `syncProgress` was assigned
        // nil at the end of the happy path only, so any early return or
        // cancellation left `isSyncing` true for good, with the refresh button
        // spinning and disabled and no way back.
        guard syncProgress == nil else { return }
        guard connection != nil else {
            // Reported rather than silently skipped. The window is already up
            // by the time this runs, and doing nothing looks exactly like having
            // nothing to do.
            syncProblem = "Not connected to the Mac."
            return
        }
        syncProblem = nil
        // One clock for the whole pass, carried across the two assignments
        // below: the estimate is measured from when the operator asked, not from
        // whenever the session list happened to come back.
        let startedAt = Date()
        syncProgress = SyncProgress(current: "", completed: 0, total: sessions.count, startedAt: startedAt)
        defer { syncProgress = nil }

        await refreshSessions()
        guard !sessions.isEmpty else {
            // Either the Mac listed nothing or the read failed. Both are worth
            // saying out loud; neither is "up to date".
            syncProblem = lastError ?? "The Mac listed no sessions."
            return
        }

        let runnable = sessions.filter { $0.parentSessionId == nil }
        syncProgress = SyncProgress(current: "", completed: 0, total: runnable.count, startedAt: startedAt)

        for (index, session) in runnable.enumerated() {
            syncProgress?.current = session.cwd.map { ($0 as NSString).lastPathComponent } ?? session.sessionId
            await syncConversation(for: session.sessionId)
            // The usage frame too, not only the messages. It carries the row's
            // title and the model and context figures above the composer, and a
            // history download that skipped it left every row unnamed and every
            // session's cost unknown until the operator opened it -- on a link
            // that may not answer by then. One extra request per session, once.
            if let frame = await stats(for: session.sessionId),
               let title = frame.title, !title.isEmpty {
                titles[session.sessionId] = title
            }
            syncProgress?.completed = index + 1
        }
        await persistIndex()
        // The pass ran to the end. Whatever went wrong inside it is already in
        // `lastError`, and this is the line that lets the window stop saying it.
        syncProblem = lastError
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
            let older = result.oldestSeq
            // Read, merged and written as one step. Loading here and saving
            // three lines later is two, and the automatic paging at the top of
            // this conversation runs against a returning-to-foreground reload --
            // two overlapping read-modify-writes of one file lose one of them,
            // and what is lost is a page somebody just asked for.
            let stored = await conversations.update(sessionId: sessionId) { cached in
                CachedConversation(
                    sessionId: sessionId,
                    items: mergeConversations(cached: cached?.items ?? [], fresh: fresh),
                    throughSeq: result.asOfSeq,
                    hasMore: result.hasMore,
                    // Grouped on the fresh page and kept beside it, because a
                    // page is where the turn boundaries are -- they are in the
                    // records, and the merged item list has already lost which
                    // step belonged to what.
                    turns: mergeTurns(cached: cached?.turns ?? [], fresh: freshTurns),
                    // The older of the two: this page may not reach as far back as
                    // what is already stored, and paging from the wrong end would
                    // re-fetch what is already here.
                    oldestSeq: [cached?.oldestSeq, older].compactMap { $0 }.min(),
                    // Carried forward: this write replaces the whole file, and
                    // dropping the frame here would undo the cache above.
                    stats: cached?.stats,
                )
            }
            lastError = nil
            conversationError = nil
            return stored.items
        } catch {
            let message = Self.describe(error, authority: host?.authority ?? host?.baseURL)
            if !message.isEmpty { lastError = message }
            // A cancelled read leaves no message -- `describe` filters those out
            // because they are not the operator's fault -- so the screen fell
            // through to "this session has no messages", which is a claim about
            // their session made from the absence of an answer. On a phone this
            // is the ordinary case, not an edge one: switching apps suspends the
            // process and cancels whatever was in flight.
            conversationError = message.isEmpty
                ? "The Mac did not answer. Pull down to try again."
                : message
            return await conversations.load(sessionId: sessionId)?.items ?? []
        }
    }

    /// The last usage frame stored on this phone, if any.
    /// - Parameter sessionId: the session.
    /// - Returns: the frame, or `nil` when nothing is stored.
    func cachedStats(for sessionId: String) async -> SessionStatsFrame? {
        await conversations.load(sessionId: sessionId)?.stats
    }

    /// Keep a usage frame beside the session's conversation.
    ///
    /// Read-modify-write, because the file holds both: replacing it with just
    /// the frame would throw the history away.
    ///
    /// - Parameters:
    ///   - frame: what the host sent.
    ///   - sessionId: the session it belongs to.
    private func storeStats(_ frame: SessionStatsFrame, for sessionId: String) async {
        // One step, for the same reason: this runs from the usage read while a
        // page may be being folded in beside it, and the file holds both.
        await conversations.update(sessionId: sessionId) { existing in
            CachedConversation(
                sessionId: sessionId,
                items: existing?.items ?? [],
                throughSeq: existing?.throughSeq,
                syncedAt: existing?.syncedAt ?? Date(),
                hasMore: existing?.hasMore ?? false,
                turns: existing?.turns,
                oldestSeq: existing?.oldestSeq,
                stats: frame,
            )
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
        guard connection != nil else {
            statsError = "Not connected to the Mac."
            return nil
        }
        do {
            let payload = JSONValue.object(["sessionId": .string(sessionId)])
            let result = try await call(
                "session.stats",
                payload: payload,
                as: SessionStatsResult.self,
            )
            statsError = nil
            if let frame = result.stats {
                // Written down as well as returned. The figures above the
                // composer are read from this, and a session screen that has to
                // wait for the network before it can say which model is
                // answering says nothing at all when the network does not come
                // back -- which on a phone is the ordinary case.
                await storeStats(frame, for: sessionId)
            }
            return result.stats
        } catch {
            // Reported rather than swallowed. This returned `nil` for every
            // failure, so a decode problem and a session with no usage looked
            // the same on screen -- which is how "the usage screen never loads"
            // stayed unexplained through several rounds.
            let message = Self.describe(error, authority: host?.authority ?? host?.baseURL)
            if !message.isEmpty { lastError = message }
            statsError = message.isEmpty ? "The Mac did not answer." : message
            return nil
        }
    }

    /// Tell the host where to reach this phone, and whether it is on screen.
    ///
    /// Called on every connection and every time iOS issues a token. Both are
    /// needed: the token arrives once and the connection is rebuilt constantly,
    /// and a registration sent on a socket that has since been replaced is a
    /// registration the host never saw.
    ///
    /// Best-effort throughout. A phone that cannot be notified is a worse app,
    /// not a broken one, and an error here would be a failure screen over a
    /// feature the operator may not even want.
    func syncPushRegistration() async {
        guard let connection, let token = PushRegistration.storedToken else { return }
        let payload = JSONValue.object([
            "token": .string(token),
            "environment": .string(PushRegistration.environment),
            "locale": .string(PushRegistration.locale),
        ])
        do {
            _ = try await connection.call("push.register", payload: payload, as: PushRegistrationResult.self)
        } catch {
            // Logged by the host's side of the story; nothing to show here.
        }
        await sendPresence()
    }

    /// Report whether this app is on screen.
    ///
    /// Its own method rather than folded into the registration, because it runs
    /// on every app switch and the registration tells the relay where the phone
    /// is. Together they would put an HTTP request to the relay behind every
    /// switch away from the app.
    ///
    /// - Parameter foreground: whether the app is in the foreground.
    func setPresence(foreground: Bool) async {
        self.foreground = foreground
        await sendPresence()
    }

    /// Whether the app last told the host it was on screen.
    private var foreground = true

    private func sendPresence() async {
        guard let connection else { return }
        let payload = JSONValue.object(["foreground": .bool(foreground)])
        _ = try? await connection.call("push.presence", payload: payload, as: AcceptanceResult.self)
    }

    /// Forget this phone's notification endpoint.
    ///
    /// Called when the operator unpairs, so a phone that has been detached stops
    /// being woken for a machine it no longer knows about.
    func forgetPushRegistration() async {
        guard let connection else { return }
        _ = try? await connection.call("push.unregister", as: PushUnregisterResult.self)
    }

    /// Register for remote notifications if the operator has already agreed.
    ///
    /// Runs on every launch. The prompts above deliberately happen once, and iOS
    /// only offers each permission once anyway -- so somebody who tapped "Don't
    /// Allow" and then changed their mind in iOS Settings would otherwise have
    /// to reinstall the app before a single notification could arrive. Asking
    /// Apple for a token when permission is already granted costs nothing and
    /// closes that hole.
    func ensurePushRegistration() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        guard settings.authorizationStatus == .authorized
            || settings.authorizationStatus == .provisional
        else {
            // Forgets a token from a previous grant. The operator can revoke
            // permission in iOS Settings at any time, and a token that outlives
            // the permission is a row on the Mac's roster that pushes into
            // nothing.
            PushRegistration.storedToken = nil
            return
        }
        await Permissions.registerForRemoteNotifications()
    }

    /// Ask for what the app cannot do without, on the first launch after install.
    ///
    /// Two prompts and no more. Notifications, because a phone that cannot be
    /// told anything is a phone the operator has to keep opening; and the local
    /// network, because the direct route to a Mac on the same Wi-Fi is refused
    /// silently without it -- which is the worst kind of failure, since the app
    /// looks connected and never is.
    ///
    /// Asked here rather than where each is first needed, because both arrive as
    /// system alerts and an alert during pairing reads as the pairing failing.
    ///
    /// The camera is asked for where it is used -- on the scan button -- and that
    /// is the whole reason this file has a comment about what it leaves out.
    ///
    /// Once ever, tracked in `UserDefaults`: iOS only offers each of these once
    /// anyway, and re-requesting a permission the operator already refused does
    /// nothing but burn a turn.
    func requestFirstRunPermissions() async {
        guard !Self.launchSkipsPermissions else { return }
        guard !UserDefaults.standard.bool(forKey: Self.permissionsAskedKey) else { return }
        UserDefaults.standard.set(true, forKey: Self.permissionsAskedKey)
        await Permissions.requestNotifications()
        // Only if the answer was yes. Registering regardless gave a phone that
        // tapped "Don't Allow" a token anyway, which it then handed to the Mac --
        // so the host logged a healthy registration for a phone that could never
        // show the notification it was being sent.
        await ensurePushRegistration()
        // Sequenced rather than concurrent: two alerts at once is one alert
        // dismissed by reflex, and this one has to be read to be answered.
        await Permissions.requestLocalNetwork()
    }

    /// Whether this launch should skip the system prompts.
    ///
    /// For UI tests, which run against a fresh install and would otherwise be
    /// answered by a system alert instead of by the app.
    private static var launchSkipsPermissions: Bool {
        ProcessInfo.processInfo.arguments.contains("-mizarSkipPermissionPrompts")
    }

    /// Where "the operator has been asked" is remembered.
    private static let permissionsAskedKey = "mizar.permissionsAsked"

    /// Download everything once, with the whole screen reporting how it is going.
    ///
    /// `defer`, not a happy-path assignment: a cancelled load -- and a phone
    /// switching away mid-download is the ordinary case -- must not leave the
    /// full-screen progress view up for good.
    private func runFirstLoad() async {
        firstLoad = true
        defer { firstLoad = false }
        await syncAllConversations()
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
            try await connect(using: paired)
            // The history comes down before anything else, and this time it is
            // the whole screen.
            //
            // It used to be a background task with a spinner in a toolbar, on
            // the reasoning that the operator should see the app working rather
            // than a dialog. Measured against a real pairing, the opposite is
            // true: until this has run, every screen is empty -- no sessions, no
            // titles, no figures -- and an empty app is indistinguishable from a
            // broken one. A first pairing is the one moment where a progress
            // dialog is the honest thing to show.
            //
            // Also before the naming prompt: that prompt belongs to the session
            // screen, and the session screen is not in the hierarchy while this
            // is.
            await runFirstLoad()
            pendingNameHostId = paired.hostId
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
        // Before the first request, not after it. Everything below waits on a
        // machine that may be asleep, and a session list that is empty until a
        // round trip lands is empty for as long as the round trip takes -- which
        // on a phone is how the operator spends the first several seconds of
        // every launch.
        await loadIndex(for: host.hostId)
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
        // After the session list, so the first screen is not waiting on a
        // registration the operator never asked for. A round trip, not a
        // dependency: the app works identically whether or not it lands.
        await syncPushRegistration()
        startInteractionPoll()

        if let requested = Self.launchSelectedSession {
            selectedSessionId = requested == "first" ? sessions.first?.sessionId : requested
        }
    }

    /// Why the last usage read failed, when it did.
    ///
    /// Separate from ``lastError`` because the usage screen needs to tell two
    /// things apart that both arrive as "no stats": a session that has never
    /// sent a request, and a read that did not happen. It showed the first for
    /// both, so a failure was reported to the operator as a fact about their
    /// session -- "This session has not sent a request" -- which is untrue and
    /// unfalsifiable from the screen. That is why "the usage query does not
    /// work" could not be diagnosed: the app was asserting the answer.
    private(set) var statsError: String?

    /// Why the last conversation read produced nothing, when it failed.
    ///
    /// The companion of ``statsError`` and for the same reason: "we could not
    /// ask" and "there is nothing there" are different answers, and the screen
    /// was giving the second for both.
    private(set) var conversationError: String?

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
