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
    /// Why the conversation is empty, when it is empty because the read failed.
    var failure: String?
    /// Called when the top of the conversation comes into view, to fetch what
    /// came before.
    ///
    /// `nil` means the question could not be asked right now -- no connection
    /// yet, the cache not written yet, a page already in flight. `0` means the
    /// host was asked and has nothing older. The distinction is the whole point:
    /// the two were conflated, so a single badly-timed attempt ended the list
    /// permanently.
    var onLoadOlder: (() async -> Int?)?

    @State private var loadingOlder = false
    @State private var exhausted = false
    /// Pages fetched automatically since this row came on screen.
    ///
    /// The sentinel sits at the very top of the log and older messages are
    /// inserted *below* it, so it never leaves the screen and never re-appears.
    /// That is what made loading flaky: `onAppear` fires once for the life of
    /// the view, so the second page was never asked for unless the operator
    /// happened to tap. Re-driving on `items.count` fixes that, and the counter
    /// is what stops it from draining a fifty-page history in one go while the
    /// operator is looking at the top of it.
    @State private var automaticPages = 0
    private static let automaticPageLimit = 3
    /// Below the sentinel, and where the view scrolls on open.
    static let bottomAnchor = "conversation.bottom"

    /// Ask for the page before this one, once.
    ///
    /// `loadingOlder` is a real gate, not a hint: the sentinel, the tap and the
    /// appearance hook can all fire while one request is in flight.
    ///
    /// - Parameters:
    ///   - fetch: the parent's loader.
    ///   - automatic: whether this was the view asking on its own.
    private func fetchOlder(_ fetch: () async -> Int?, automatic: Bool = false) async {
        guard !loadingOlder else { return }
        if automatic, automaticPages >= Self.automaticPageLimit { return }
        if automatic { automaticPages += 1 }
        loadingOlder = true
        let arrived = await fetch()
        // Only a definite answer ends the list. `nil` leaves `exhausted` alone
        // so the next appearance -- or the operator's tap -- asks again.
        if arrived == 0 { exhausted = true }
        loadingOlder = false
    }

    var body: some View {
        // Lazy, not eager. A conversation can hold hundreds of items and every
        // one of them was being laid out whether or not it was on screen, which
        // is what the dropped frames were.
        LazyVStack(alignment: .leading, spacing: 10) {
            // The top of the list is where older messages arrive.
            //
            // Always a visible row, never a bare spinner. The shipped version was
            // a spinner whose *appearance* was the only trigger, and when it
            // returned without fetching it stayed mounted -- so the trigger had
            // already fired and never fired again. The feature went quiet for the
            // rest of the view's life with nothing on screen to say so, which is
            // why loading worked sometimes and not others. A row that can be
            // tapped cannot fail that way.
            if !exhausted, let onLoadOlder, !items.isEmpty {
                Button {
                    Task { await fetchOlder(onLoadOlder) }
                } label: {
                    HStack {
                        Spacer()
                        if loadingOlder {
                            ProgressView().controlSize(.small)
                        } else {
                            Text("Load earlier messages")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                    .frame(minHeight: 28)
                    .contentShape(.rect)
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("conversation.loadOlder")
                // Keyed on the item count, not on appearance. Older messages
                // arrive *below* this row, so the row never disappears and
                // `onAppear` would fire exactly once -- which is the flakiness:
                // one page loaded, the rest needed a tap nobody knew to make.
                // Each page changes the count, so each page re-arms the ask.
                .task(id: items.count) {
                    await fetchOlder(onLoadOlder, automatic: true)
                }
                .onDisappear {
                    // Scrolled away. Someone who comes back to the top is asking
                    // again, and the automatic allowance should be theirs.
                    automaticPages = 0
                }
            }

            if loading && items.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            } else if items.isEmpty, let failure {
                // Not "this session has no messages". That is a statement about
                // the operator's session, and it was being made out of a request
                // that never came back -- suspension cancels whatever is in
                // flight, so on a phone this is ordinary.
                ContentUnavailableView {
                    Label("Could not load the conversation", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(failure)
                }
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

            // Where the view scrolls to on open. A conversation is read from the
            // bottom, so anything else means opening a session lands you in the
            // middle of an argument you then have to scroll out of.
            Color.clear
                .frame(height: 1)
                .id(Self.bottomAnchor)
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
                // Prompt, then the bar, then the turn's answer -- with the detail
                // unfolding *between* the bar and the answer.
                //
                // This shape took three attempts to land on, and each wrong one
                // is worth naming so it is not rebuilt:
                //
                //   first    the answer was drawn above the bar while folded and
                //            folded into the disclosure when opened, so a tap
                //            removed a bubble from directly above the bar and the
                //            bar jumped upward under the operator's finger;
                //   then     everything moved inside the disclosure, which kept
                //            the bar still but hid the answer behind a tap --
                //            the one thing a monitoring app must not do;
                //   now      the bar sits under the prompt and does not move,
                //            the steps open beneath it, and the answer stays on
                //            screen below them either way.
                //
                // The answer is the last thing the model *said*, not the last
                // thing the turn did: a turn usually ends on a tool call, and
                // that is not a summary of anything.
                //
                // A turn that is still running has no answer, and the message
                // that happens to be last is not one either -- it is wherever
                // the model had got to when the screen was drawn. Pulling it out
                // from under the bar presented half a streamed answer as the
                // turn's conclusion and, worse, as a turn that had concluded.
                // While a turn runs its steps all stay behind the bar: nothing
                // is hidden, and nothing is claimed.
                let answer = turn.isRunning
                    ? nil
                    : turn.steps.last { item in
                        if case .message(_, .assistant, _, _) = item { return true }
                        return false
                    }
                let details = answer.map { last in turn.steps.filter { $0.id != last.id } } ?? turn.steps

                DisclosureGroup(isExpanded: $open) {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(details) { item in
                            ConversationRow(item: item)
                        }
                    }
                    .padding(.top, 8)
                } label: {
                    TurnSummary(turn: turn)
                }
                .accessibilityIdentifier("turn.\(turn.id)")

                if let answer {
                    ConversationRow(item: answer)
                }
            } else if turn.isRunning {
                // Running with nothing folded behind it -- a turn that has taken
                // one step, or none yet. The bar stays, because whether the
                // agent is working is the whole reason this screen was opened,
                // and the steps stay in the open because there is nothing yet to
                // fold away.
                TurnSummary(turn: turn)
                    // The same identity the folded row carries, so a caller can
                    // look for a turn's state without knowing whether that turn
                    // happened to have anything to fold.
                    .accessibilityIdentifier("turn.\(turn.id)")
                ForEach(turn.steps) { item in
                    ConversationRow(item: item)
                }
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

/// "Running for 2m 14s", "Completed in 2m 14s", or why it did not.
private struct TurnSummary: View {
    let turn: ConversationTurn

    var body: some View {
        HStack(spacing: 6) {
            if turn.isRunning {
                // A spinner rather than a glyph: this bar is the answer to "is
                // it still working", and motion says that without being read.
                ProgressView().controlSize(.mini)
            } else {
                Image(systemName: turn.failed ? "exclamationmark.triangle" : "checkmark.circle")
                    .font(.caption)
                    .foregroundStyle(turn.failed ? .orange : .secondary)
            }
            headline
            Spacer()
            Text("\(turn.steps.count) steps")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
        // No identifier here. Folded, this view is the label of a
        // `DisclosureGroup`, and that group puts its own accessibility identity
        // on the whole row -- `turn.<n>` -- so anything set in here never
        // reaches the tree. The state is in the label, which is where a reader
        // finds it and where a test finds it.
    }

    /// The state of the turn, and for a running one a clock that moves.
    ///
    /// Ticked locally rather than by re-reading the session. The host's answer
    /// already said when the turn started, and the difference between that and
    /// now is arithmetic the phone can do for itself -- a screen that asked the
    /// Mac for the time every second would be a screen that stopped telling the
    /// time whenever the link hiccuped, which on a phone is constant.
    @ViewBuilder private var headline: some View {
        if turn.isRunning, let beganAt = turn.beganAt {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(
                    String(
                        format: String(localized: "Running for %@"),
                        Self.spell(context.date.timeIntervalSince(beganAt)),
                    ),
                )
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
            }
        } else {
            Text(staticHeadline)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
        }
    }

    /// The headline for a turn whose text does not change.
    private var staticHeadline: String {
        if turn.isRunning { return String(localized: "Running") }
        if turn.failed {
            return turn.duration.map {
                String(format: String(localized: "Unfinished after %@"), Self.spell($0))
            } ?? String(localized: "Unfinished")
        }
        return turn.duration.map {
            String(format: String(localized: "Completed in %@"), Self.spell($0))
        } ?? String(localized: "Completed")
    }

    /// Minutes and seconds, because that is the unit a turn is measured in.
    /// - Parameter seconds: the duration.
    /// - Returns: the duration as words.
    static func spell(_ seconds: TimeInterval) -> String {
        let total = Int(seconds.rounded())
        if total < 60 { return String(format: String(localized: "%lld s"), total) }
        return String(
            format: String(localized: "%lld min %lld s"),
            total / 60,
            total % 60,
        )
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
