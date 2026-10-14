//
//  UsageSection.swift
//  DSH-Mizar
//
//  What a session has cost and how full its context is.
//
//  Every figure here is optional, and the optionals are load-bearing: the host
//  reports `null` for a projection whose owning package is not composed, and the
//  difference between "no cache hit yet" and "this host cannot report cache
//  hits" matters. A dash is honest; a zero is not.
//

import SwiftUI
import MizarKit

struct UsageSection: View {
    let stats: SessionStatsFrame

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if let usage = stats.tokenUsage {
                TokenSection(usage: usage, cache: stats.cacheHit)
            }
            if let context = stats.context {
                ContextSection(context: context)
            }
            if let throughput = stats.stats {
                ThroughputSection(stats: throughput)
            }
            MetadataSection(stats: stats)
        }
    }
}

/// Cumulative token counts and the cache hit rate.
private struct TokenSection: View {
    let usage: TokenUsage
    let cache: CacheHit?

    var body: some View {
        UsageCard("Tokens") {
            LabeledRow("Input (new)", value: usage.uncachedInputTokens.formatted())
            LabeledRow("Input (cache read)", value: usage.cacheReadTokens.formatted())
            LabeledRow("Input (cache write)", value: usage.cacheWriteTokens.formatted())
            LabeledRow("Output", value: usage.outputTokens.formatted())
            Divider()
            LabeledRow("Billed input", value: usage.billedInputTokens.formatted(), emphasised: true)
            LabeledRow("Cache hit", value: cache?.displayPercent.map { "\($0)%" } ?? "—", emphasised: true)
        }
    }
}

/// Context-window occupancy and composition.
private struct ContextSection: View {
    let context: ContextPressure

    var body: some View {
        UsageCard("Context") {
            if let percent = context.percent, let window = context.window {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("Used").foregroundStyle(.secondary)
                        Spacer()
                        Text("\(percent)% of \(window.formatted())").monospacedDigit()
                    }
                    ProgressView(value: Double(percent), total: 100)
                }
            } else {
                LabeledRow("Used", value: "—")
            }
            if let projected = context.projectedTokens {
                LabeledRow("Next request", value: projected.formatted())
            }
            if let breakdown = context.breakdown {
                Divider()
                LabeledRow("System", value: breakdown.systemTokens.formatted())
                LabeledRow("Tools", value: breakdown.toolsTokens.formatted())
                LabeledRow("Messages", value: breakdown.messageTokens.formatted())
                Text("Composition is approximate and will not add up to the total above.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}

/// Turns, latency and throughput.
private struct ThroughputSection: View {
    let stats: Throughput

    var body: some View {
        UsageCard("Activity") {
            LabeledRow("Turns", value: stats.turns.formatted())
            LabeledRow("Steps", value: stats.steps.formatted())
            LabeledRow("Model time", value: formatMilliseconds(stats.llmMs))
            LabeledRow("Tool time", value: formatMilliseconds(stats.toolMs))
            LabeledRow("First token", value: stats.ttftMs.map(formatMilliseconds) ?? "—")
            LabeledRow(
                "Decode",
                value: stats.decodeTokensPerSecond.map { "\(Int($0.rounded())) tok/s" } ?? "—",
            )
        }
    }
}

/// The route and permission the session is running under.
private struct MetadataSection: View {
    let stats: SessionStatsFrame

    var body: some View {
        UsageCard("Session") {
            LabeledRow("Title", value: stats.title ?? "—")
            if let model = stats.model?.lastUsed {
                LabeledRow("Model", value: model.model)
                LabeledRow("Provider", value: model.provider)
                LabeledRow("Thinking", value: model.reasoningEffort ?? "default")
            } else {
                LabeledRow("Model", value: "—")
            }
            LabeledRow("Permission", value: stats.permissionPreset ?? "—")
            if let next = stats.model?.next {
                LabeledRow("Pending change", value: "\(next.provider) / \(next.model)")
            }
        }
    }
}

/// A titled card.
private struct UsageCard<Content: View>: View {
    let title: LocalizedStringKey
    @ViewBuilder let content: Content

    init(_ title: LocalizedStringKey, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.headline)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 12))
    }
}

/// A label and value pair.
private struct LabeledRow: View {
    let label: LocalizedStringKey
    let value: String
    var emphasised = false

    init(_ label: LocalizedStringKey, value: String, emphasised: Bool = false) {
        self.label = label
        self.value = value
        self.emphasised = emphasised
    }

    var body: some View {
        HStack {
            Text(label).foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .monospacedDigit()
                .fontWeight(emphasised ? .semibold : .regular)
        }
        .font(.subheadline)
    }
}

/// Format a duration in milliseconds for display.
/// - Parameter milliseconds: the duration.
/// - Returns: a short human-readable string.
func formatMilliseconds(_ milliseconds: Double) -> String {
    if milliseconds < 1000 { return "\(Int(milliseconds.rounded())) ms" }
    let seconds = milliseconds / 1000
    if seconds < 60 { return String(format: "%.1f s", seconds) }
    return "\(Int((seconds / 60).rounded())) min"
}
