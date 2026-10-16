//
//  ComposerBar.swift
//  DSH-Mizar
//
//  The strip between the conversation and the field: which model is answering,
//  how full the context window is, and the host's own commands.
//
//  It is laid out like DSH's own composer, and it replaced a segmented control
//  that swapped the conversation for a usage screen. The swap was the problem:
//  "what is it doing" and "what has it cost" are asked at the same time, and a
//  control that shows one by hiding the other makes the second question cost a
//  tap and a scroll back. Three figures in a row cost neither.
//
//  Every element is a control, not a label. The model pill opens the model
//  picker, the context pill opens the breakdown, and the command button opens
//  the list -- which is how DSH's own bar behaves.
//

import SwiftUI
import MizarKit

/// The three controls above the composer.
struct ComposerBar: View {
    let sessionId: String
    /// The session's usage frame, when it has been read.
    let stats: SessionStatsFrame?
    /// What has been typed. The command button writes into this directly.
    ///
    /// It was a callback that ran `draft = command` on the screen that owns the
    /// field, and the write never landed: the sheet closed, the field stayed
    /// empty. A closure handed down into an overlay is the kind of indirection
    /// that fails silently, so the button owns the write instead.
    @Binding var draft: String
    /// Whether the field holds the keyboard, so a command can focus it.
    @FocusState.Binding var focused: Bool
    @Environment(AppModel.self) private var model
    /// Which panel is open, owned by the screen rather than by this view.
    ///
    /// These were `@State` here, and the bar sits inside an overlay whose
    /// content SwiftUI rebuilds as the conversation scrolls. A panel whose
    /// openness is stored in a view that gets rebuilt closes itself the moment
    /// it opens -- which is what happened: the buttons worked and nothing
    /// appeared.
    @Binding var showingModel: Bool
    @Binding var showingContext: Bool
    @Binding var showingCommands: Bool

    /// DSH's own commands. The slash forms are what the host parses; the titles
    /// are what the operator is choosing between.
    static let commands: [(slash: String, title: String, symbol: String)] = [
        ("/goal", "Goal", "target"),
        ("/plan", "Plan", "list.bullet.rectangle"),
        ("/compact", "Compact", "arrow.down.right.and.arrow.up.left"),
        ("/model", "Model", "cpu"),
    ]

    var body: some View {
        HStack(spacing: 6) {
            // The model takes whatever the other two leave. They are fixed
            // words -- "上下文 35%" and "+ 命令" are exactly as wide as their own
            // text -- while the model name is the one thing here that can be
            // long. Equal thirds truncated it to "deepsee…", naming neither the
            // model nor the effort; the reference bar is proportioned this way.
            modelPill
                .layoutPriority(1)
            contextPill
                .fixedSize(horizontal: true, vertical: false)
            commandButton
                .fixedSize(horizontal: true, vertical: false)
        }
        .padding(.horizontal, 8)
        .padding(.top, 6)
        .padding(.bottom, 2)
        // A sheet for all three, and the same detent for all three.
        //
        // They were popovers, which is the tidier panel for this kind of detail
        // -- but a popover presented from this bar never appeared. The bar lives
        // in an overlay on the scroll view, and SwiftUI would not anchor a
        // popover there: the button's action ran and nothing came up. A sheet
        // presents from anywhere, it is the system's own control, and the point
        // the operator raised was that the three should look the same.
        .sheet(isPresented: $showingModel) {
            ModelPickerView(sessionId: sessionId)
        }
        .sheet(isPresented: $showingContext) {
            ContextDetail(stats: stats)
                .presentationDetents([.height(300)])
                .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: $showingCommands) {
            CommandList { command in
                // Written first, then closed. The other order dismissed the
                // sheet and the write went with it.
                draft = command
                focused = true
                showingCommands = false
            }
            .presentationDetents([.height(260)])
            .presentationDragIndicator(.visible)
        }
    }

