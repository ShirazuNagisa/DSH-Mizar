//
//  DomainModels.swift
//  MizarKit
//
//  Typed views of what the host reports.
//
//  Every optional here mirrors an optional on the host, and the host's rule is
//  the important part: **an absent projection key means the capability is not
//  composed, not that its value is zero.** A token count of `nil` must render as
//  "unknown"; rendering it as `0` would be a lie an operator could act on. So
//  optionals are preserved all the way to the view layer rather than being
//  defaulted here.
//

import Foundation

// MARK: - Host

/// Host identity and protocol facts.
public struct HostInfo: Decodable, Sendable, Equatable {
    public let hostId: String
    public let hostName: String
    /// The host's DSH home directory.
    public let home: String
    public let protocolVersion: Int
}

// MARK: - Sessions

/// The session list.
public struct SessionListResult: Decodable, Sendable, Equatable {
    public let items: [SessionRow]
}

/// The workspaces DSH has.
public struct WorkspaceListResult: Decodable, Sendable, Equatable {
    public let items: [WorkspaceRow]
}

/// One workspace, as the host reports it.
///
/// The phone needs the path and nothing else: it already has the sessions, and
/// a workspace is what tells it which of their working directories DSH still
/// recognises.
public struct WorkspaceRow: Decodable, Sendable, Equatable, Identifiable {
    public let workspaceId: String
    /// The directory the workspace is rooted at.
    public let path: String
    /// What DSH calls it.
    public let title: String

    public var id: String { workspaceId }
}

/// One row in the session list.
public struct SessionRow: Decodable, Sendable, Equatable, Identifiable {
    public let sessionId: String
    /// Last activity, epoch milliseconds.
    public let updatedAt: Double
    /// Whether a turn is currently executing.
    public let running: Bool
    /// Whether the session has no user prompt yet.
    public let blank: Bool
    /// Whether an agent can be resolved for it.
    public let agentAvailable: Bool
    public let cwd: String?
    /// Present when this row is a subagent.
    public let parentSessionId: String?
    /// `"subagent"` for delegated children.
    public let origin: String?

    public var id: String { sessionId }

    /// Last activity as a date.
    public var updatedDate: Date { Date(timeIntervalSince1970: updatedAt / 1000) }

    /// Whether this row is a delegated child session.
    public var isSubagent: Bool { origin == "subagent" || parentSessionId != nil }
}

// MARK: - Usage

/// One session's usage frame.
public struct SessionStatsResult: Decodable, Sendable, Equatable {
    public let sessionId: String
    /// The log cursor the frame reflects; `nil` when the session is unknown.
    public let asOfSeq: Double?
    /// `nil` when the token meter is not composed — not a zeroed stand-in.
    public let stats: SessionStatsFrame?
}

/// Everything the usage screen renders.
public struct SessionStatsFrame: Codable, Sendable, Equatable {
    public let tokenUsage: TokenUsage?
    public let cacheHit: CacheHit?
    public let context: ContextPressure?
    public let stats: Throughput?
    public let model: ModelSelectionPair?
    public let permissionPreset: String?
    public let title: String?
}

/// Cumulative billed tokens over the whole durable log.
public struct TokenUsage: Codable, Sendable, Equatable {
    public let uncachedInputTokens: Int
    public let outputTokens: Int
    public let cacheReadTokens: Int
    public let cacheWriteTokens: Int
    /// `uncachedInputTokens + cacheReadTokens + cacheWriteTokens`.
    public let billedInputTokens: Int
}

/// Cache effectiveness, computed host-side.
public struct CacheHit: Codable, Sendable, Equatable {
    /// Exact ratio in `[0, 1]`, or `nil` when nothing has been billed.
    public let ratio: Double?
    /// Display-ready percentage that never overstates the saving.
    ///
    /// A string rather than a number because "99.96% rounds to 100%" is exactly
    /// the claim a cache report must not make; the host picks the precision and
    /// the app must not re-round it.
    public let displayPercent: String?
}

/// Context-window occupancy.
public struct ContextPressure: Codable, Sendable, Equatable {
    public let window: Int?
    public let pressureTokens: Int?
    public let projectedTokens: Int?
    /// Occupancy percentage, clamped to 100, or `nil` when uncomputable.
    public let percent: Int?
    /// Approximate composition; never sums to `projectedTokens`.
    public let breakdown: ContextBreakdown?
}

/// Approximate composition of the context.
public struct ContextBreakdown: Codable, Sendable, Equatable {
    public let systemTokens: Int
    public let toolsTokens: Int
    public let messageTokens: Int
}

/// Latency and throughput folded from the durable log.
public struct Throughput: Codable, Sendable, Equatable {
    public let turns: Int
    public let steps: Int
    public let llmMs: Double
    public let toolMs: Double
    /// Time to first token, averaged over the steps that reported one.
    public let ttftMs: Double?
    public let decodeTokensPerSecond: Double?
}

/// The route the last request used, and any pending change.
public struct ModelSelectionPair: Codable, Sendable, Equatable {
    public let lastUsed: ModelSelection?
    public let next: ModelSelection?
}

/// A provider, model and optional reasoning effort.
public struct ModelSelection: Codable, Sendable, Equatable, Hashable {
    public let provider: String
    public let model: String
    public let reasoningEffort: String?
}

// MARK: - Model catalog

/// The model catalog the picker renders.
public struct ModelCatalog: Decodable, Sendable, Equatable {
    /// The route a new session would use.
    public let defaultSelection: ModelSelection?
    public let providers: [ProviderGroup]
    /// Providers that failed to enumerate; shown rather than hidden.
    public let failures: [CatalogFailure]

