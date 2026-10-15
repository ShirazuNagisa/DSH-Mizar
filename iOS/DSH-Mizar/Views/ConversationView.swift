//
//  ConversationView.swift
//  DSH-Mizar
//
//  What was said, and what the agent did between the saying.
//
//  Activity events are rendered rather than filtered. "Turn started, step
//  started, permission changed" is the shape of a working agent, and a view that
//  showed only messages could not be told apart from one that was stuck — which
//  is exactly the question a monitoring app exists to answer.
//
//  A failed turn gets the most prominent treatment of anything here. It is the
//  one state where the agent looks busy and is in fact doing nothing.
//

import SwiftUI
import MizarKit

struct ConversationView: View {
    let items: [ConversationItem]
    /// The conversation grouped into turns. Empty when the host sent no turn
    /// numbers, in which case the flat list is drawn instead.
    var turns: [ConversationTurn] = []
    let loading: Bool
    /// Called when the top of the conversation comes into view, to fetch what
    /// came before.
    var onLoadOlder: (() async -> Int)?

    @State private var loadingOlder = false
    @State private var exhausted = false

    var body: some View {
        // Lazy, not eager. A conversation can hold hundreds of items and every
        // one of them was being laid out whether or not it was on screen, which
        // is what the dropped frames were.
        LazyVStack(alignment: .leading, spacing: 10) {
            // The top of the list is where older messages arrive. A spinner that
            // appears as it scrolls into view is what asks for them -- there is
            // no "reached the top" callback in SwiftUI, and the alternative is a
            // button the operator has to find.
            if !exhausted, let onLoadOlder, !items.isEmpty {
                HStack {
                    Spacer()
                    if loadingOlder {
                        ProgressView().controlSize(.small)
                    } else {
                        Color.clear.frame(height: 1)
                    }
                    Spacer()
                }
                .accessibilityIdentifier("conversation.loadOlder")
                .onAppear {
                    guard !loadingOlder else { return }
                    loadingOlder = true
                    Task {
                        let arrived = await onLoadOlder()
                        // Nothing new means the beginning. Without this the
                        // spinner reappears on every scroll and asks forever.
                        if arrived == 0 { exhausted = true }
                        loadingOlder = false
                    }
                }
            }

            if loading && items.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            } else if items.isEmpty {
                ContentUnavailableView(
                    "Nothing yet",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("This session has no messages."),
                )
            } else if turns.isEmpty {
                ForEach(items) { item in
                    ConversationRow(item: item)
                }
            } else {
                // One row per turn rather than one per message. A prompt that
                // took eleven steps arrived as eleven bubbles and read as the
                // model talking to itself; DSH folds them and so does this.
                ForEach(turns) { turn in
                    TurnSection(turn: turn)
                }
            }
        }
    }
}

/// One turn: the prompt in the open, the agent's work folded behind a summary.
private struct TurnSection: View {
    let turn: ConversationTurn

    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(turn.prompts) { item in
                ConversationRow(item: item)
            }

            if turn.isCollapsible {
                // The turn's last word stays on screen whether the turn is open
                // or folded. It is the answer, and an answer behind a tap is not
                // an answer; the tap is for the eleven steps it took to get
                // there.
                let conclusion = turn.steps.last
                if !open, let conclusion {
                    ConversationRow(item: conclusion)
                }
                DisclosureGroup(isExpanded: $open) {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(turn.steps) { item in
                            ConversationRow(item: item)
                        }
                    }
                    .padding(.top, 8)
                } label: {
                    TurnSummary(turn: turn)
                }
                .accessibilityIdentifier("turn.\(turn.id)")
            } else {
                // A turn that produced one reply is not a crowd, and hiding a
                // single answer behind a tap gains nothing.
                ForEach(turn.steps) { item in
                    ConversationRow(item: item)
                }
            }
        }
    }
}

/// "Completed in 2m 14s", or why it did not.
private struct TurnSummary: View {
    let turn: ConversationTurn

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: turn.failed ? "exclamationmark.triangle" : "checkmark.circle")
                .font(.caption)
                .foregroundStyle(turn.failed ? .orange : .secondary)
            Text(headline)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            Spacer()
            Text("\(turn.steps.count) 条")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        .accessibilityIdentifier("turn.summary.\(turn.id)")
    }

    private var headline: String {
        if turn.failed {
            return turn.duration.map { "未完成，用时 \(Self.spell($0))" } ?? "未完成"
        }
        return turn.duration.map { "已完成，用时 \(Self.spell($0))" } ?? "已完成"
    }

    /// Minutes and seconds, because that is the unit a turn is measured in.
    /// - Parameter seconds: the duration.
    /// - Returns: the duration as words.
    static func spell(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded())
        if total < 60 { return "\(total) 秒" }
        return "\(total / 60) 分 \(total % 60) 秒"
    }
}

