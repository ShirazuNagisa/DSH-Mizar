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
    /// Polled rather than pushed: the host does not yet broadcast a new approval
    /// to connected devices, so the phone has to ask. That is a real limitation
    /// -- a request that arrives between polls waits up to one interval -- and
    /// the interval is kept short to bound it.
    private(set) var pending: PendingInteractions?
    /// The models this host offers.
    private(set) var modelCatalog: ModelCatalog?
    /// The permission presets this host offers.
    private(set) var permissionCatalog: PermissionCatalog?
    /// The idempotency key for the prompt currently being submitted.
    private var lastRequestId: String?
    /// The poll that watches for pending interactions.
    private var interactionPoll: Task<Void, Never>?

    /// How often to ask the host for pending interactions.
    private static let interactionPollSeconds: Duration = .seconds(4)

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
            phase = .failed(Self.describe(error))
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

    /// Ask the host what is waiting, and keep asking while connected.
    private func startInteractionPoll() {
        interactionPoll?.cancel()
        interactionPoll = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refreshInteractions()
                try? await Task.sleep(for: Self.interactionPollSeconds)
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
            phase = .failed(Self.describe(error))
            return false
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
            )
            try await credentials.save(paired)
            host = paired
            try await connect(using: paired)
        } catch {
            phase = .failed(Self.describe(error))
        }
    }

    /// Open the socket and load the first screen's data.
    /// - Parameter host: the pairing to connect with.
    private func connect(using host: PairedHost) async throws {
        phase = .connecting
        let connection = MizarConnection(
            configuration: .init(
                authority: host.authority,
                token: host.deviceToken,
                appVersion: Self.appVersion,
                deviceModel: Self.deviceModel,
            ),
        )
        self.connection = connection

        let welcome = try await connection.connect()
        self.welcome = welcome
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
    private static func describe(_ error: any Error) -> String {
        if let mizar = error as? MizarError { return mizar.message }
        return String(describing: error)
    }
}