    private enum CodingKeys: String, CodingKey {
        // `default` is a Swift keyword; the wire name is kept via CodingKeys.
        case defaultSelection = "default"
        case providers
        case failures
    }
}

/// One provider and its models.
public struct ProviderGroup: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let models: [ModelOption]
}

/// One selectable model.
public struct ModelOption: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let description: String?
    /// The reasoning levels this model accepts, in the provider's order.
    ///
    /// Empty means the model takes no `reasoningEffort`; sending one is a hard
    /// error upstream rather than something that gets clamped, so the picker
    /// must not offer one.
    public let efforts: [ReasoningEffortOption]
    /// The level the provider applies when none is chosen.
    public let defaultEffort: String?
}

/// One reasoning level.
public struct ReasoningEffortOption: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let description: String?
}

/// A provider that could not be listed.
public struct CatalogFailure: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let name: String
    public let message: String
}

/// The outcome of selecting a model for a session.
public struct SelectModelResult: Decodable, Sendable, Equatable {
    public let sessionId: String
    public let selected: ModelSelection
}

// MARK: - Permissions

/// The permission presets this host currently offers.
public struct PermissionCatalog: Decodable, Sendable, Equatable {
    /// Presets a session may be switched to.
    public let options: [PermissionOption]
    /// Presets offered for future sessions' default.
    public let defaults: [PermissionOption]
    /// The preset a new session would use.
    public let defaultPreset: String
}

/// One selectable preset.
public struct PermissionOption: Decodable, Sendable, Equatable, Identifiable {
    /// The preset id passed back when switching.
    public let value: String
    public let name: String
    public let description: String?

    public var id: String { value }

    /// Whether this preset grants unrestricted filesystem and network access.
    ///
    /// The UI asks for a second confirmation before switching to it. `auto` is
    /// deliberately not treated as dangerous here: it is a live-only preset with
    /// its own review integration, not a blanket grant.
    public var isDangerous: Bool { value == "danger-full-access" }
}

// MARK: - Interactions

/// Everything waiting on the operator right now.
public struct PendingInteractions: Decodable, Sendable, Equatable {
    public let approvals: [PendingApproval]
    public let questions: [PendingQuestion]

    /// Whether anything needs the operator's attention.
    public var isEmpty: Bool { approvals.isEmpty && questions.isEmpty }
}

/// An approval awaiting a decision.
public struct PendingApproval: Decodable, Sendable, Equatable, Identifiable {
    public let requestId: String
    public let sessionId: String?
    public let toolName: String
    public let callId: String?
    public let reason: String?
    /// Localized presentation text, when the requesting tool supplied one.
    public let displayReason: [String: String]?
    public let requestedAt: Double

    public var id: String { requestId }

    /// The best text to show for why the action needs approval.
    ///
    /// - Parameter preferredLocale: the locale to prefer.
    /// - Returns: the localized text when present, else the raw reason.
    public func reasonText(preferring preferredLocale: String) -> String? {
        if let displayReason {
            let language = String(preferredLocale.prefix(2))
            if let match = displayReason[language] { return match }
            if let fallback = displayReason["en"] { return fallback }
        }
        return reason
    }
}

/// Outcomes the operator may choose for an approval.
public enum ApprovalOutcome: String, Sendable, CaseIterable {
    /// Grants the action once. The only outcome that grants anything.
    case allowedOnce = "allowed-once"
    case rejected
}

/// A question batch awaiting answers.
public struct PendingQuestion: Decodable, Sendable, Equatable, Identifiable {
    public let callId: String
    public let sessionId: String?
    public let questions: [QuestionItem]
    public let requestedAt: Double

    public var id: String { callId }
}

/// One question in a batch.
public struct QuestionItem: Decodable, Sendable, Equatable, Identifiable {
    public let id: String
    public let question: String
    public let detail: String?
    public let header: String?
    public let options: [QuestionOption]
    public let multiSelect: Bool
    /// Set when the question is a plan awaiting approval.
    public let intent: QuestionIntent?
}

/// One answerable option.
public struct QuestionOption: Decodable, Sendable, Equatable {
    public let label: String
    public let description: String?
}

/// A plan review, which is answered like any other question.
public struct QuestionIntent: Decodable, Sendable, Equatable {
    public let kind: String
    /// The label that approves the plan.
    public let approve: String

    public var isPlanReview: Bool { kind == "plan-review" }
}

/// The operator's answer to one question.
public struct QuestionAnswer: Codable, Sendable, Equatable {
    public let id: String
    public let selected: [String]
    public let custom: String?

    public init(id: String, selected: [String], custom: String? = nil) {
        self.id = id
        self.selected = selected
        self.custom = custom
    }
}

/// A batch of answers, one per question.
public struct QuestionAnswerBatch: Codable, Sendable, Equatable {
    public let answers: [QuestionAnswer]

    public init(answers: [QuestionAnswer]) {
        self.answers = answers
    }
}

/// An acceptance response that carries only a flag.
public struct AcceptanceResult: Decodable, Sendable, Equatable {
    public let accepted: Bool
}

/// A newly created or resumed session.
public struct CreateSessionResult: Decodable, Sendable, Equatable {
    public let sessionId: String
    public let agentPreset: String?
}

/// The acceptance of a prompt, with the idempotency key the host recorded.
public struct PromptResult: Decodable, Sendable, Equatable {
    public let accepted: Bool
    public let requestId: String
}

/// The host's report on a permission switch.
public struct SetPermissionResult: Decodable, Sendable, Equatable {
    public let commandResult: CommandResult

    public struct CommandResult: Decodable, Sendable, Equatable {
        public let kind: String
        public let text: String?

        public var succeeded: Bool { kind == "success" }
    }
}
