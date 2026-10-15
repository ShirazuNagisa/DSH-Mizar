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

    /// Offered once, right after a pairing completes.
    private var namingPrompt: Binding<Bool> {
        Binding(
            get: { model.pendingNameHostId != nil },
            set: { if !$0 { model.pendingNameHostId = nil } },
        )
    }

    var body: some View {
        @Bindable var model = model

        NavigationSplitView {
            WorkspaceListView(showingNewSession: $showingNewSession)
                .navigationTitle(model.host?.displayName ?? model.welcome?.hostName ?? "Sessions")
                .toolbar {
                    ToolbarItemGroup(placement: .topBarLeading) {
                        NavigationLink {
                            HostListView()
                        } label: {
                            Label("Macs", systemImage: "desktopcomputer")
                        }
                        .accessibilityIdentifier("sessions.hosts")
                    }
                    ToolbarItemGroup(placement: .topBarTrailing) {
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
                .sheet(isPresented: namingPrompt) {
                    if let host = model.pendingNameHostId.flatMap({ id in
                        model.hosts.first { $0.hostId == id }
                    }) {
                        RenameSheet(host: host) { name in
                            Task { await model.rename(hostId: host.hostId, to: name) }
                        }
                    }
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

/// Workspaces, each expanding into the conversations inside it.
///
/// The shape mirrors the Mac's own sidebar -- new session at the top, then one
/// row per workspace -- because that is what the operator is already looking at
/// when they reach for their phone, and a phone that arranges the same sessions
/// differently is a second thing to learn.
///
/// Subagents are left out. They are real sessions, but they are the agent's
/// bookkeeping rather than the operator's work, and a list where half the rows
/// are delegated children is a list nobody can scan.
struct WorkspaceListView: View {
    @Environment(AppModel.self) private var model
    @Binding var showingNewSession: Bool
    @State private var collapsed: Set<String> = []

    /// Sessions the operator started, grouped by working directory.
    private var workspaces: [(path: String, sessions: [SessionRow])] {
        var byPath: [String: [SessionRow]] = [:]
        for session in model.sessions where session.parentSessionId == nil {
            byPath[session.cwd ?? "", default: []].append(session)
        }
        return byPath
            .map { (path: $0.key, sessions: $0.value.sorted { $0.updatedAt > $1.updatedAt }) }
            .sorted { lhs, rhs in
                // Sessions with no working directory last: they are the ones an
                // operator can least identify, so they should not lead.
                if lhs.path.isEmpty != rhs.path.isEmpty { return !lhs.path.isEmpty }
                return lhs.path < rhs.path
            }
    }

    var body: some View {
        @Bindable var model = model

        List(selection: $model.selectedSessionId) {
            Section {
                Button {
                    showingNewSession = true
                } label: {
                    Label("New session", systemImage: "square.and.pencil")
                }
                .accessibilityIdentifier("sessions.new")
            }

            ForEach(workspaces, id: \.path) { workspace in
                Section {
                    if !collapsed.contains(workspace.path) {
                        ForEach(workspace.sessions) { session in
                            SessionRowView(session: session)
                                .tag(session.sessionId)
                        }
                    }
                } header: {
                    Button {
                        withAnimation(.snappy(duration: 0.2)) {
                            if collapsed.contains(workspace.path) {
                                collapsed.remove(workspace.path)
                            } else {
                                collapsed.insert(workspace.path)
                            }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: collapsed.contains(workspace.path) ? "chevron.right" : "chevron.down")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                            Text(workspaceTitle(workspace.path))
                                .lineLimit(1)
                            Spacer()
                            Text("\(workspace.sessions.count)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                    .textCase(nil)
                    .accessibilityIdentifier("workspace.\(workspace.path)")
                }
            }
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

    /// The last path component, with the parent shown when two would collide.
    private func workspaceTitle(_ path: String) -> String {
        if path.isEmpty { return "No workspace" }
        let name = (path as NSString).lastPathComponent
        let clashes = workspaces.filter { ($0.path as NSString).lastPathComponent == name }
        guard clashes.count > 1 else { return name }
        return (path as NSString).abbreviatingWithTildeInPath
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
            // Dragging the conversation puts the keyboard away, which is what
            // every messaging app does and what a thumb already expects.
            .scrollDismissesKeyboard(.interactively)
            .refreshable { await reload() }

            ComposerView(sessionId: sessionId) { sent in
                await refreshAfterSend(sent)
            }
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

    /// Reload the conversation after a send, allowing for the host's lag.
    ///
    /// The host accepts a prompt and records it a moment later, so reading the
    /// log once straight after a send returns a page without the message in it.
    /// Before this, a sent message simply did not appear until the operator
    /// pulled to refresh -- the send worked, the screen did not say so. Found by
    /// a smoke assertion that counts the message in the log rather than trusting
    /// the `accepted` flag.
    ///
    /// - Parameter sent: the text that was accepted.
    private func refreshAfterSend(_ sent: String) async {
        for _ in 0..<8 {
            items = await model.conversation(for: sessionId)
            let arrived = items.contains { item in
                if case .message(_, .user, let text, _) = item { return text == sent }
                return false
            }
            if arrived { return }
            try? await Task.sleep(for: .milliseconds(500))
        }
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
