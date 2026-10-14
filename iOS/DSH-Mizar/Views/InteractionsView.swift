//
//  InteractionsView.swift
//  DSH-Mizar
//
//  What the agent is waiting for.
//
//  This is the screen the app exists for. An agent that needs a decision is
//  stopped until it gets one, so a request that arrives while the operator is
//  away is the difference between a working session and a stalled one.
//
//  Two rules shape everything here:
//
//    - **The decision is made with the information, not after it.** The tool
//      name, the reason and the arguments are on the card, because approving
//      something you cannot see is not approving it.
//    - **Only `allowed-once` grants anything.** There is deliberately no
//      "always allow": a grant that outlives the request it was given for is a
//      permission change, and those belong in the permission picker where they
//      are visible and reversible.
//

import SwiftUI
import MizarKit

/// The pending requests, if any.
struct InteractionsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let pending = model.pending, !pending.isEmpty {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(pending.approvals) { approval in
                    ApprovalCard(approval: approval)
                }
                ForEach(pending.questions) { question in
                    QuestionCard(question: question)
                }
            }
        }
    }
}

/// One approval.
struct ApprovalCard: View {
    let approval: PendingApproval

    @Environment(AppModel.self) private var model
    @Environment(\.locale) private var locale
    @State private var answering = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label {
                Text("Wants to run \(approval.toolName)")
                    .font(.headline)
            } icon: {
                Image(systemName: "hand.raised.fill")
            }
            .foregroundStyle(.orange)

            if let reason = approval.reasonText(preferring: locale.identifier) {
                Text(reason)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            if let sessionId = approval.sessionId {
                Text(sessionId)
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }

            HStack(spacing: 12) {
                Button(role: .destructive) {
                    Task { await answer(.rejected) }
                } label: {
                    Text("Reject").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)

                Button {
                    Task { await answer(.allowedOnce) }
                } label: {
                    Text("Allow once").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
            }
            .disabled(answering)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.orange.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12).strokeBorder(.orange.opacity(0.35))
        }
        .opacity(answering ? 0.6 : 1)
    }

    private func answer(_ outcome: ApprovalOutcome) async {
        answering = true
        await model.answerApproval(approval, outcome: outcome)
        answering = false
    }
}

/// One question batch.
///
/// Answers accumulate locally and are submitted together: the host matches a
/// batch by its call id, and sending one answer per question would leave the
/// agent waiting on the rest.
struct QuestionCard: View {
    let question: PendingQuestion

    @Environment(AppModel.self) private var model
    @State private var selections: [String: Set<String>] = [:]
    @State private var custom: [String: String] = [:]
    @State private var submitting = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(question.questions) { item in
                QuestionBody(
                    item: item,
                    selected: binding(for: item.id),
                    custom: customBinding(for: item.id),
                )
            }

            Button {
                Task { await submit() }
            } label: {
                Text(question.isPlanReview ? "Approve plan" : "Send answers")
                    .frame(maxWidth: .infinity)
            }
            .buttonStyle(.borderedProminent)
            .disabled(!isComplete || submitting)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding()
        .background(.blue.opacity(0.10), in: RoundedRectangle(cornerRadius: 12))
        .overlay {
            RoundedRectangle(cornerRadius: 12).strokeBorder(.blue.opacity(0.30))
        }
        .opacity(submitting ? 0.6 : 1)
        .onAppear {
            // Pre-select what the question already marks as default, so the
            // common case is one tap rather than reading every option.
            for item in question.questions where item.options.count == 1 {
                selections[item.id] = [item.options[0].label]
            }
        }
    }

    /// Whether every question has something to send.
    private var isComplete: Bool {
        question.questions.allSatisfy { item in
            !(selections[item.id] ?? []).isEmpty
                || !(custom[item.id] ?? "").trimmingCharacters(in: .whitespaces).isEmpty
        }
    }

    private func binding(for id: String) -> Binding<Set<String>> {
        Binding(
            get: { selections[id] ?? [] },
            set: { selections[id] = $0 },
        )
    }

    private func customBinding(for id: String) -> Binding<String> {
        Binding(
            get: { custom[id] ?? "" },
            set: { custom[id] = $0 },
        )
    }

    private func submit() async {
        submitting = true
        let answers = question.questions.map { item in
            let typed = (custom[item.id] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            return QuestionAnswer(
                id: item.id,
                selected: Array(selections[item.id] ?? []),
                custom: typed.isEmpty ? nil : typed,
            )
        }
        await model.answerQuestion(question, answers: answers)
        submitting = false
    }
}

/// One question and its options.
private struct QuestionBody: View {
    let item: QuestionItem
    @Binding var selected: Set<String>
    @Binding var custom: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let header = item.header {
                Text(header)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            Text(item.question)
                .font(.headline)
            if let detail = item.detail {
                Text(detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            ForEach(item.options, id: \.label) { option in
                Button {
                    toggle(option.label)
                } label: {
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: selected.contains(option.label)
                            ? (item.multiSelect ? "checkmark.square.fill" : "largecircle.fill.circle")
                            : (item.multiSelect ? "square" : "circle"))
                            .foregroundStyle(selected.contains(option.label) ? Color.accentColor : .secondary)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.label)
                                .foregroundStyle(.primary)
                            if let description = option.description {
                                Text(description)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                }
                .buttonStyle(.plain)
            }

            TextField("Or type your own answer", text: $custom, axis: .vertical)
                .textFieldStyle(.roundedBorder)
                .lineLimit(1...4)
        }
    }

    private func toggle(_ label: String) {
        if item.multiSelect {
            if selected.contains(label) { selected.remove(label) } else { selected.insert(label) }
        } else {
            // Single-select replaces rather than accumulates, which is what the
            // radio affordance promises.
            selected = selected.contains(label) ? [] : [label]
        }
    }
}

private extension PendingQuestion {
    /// Whether this batch is a plan awaiting approval.
    var isPlanReview: Bool {
        questions.contains { $0.intent?.isPlanReview == true }
    }
}