/// One item, drawn by kind.
private struct ConversationRow: View {
    let item: ConversationItem

    var body: some View {
        switch item {
        case .message(let id, let role, let text, _):
            MessageBubble(id: id, role: role, text: text)
        case .activity(_, let label, let at):
            ActivityMarker(label: label, at: at)
        case .failure(_, let message, _):
            FailureCard(message: message)
        }
    }
}

/// One message.
private struct MessageBubble: View {
    /// The message as Markdown, falling back to plain text.
    ///
    /// An agent answers in Markdown -- bold, lists, `code`, fenced blocks -- and
    /// showing it raw puts asterisks and backticks on screen where formatting
    /// belongs. Agents write in it constantly, so this is the common case rather
    /// than a nicety.
    ///
    /// Three attempts, narrowest last, because `AttributedString` refuses a
    /// string it cannot parse and a half-streamed answer is exactly that: an
    /// unterminated code fence fails `.full`, so it is retried as inline-only,
    /// and plain text is the floor. Something readable beats nothing.
    ///
    /// - Parameter text: the message.
    /// - Returns: the attributed string to draw.
    static func markdown(_ text: String) -> AttributedString? {
        guard Self.looksLikeMarkdown(text) else { return nil }
        if let full = try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .full),
        ) {
            return full
        }
        return try? AttributedString(
            markdown: text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace),
        )
    }

    /// Whether a string carries Markdown worth parsing.
    ///
    /// Cheap and deliberately narrow: a false negative shows backticks, a false
    /// positive costs a parse. Anything without one of these characters is a
    /// sentence, and a sentence needs no parser.
    ///
    /// - Parameter text: the message.
    /// - Returns: whether to parse it.
    static func looksLikeMarkdown(_ text: String) -> Bool {
        text.contains("**") || text.contains("`") || text.contains("\n# ")
            || text.contains("\n- ") || text.contains("\n* ") || text.contains("\n1. ")
            || text.contains("](") || text.contains("\n> ") || text.contains("\n```")
    }

    let id: String
    let role: ConversationItem.Role
    let text: String

    var body: some View {
        HStack {
            if role == .user { Spacer(minLength: 40) }
            VStack(alignment: .leading, spacing: 4) {
                if role == .system {
                    Text("system")
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                if let formatted = Self.markdown(text) {
                    Text(formatted)
                        .textSelection(.enabled)
                        .accessibilityLabel(text)
                } else {
                    // Plain text stays plain. Running it through the Markdown
                    // parser would produce an identical string and a different
                    // view, and the common case deserves the cheaper one.
                    Text(text)
                        .textSelection(.enabled)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(background, in: RoundedRectangle(cornerRadius: 14))
            .foregroundStyle(role == .user ? .white : .primary)
            if role != .user { Spacer(minLength: 40) }
        }
    }

    private var background: Color {
        switch role {
        case .user: .accentColor
        case .assistant: Color(.secondarySystemBackground)
        case .system: Color(.tertiarySystemBackground)
        }
    }
}

/// Something the agent did.
private struct ActivityMarker: View {
    let label: String
    let at: Date

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: "circle.fill").font(.system(size: 4)).foregroundStyle(.tertiary)
            // The label is a key, not display text: MizarKit is a protocol
            // layer and owns no strings. An event name it does not recognise
            // falls through as itself, which is what should happen.
            Text(LocalizedStringKey(label)).font(.caption).foregroundStyle(.secondary)
            Spacer()
            Text(at, format: .dateTime.hour().minute().second())
                .font(.caption2.monospacedDigit())
                .foregroundStyle(.tertiary)
        }
        .padding(.leading, 4)
    }
}

/// A turn that produced nothing.
private struct FailureCard: View {
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("The turn ended without a response", systemImage: "exclamationmark.triangle.fill")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.red)
            Text(message)
                .font(.caption)
                .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.red.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
        .overlay { RoundedRectangle(cornerRadius: 12).strokeBorder(.red.opacity(0.30)) }
    }
}