    /// `deepseek-v4 · High`, as the host reports the route it is using.
    private var modelLabel: String {
        // A pending change wins: it is what the next turn will use, and showing
        // the old one until it takes effect reads as the picker not working.
        guard let selection = stats?.model?.next ?? stats?.model?.lastUsed ?? fallbackSelection else {
            return String(localized: "Model")
        }
        var text = selection.model
        if let effort = selection.reasoningEffort, !effort.isEmpty {
            text += " · \(effort.capitalized)"
        }
        return text
    }

    /// The route a new turn would take, when this session has not chosen one.
    ///
    /// A session that has never run reports no selection at all, and the button
    /// then read just "Model" -- which is the one thing it must never say, since
    /// naming the model is its whole job. The catalog's default answers it.
    private var fallbackSelection: ModelSelection? {
        model.modelCatalog?.defaultSelection
    }

    private var modelPill: some View {
        Button { showingModel = true } label: {
            HStack(spacing: 4) {
                Image(systemName: "cpu")
                    .font(.system(size: 11, weight: .semibold))
                Text(modelLabel)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                    // Tail, not middle. Middle truncation of "deepseek-flash"
                    // gives "deepsee…sh", which names neither the family nor the
                    // size; dropping the end at least keeps "deepseek-fl…".
                    .truncationMode(.tail)
                Spacer(minLength: 2)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.system(size: 8, weight: .semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 12)
            // Taller than it was. At 6pt of padding the three controls read as a
            // compressed strip rather than as the row of buttons the reference
            // shows.
            .frame(height: 34)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .liquidCapsule()
        .accessibilityLabel("Model, \(modelLabel)")
        .accessibilityIdentifier("composer.model")
    }

    // MARK: - Context

    private var contextPercent: Int? { stats?.context?.percent }

    private var contextPill: some View {
        Button { showingContext = true } label: {
            HStack(spacing: 5) {
                ContextRing(percent: contextPercent)
                Text(contextLabel)
                    .font(.caption.weight(.medium))
                    .lineLimit(1)
                Spacer(minLength: 2)
            }
            .padding(.horizontal, 12)
            .frame(height: 34)
        }
        .buttonStyle(.plain)
        .liquidCapsule()
        .disabled(stats?.context == nil)
        .accessibilityLabel("Context, \(contextLabel)")
        .accessibilityIdentifier("composer.context")
    }

    private var contextLabel: String {
        // "Context" is the catalogue key on its own and the figure is appended
        // to it. `String(localized: "Context \(percent)%")` builds the key
        // `Context %lld%`, which was in the catalogue and still did not resolve
        // -- so the Chinese interface showed the English word.
        guard let percent = contextPercent else { return String(localized: "Context") }
        return "\(String(localized: "Context")) \(percent)%"
    }

    // MARK: - Commands

    private var commandButton: some View {
        Button { showingCommands = true } label: {
            HStack(spacing: 4) {
                Image(systemName: "plus")
                    .font(.system(size: 11, weight: .bold))
                Text("Commands")
                    .font(.caption.weight(.medium))
                Spacer(minLength: 2)
            }
            .padding(.horizontal, 12)
            .frame(height: 34)
        }
        .buttonStyle(.plain)
        .liquidCapsule()
        .accessibilityLabel("Commands")
        .accessibilityIdentifier("composer.commands")
    }
}

/// The host's commands, as a list to choose from.
private struct CommandList: View {
    let onPick: (String) -> Void

    var body: some View {
        NavigationStack {
            // A VStack, not a List.
            //
            // As List rows with `.buttonStyle(.plain)` the taps never reached
            // the buttons at all: the list stayed open, the action never ran,
            // and the field stayed empty. Measured by the test -- the row was
            // on screen, the tap was delivered somewhere, and `onPick` was not
            // called. Plain rows have no such opinion, and every one of them is
            // a button whose whole width is tappable.
            VStack(spacing: 0) {
                ForEach(ComposerBar.commands, id: \.slash) { command in
                    Button {
                        onPick(command.slash + " ")
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: command.symbol)
                                .frame(width: 20)
                                .foregroundStyle(.secondary)
                            Text(command.title)
                            Spacer(minLength: 12)
                            Text(command.slash)
                                .font(.caption.monospaced())
                                .foregroundStyle(.tertiary)
                        }
                        .padding(.horizontal, 16)
                        .frame(height: 46)
                        .contentShape(.rect)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("command.\(command.slash.dropFirst())")
                }
                Spacer(minLength: 0)
            }
            .navigationTitle("Commands")
            .navigationBarTitleDisplayMode(.inline)
        }
    }
}

/// The little occupancy dial beside the context figure.
private struct ContextRing: View {
    let percent: Int?

