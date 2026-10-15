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
    private var connection: MizarConnection?

    init(credentials: any CredentialStore = KeychainCredentialStore()) {
        self.credentials = credentials
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
            guard let stored = try await credentials.load() else {
                phase = .unpaired
                return
            }
            host = stored
            try await connect(using: stored)
        } catch {
            phase = .failed(Self.describe(error, authority: host?.authority))
        }
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

    /// Forget the pairing and return to the pairing screen.
    func unpair() async {
        interactionPoll?.cancel()
        eventListener?.cancel()
        await connection?.disconnect()
        connection = nil
        welcome = nil
        sessions = []
        selectedSessionId = nil
        host = nil
        try? await credentials.clear()
        phase = .unpaired
    }

    /// Refresh the session list.
    func refreshSessions() async {
        guard let connection else { return }
        do {
            let result = try await connection.call("session.list", as: SessionListResult.self)
            sessions = result.items
        } catch {
            phase = .failed(Self.describe(error))
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
                "maxMessages": .number(40),
            ])
            let result = try await connection.call(
                "session.messages",
                payload: payload,
                as: SessionMessagesResult.self,
            )
            return result.conversationItems()
        } catch {
            return []
        }
    }

    /// Read one session's usage frame.
    /// - Parameter sessionId: the session to read.
    /// - Returns: the frame, or `nil` when it could not be read.
    func stats(for sessionId: String) async -> SessionStatsFrame? {
        guard let connection else { return nil }
        do {
            let payload = JSONValue.object(["sessionId": .string(sessionId)])
            let result = try await connection.call(
                "session.stats",
                payload: payload,
                as: SessionStatsResult.self,
            )
            return result.stats
        } catch {
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
            host = paired
            try await connect(using: paired)
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
    private func open(host: PairedHost, endpoint: PairedHost.Endpoint) async throws {
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

        let connection = MizarConnection(
            configuration: configuration,
            makeTransport: { URLSessionWebSocketTransport(timeout: timeout) },
        )
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
        if let mizar = error as? MizarError { return mizar.message }
        guard let authority else { return error.localizedDescription }
        return ConnectionDiagnosis.of(error, authority: authority).message
    }
}
