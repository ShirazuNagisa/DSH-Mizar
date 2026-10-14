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
    let loading: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if loading && items.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            } else if items.isEmpty {
                ContentUnavailableView(
                    "Nothing yet",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("This session has no messages."),
                )
            } else {
                ForEach(items) { item in
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
        }
    }
}

/// One message.
private struct MessageBubble: View {
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
                Text(text)
                    .textSelection(.enabled)
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
            Text(label).font(.caption).foregroundStyle(.secondary)
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