    var body: some View {
        ZStack {
            Circle()
                .stroke(.secondary.opacity(0.25), lineWidth: 2)
            if let percent {
                Circle()
                    .trim(from: 0, to: min(1, max(0, Double(percent) / 100)))
                    .stroke(tint, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
        }
        .frame(width: 12, height: 12)
    }

    /// Amber past three quarters, red past nine tenths. A window that is nearly
    /// full is the thing that makes a session start summarising itself, and it
    /// should be visible before it happens rather than after.
    private var tint: Color {
        guard let percent else { return .secondary }
        if percent >= 90 { return .red }
        if percent >= 75 { return .orange }
        return .accentColor
    }
}

/// What the context figure is made of.
private struct ContextDetail: View {
    let stats: SessionStatsFrame?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let context = stats?.context {
                row("Window", context.window.map { $0.formatted(.number.grouping(.automatic)) } ?? "—")
                row("Pressure", context.pressureTokens.map { $0.formatted(.number.grouping(.automatic)) } ?? "—")
                row("Projected", context.projectedTokens.map { $0.formatted(.number.grouping(.automatic)) } ?? "—")
                if let breakdown = context.breakdown {
                    Divider()
                    row("System", breakdown.systemTokens.formatted(.number.grouping(.automatic)))
                    row("Tools", breakdown.toolsTokens.formatted(.number.grouping(.automatic)))
                    row("Messages", breakdown.messageTokens.formatted(.number.grouping(.automatic)))
                }
            } else {
                Text("No context figure yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(minWidth: 220)
    }

    private func row(_ title: String, _ value: String) -> some View {
        HStack {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 16)
            Text(value)
                .font(.caption.monospacedDigit().weight(.medium))
        }
    }
}

extension View {
    /// A capsule of the system's own translucent material.
    ///
    /// Liquid glass where the OS has it and a thin material where it does not.
    /// The deployment target is iOS 18, so the newer effect has to be asked for
    /// rather than assumed -- but asking for it matters: on the phone this runs
    /// on it is the difference between a control that looks native and one that
    /// looks like a rounded rectangle.
    @ViewBuilder
    func liquidCapsule() -> some View {
        liquidSurface(in: Capsule())
    }

    /// The same material in any shape, or nothing at all.
    ///
    /// - Parameters:
    ///   - shape: what to pour it into.
    ///   - condition: when false the view is returned untouched, which is how a
    ///     control that fills itself with a solid colour avoids a layer of glass
    ///     underneath it.
    /// - Returns: the surfaced view.
    @ViewBuilder
    func liquidSurface<S: Shape>(in shape: S, when condition: Bool = true) -> some View {
        if condition {
            if #available(iOS 26.0, *) {
                self.glassEffect(.regular, in: shape)
            } else {
                self.background(.ultraThinMaterial, in: shape)
            }
        } else {
            self
        }
    }
}

/// Groups neighbouring glass so it blends instead of meeting in a seam.
///
/// `GlassEffectContainer` is iOS 26; before that each surface stands alone, which
/// is what every other OS version expects anyway.
struct GlassRow<Content: View>: View {
    var spacing: CGFloat = 8
    @ViewBuilder var content: Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: spacing) {
                content
            }
        } else {
            content
        }
    }
}
