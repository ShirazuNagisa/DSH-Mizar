//
//  MainView.swift
//  DSH-Mizar
//
//  The session list, and the conversation it opens.
//
//  A `NavigationSplitView` rather than a stack because the same code has to be
//  right on an iPad, where putting a conversation behind a push wastes the
//  screen, and on a phone, where the split view collapses to exactly the stack
//  behaviour anyway. One layout, two idioms.
//

import SwiftUI
import MizarKit

struct MainView: View {
    @Environment(AppModel.self) private var model
    @State private var showingNewSession = false

    var body: some View {
        @Bindable var model = model

        NavigationSplitView {
            SessionListView()
                .navigationTitle(model.welcome?.hostName ?? "Sessions")
                .toolbar {
                    ToolbarItemGroup(placement: .topBarTrailing) {
                        Button {
                            showingNewSession = true
                        } label: {
                            Label("New session", systemImage: "plus")
                        }
                        .accessibilityIdentifier("sessions.new")
                        Button {
                            Task { await model.refreshSessions() }
                        } label: {
                            Label("Refresh", systemImage: "arrow.clockwise")
                        }
                        .accessibilityIdentifier("sessions.refresh")
                    }
                }
                .sheet(isPresented: $showingNewSession) {
                    NewSessionView()
                }
        } detail: {
            if let sessionId = model.selectedSessionId {
                SessionDetailView(sessionId: sessionId)
            } else {
                ContentUnavailableView(
                    "Pick a session",
                    systemImage: "bubble.left.and.bubble.right",
                    description: Text("Sessions started on your Mac appear here."),
                )
            }
        }
    }
}

/// The list itself.
struct SessionListView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model

        List(model.sessions, selection: $model.selectedSessionId) { session in
            SessionRowView(session: session)
                .tag(session.sessionId)
        }
        .overlay {
            if model.sessions.isEmpty {
                ContentUnavailableView(
                    "No sessions yet",
                    systemImage: "tray",
                    description: Text("Start one on your Mac, then refresh."),
                )
            }
        }
        .refreshable { await model.refreshSessions() }
    }
}

/// One row.
///
/// The host reports no title for most sessions — a title is only assigned once
/// the model produces one — so the row falls back to the working directory,
/// which is what an operator actually uses to tell two sessions apart.
struct SessionRowView: View {
    let session: SessionRow

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if session.running {
                    ProgressView().controlSize(.small)
                }
                Text(title)
                    .lineLimit(1)
                    .font(.body)
                if session.isSubagent {
                    Text("subagent")
                        .font(.caption2)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .background(.quaternary, in: Capsule())
                }
            }
            Text(session.updatedDate, format: .relative(presentation: .named))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }

    private var title: String {
        if let cwd = session.cwd {
            return (cwd as NSString).lastPathComponent
        }
        return session.sessionId
    }
}

/// A session: what is waiting, what it has cost, and somewhere to type.
///
/// The order is deliberate. Pending requests sit above usage because an agent
/// blocked on a decision is more urgent than a number, and the composer is
/// pinned to the bottom where the keyboard expects it.
struct SessionDetailView: View {
    let sessionId: String

    @Environment(AppModel.self) private var model
    @State private var stats: SessionStatsFrame?
    @State private var loading = true
    @State private var showingModelPicker = false
    @State private var showingPermissionPicker = false
    @State private var items: [ConversationItem] = []
    @State private var loadingConversation = true
    @State private var tab: Tab = .conversation

    /// Which half of the session is on screen.
    ///
    /// Two peers rather than one stacked on the other: a monitoring app is used
    /// to answer either "what is it doing" or "what has it cost", and making one
    /// of those mean scrolling past the other gets the priority wrong half the
    /// time.
    private enum Tab: String, CaseIterable, Identifiable {
        case conversation
        case usage
        var id: String { rawValue }

        var title: LocalizedStringKey {
            switch self {
            case .conversation: "Conversation"
            case .usage: "Usage"
            }
        }
    }

    var body: some View {
        VStack(spacing: 0) {
            Picker("View", selection: $tab) {
                ForEach(Tab.allCases) { Text($0.title).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal)
            .padding(.top, 8)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    InteractionsView()

                    switch tab {
                    case .conversation:
                        ConversationView(items: items, loading: loadingConversation)
                    case .usage:
                        if loading {
                            ProgressView().frame(maxWidth: .infinity)
                        } else if let stats {
                            UsageSection(stats: stats)
                        } else {
                            ContentUnavailableView(
                                "No usage yet",
                                systemImage: "chart.bar",
                                description: Text("This session has not sent a request."),
                            )
                        }
                    }
                }
                .padding()
            }
            .refreshable { await reload() }

            ComposerView(sessionId: sessionId)
        }
        .navigationTitle(stats?.title ?? String(localized: "Session"))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItemGroup(placement: .topBarTrailing) {
                Button {
                    showingModelPicker = true
                } label: {
                    Label(stats?.model?.lastUsed?.model ?? "Model", systemImage: "cpu")
                }
                .accessibilityIdentifier("session.model")
                Button {
                    showingPermissionPicker = true
                } label: {
                    Label(stats?.permissionPreset ?? "Permissions", systemImage: "lock.shield")
                }
                .accessibilityIdentifier("session.permissions")
            }
        }
        .sheet(isPresented: $showingModelPicker) {
            ModelPickerView(sessionId: sessionId)
        }
        .sheet(isPresented: $showingPermissionPicker) {
            PermissionPickerView(sessionId: sessionId)
        }
        .task(id: sessionId) { await reload() }
    }

    /// Refresh everything the screen shows.
    private func reload() async {
        loading = true
        loadingConversation = true
        // Run together: the two reads are independent, and a conversation that
        // waits for a stats call would make the screen feel slower than it is.
        async let statsResult = model.stats(for: sessionId)
        async let conversationResult = model.conversation(for: sessionId)
        stats = await statsResult
        items = await conversationResult
        loading = false
        loadingConversation = false
        await model.refreshInteractions()
    }
}
