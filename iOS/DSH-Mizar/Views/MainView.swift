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
    @State private var showingSync = false

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
                .safeAreaInset(edge: .top) {
                    // A refresh that failed says so and stays out of the way. It
                    // used to take over the whole screen, which read as the
                    // connection dying rather than one request not arriving.
                    //
                    // It now also covers a connection that failed outright, for
                    // the same reason: with a stored session list there is a
                    // whole app behind this banner, and taking it away would
                    // take away conversations the operator can still read.
                    if let error = model.problem {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                            Text(error)
                                .font(.caption)
                                .lineLimit(2)
                                // On the text, not the row: an identifier on a
                                // container does not reach the accessibility
                                // tree, so a test looking for the banner would
                                // report the app as silent while it is shouting.
                                .accessibilityIdentifier("sessions.error")
                            Spacer()
                            Button("Retry") {
                                Task {
                                    // Reconnect as well as re-read: a banner over
                                    // stored data is usually a connection that
                                    // went away, and a refresh alone would only
                                    // fail again. The order is the one the
                                    // failure screen uses, and for the same
                                    // reason -- a refresh that fails calls back
                                    // into `reconnect`.
                                    if await model.reconnect(patient: true) {
                                        await model.refreshSessions()
                                    }
                                }
                            }
                            .font(.caption)
                        }
                        .padding(10)
                        .background(.yellow.opacity(0.15))
                    }
                }
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
                            showingSync = true
                            Task { await model.syncAllConversations() }
                        } label: {
                            // Turns while it works. A refresh over a phone link
                            // can take a while, and a button that looks idle
                            // while nothing happens reads as a button that did
                            // nothing.
                            if model.isSyncing {
                                ProgressView().controlSize(.small)
                            } else {
                                Label("Refresh", systemImage: "arrow.clockwise")
                            }
                        }
                        .disabled(model.isSyncing)
                        .accessibilityIdentifier("sessions.refresh")
                    }
                }
                .sheet(isPresented: $showingNewSession) {
                    NewSessionView()
                }
                // Wired, at last. `showingSync` was set by the refresh button and
                // read by nothing: the sheet it was written for was never
                // attached, so a refresh over a slow link was a spinner with no
                // end and no idea how far along it was -- for as long as it took.
                .sheet(isPresented: $showingSync) {
                    SyncProgressSheet()
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
                    .sheet(isPresented: namingPrompt) {
                        if let host = model.pendingNameHostId.flatMap({ id in
                            model.hosts.first { $0.hostId == id }
                        }) {
                            RenameSheet(host: host) { name in
                                Task { await model.rename(hostId: host.hostId, to: name) }
                            }
                        }
                    }
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
    /// Workspaces the operator opened, by path.
    ///
    /// Tracked as what is *open* rather than what is closed, so the default --
    /// an empty set -- is everything folded. It was the other way round, and a
    /// list of five workspaces each holding a dozen identically-titled rows is
    /// not a list anybody can read.
    @State private var expanded: Set<String> = []

    /// How many sessions each workspace shows before offering more.
    @State private var limits: [String: Int] = [:]

    /// How many to add when asked for more.
    private static let pageSize = 10

    /// Sessions the operator started, grouped by working directory.
    ///
    /// Two filters, both of which the list used to get wrong in the same
    /// direction -- by showing rows DSH's own workspace list does not.
    ///
    /// `isSubagent` rather than `parentSessionId`: a delegated child is marked
    /// by *either* fact, and matching on only one of them leaves the other kind
    /// of child on the list.
    ///
    /// `blank` is a session nobody has typed into yet. It has no title, no
    /// turns and no messages, so as a row it reads as ``<dir> · session-`` with
    /// a timestamp -- indistinguishable from a real conversation and impossible
    /// to act on. Measured against a live host, one workspace held eight rows of
    /// which five were subagents and two were blank; DSH's own list showed the
    /// remaining one, and this one showed three.
    ///
    /// The selected session is exempt: a session created from the phone starts
    /// blank, and hiding it the moment it is created would make the row the
    /// operator just tapped vanish under their finger.
    private var workspaces: [(path: String, sessions: [SessionRow])] {
        var byPath: [String: [SessionRow]] = [:]
        for session in model.sessions
        where !session.isSubagent
            && (!session.blank || session.sessionId == model.selectedSessionId)
            && isKnownWorkspace(session.cwd) {
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
                    if expanded.contains(workspace.path) {
                        let shown = workspace.sessions.prefix(limits[workspace.path] ?? Self.pageSize)
                        ForEach(shown) { session in
                            SessionRowView(session: session, title: model.titles[session.sessionId])
                                .tag(session.sessionId)
                        }
                        if workspace.sessions.count > shown.count {
                            Button {
                                limits[workspace.path] = shown.count + Self.pageSize
                            } label: {
                                Text("Show \(min(Self.pageSize, workspace.sessions.count - shown.count)) more")
                                    .font(.caption)
                            }
                            .accessibilityIdentifier("workspace.more.\(workspace.path)")
                        }
                    }
                } header: {
                    Button {
                        withAnimation(.snappy(duration: 0.2)) {
                            if expanded.contains(workspace.path) {
                                expanded.remove(workspace.path)
                            } else {
                                expanded.insert(workspace.path)
                                // Titles are one request each, so they are
                                // fetched when a workspace is opened and only
                                // for the rows it is about to show.
                                let shown = workspace.sessions
                                    .prefix(limits[workspace.path] ?? Self.pageSize)
                                    .map(\.sessionId)
                                Task { await model.loadTitles(for: Array(shown)) }
                            }
                        }
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: expanded.contains(workspace.path) ? "chevron.down" : "chevron.right")
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

    /// Whether DSH still has a workspace rooted at this directory.
    ///
    /// A session is not a workspace. Deleting a workspace removes the host's
    /// registry entry and leaves the session log on disk, so `session.list` keeps
    /// returning sessions from directories DSH no longer recognises -- and
    /// grouping on the working directory drew every one of them. Measured on the
    /// machine this was reported from: 4 workspaces in DSH, 10 rows on the phone.
    ///
    /// An empty set means the host has not told us, and then every directory is
    /// shown: the old behaviour is the safe one to fall back to, because hiding a
    /// workspace somebody is working in is worse than showing one they deleted.
    ///
    /// - Parameter path: the session's working directory.
    /// - Returns: whether to draw a row for it.
    private func isKnownWorkspace(_ path: String?) -> Bool {
        guard !model.workspacePaths.isEmpty else { return true }
        guard let path else { return false }
        return model.workspacePaths.contains(path)
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
    /// DSH's title for the session, when the host has assigned one.
    var title: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                if session.running {
                    ProgressView().controlSize(.small)
                }
                Text(displayTitle)
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

    /// What to call this session.
    ///
    /// The host's title first, because it describes the conversation. Falling
    /// back to the working directory is what the row used to do always, and
    /// since a workspace *is* a working directory every row in one read the same
    /// -- five sessions all called "DSH-Mizar", with nothing to tell them apart.
    ///
    /// A shortened session id is the last resort: it is not a name, but it is
    /// still a way to distinguish one row from the next, which the directory was
    /// not.
    private var displayTitle: String {
        if let title, !title.isEmpty { return title }
        if let cwd = session.cwd {
            let name = (cwd as NSString).lastPathComponent
            return "\(name) · \(session.sessionId.prefix(8))"
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
    @Environment(\.scenePhase) private var scenePhase
    /// Whether this screen is a whole screen rather than a pane of a split view.
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var stats: SessionStatsFrame?
    @State private var loading = true
    @State private var showingModelPicker = false
    @State private var showingContextDetail = false
    @State private var showingCommands = false
    @State private var showingPermissionPicker = false
    @State private var items: [ConversationItem] = []
    /// The same conversation grouped into turns, when the host gave turn numbers.
    @State private var turns: [ConversationTurn] = []
    @State private var loadingConversation = true
    /// Whether this appearance has already jumped to the newest message.
    ///
    /// Once per appearance, not once per load: scrolling to the bottom after a
    /// page of *older* messages arrives would undo the scroll that asked for it.
    @State private var didReachBottom = false
    /// What has been typed, held here because the command button writes to it.
    @State private var draft = ""
    /// Whether the field has the keyboard. Owned here so a tap on the
    /// conversation can put it away.
    @FocusState private var composerFocused: Bool
    /// How tall the floating composer is, measured rather than guessed, so the
    /// scroll content reserves exactly the room it covers.
    @State private var composerHeight: CGFloat = 130
    /// Whether a load of this screen is already running.
    @State private var reloading = false
    /// Bumped when one full load of this screen has finished.
    ///
    /// The scroll is anchored on this rather than on the appearance of content,
    /// so it lands against what is finally on screen rather than against the
    /// cached copy the host's answer is about to replace.
    @State private var loadGeneration = 0
    /// Bumped when something was just sent, to move the view to it.
    @State private var newMessageArrived = 0
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
            // No segmented control here any more. The conversation and the usage
            // figures are the same subject seen two ways, and a control that
            // swaps one for the other hides half of it; the numbers now sit in
            // the row above the composer, where they are visible the whole time
            // and cost no tap.
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        InteractionsView()

                        ConversationView(
                            items: items,
                            turns: turns,
                            loading: loadingConversation,
                            failure: items.isEmpty ? model.conversationError : nil,
                            onLoadOlder: {
                                let arrived = await model.loadOlder(sessionId: sessionId)
                                // Re-read what is on screen; the page was folded
                                // into the cache, and the cache is what the
                                // screen draws from after a successful fetch.
                                if let arrived, arrived > 0,
                                       let cached = await model.cachedConversation(for: sessionId) {
                                        items = cached.items
                                        turns = cached.turns ?? []
                                    }
                                    return arrived
                                },
                            )
                    }
                    .padding()
                }
                // A conversation is read from the bottom. Opening one that starts
                // at the top means re-reading the whole session to find the
                // answer, and coming back to a session you were part-way through
                // means scrolling past everything you already read.
                .defaultScrollAnchor(.bottom)
                // Dragging the conversation puts the keyboard away, which is what
                // every messaging app does and what a thumb already expects.
                .scrollDismissesKeyboard(.interactively)
                .refreshable { await reload() }
                .onChange(of: loadGeneration) { _, _ in
                    // Anchored when the load has *finished*, not when the first
                    // content appears.
                    //
                    // A cached conversation is put on screen immediately and the
                    // host's copy replaces it a moment later. Anchoring on the
                    // first of those parks the scroll view against one page's
                    // worth of rows and then swaps the rows underneath it, which
                    // leaves the list at an offset that matches neither -- the
                    // "strange position" this was reported as, arriving only
                    // sometimes because it depends on whether the cache was warm
                    // and how much the two pages differ.
                    reachBottom(proxy)
                }
                .onChange(of: newMessageArrived) { _, _ in
                    // Unconditional: this one is a send, not an initial load.
                    Task { @MainActor in
                        await Task.yield()
                        proxy.scrollTo(ConversationView.bottomAnchor, anchor: .bottom)
                    }
                }
                // Tapping the conversation puts the keyboard away. Without this
                // the only way out was the Return key or a drag -- and with a
                // multi-line field Return inserts a newline rather than
                // dismissing, so there was no way out at all but the swipe.
                //
                // On the conversation itself, not on the scroll view. As a
                // `simultaneousGesture` on the container it swallowed the taps
                // meant for the bar above the composer: the buttons ran, and the
                // panels they open never appeared. A tap catcher behind the
                // content has no opinion about anything drawn on top of it.
                .background {
                    Color.clear
                        .contentShape(.rect)
                        .onTapGesture { composerFocused = false }
                }
                // The composer floats over the conversation instead of sitting
                // under it. Messages does the same, and the difference is not
                // decoration: a bar that occupies its own row clips the message
                // behind it at a hard edge, so a bubble halfway up the screen is
                // sliced flat. Floating, the content runs underneath and reads
                // through the glass.
                .overlay(alignment: .bottom) {
                    VStack(spacing: 0) {
                        ComposerBar(
                            sessionId: sessionId,
                            stats: stats,
                            draft: $draft,
                            focused: $composerFocused,
                            showingModel: $showingModelPicker,
                            showingContext: $showingContextDetail,
                            showingCommands: $showingCommands,
                        )

                        ComposerView(
                            sessionId: sessionId,
                            text: $draft,
                            onSent: { sent in
                                await refreshAfterSend(sent)
                            },
                            focused: $composerFocused,
                        )
                    }
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                        composerHeight = height
                    }
                }
                // Room to scroll the last message clear of the floating
                // composer, so nothing is permanently underneath it.
                .contentMargins(.bottom, composerHeight, for: .scrollContent)
            }
        }
        .navigationTitle(stats?.title ?? String(localized: "Session"))
        .navigationBarTitleDisplayMode(.inline)
        // The selection bar is put away while a conversation is open.
        //
        // It chooses between the two *screens* -- the conversations and the
        // settings -- and a conversation is not a third one, it is somewhere
        // inside the first. Leaving it up put a second row of controls under a
        // composer that already has two of its own, over the bottom of a
        // transcript that is read from the bottom, and the operator almost never
        // wants the settings from here: they want back, which is what the
        // navigation bar is for.
        //
        // Only in a compact width, though. On an iPad the split view shows the
        // list and the conversation at the same time, so the listing is still on
        // screen next to the conversation and putting the bar away would take it
        // from a screen that is still there.
        .toolbar(sizeClass == .compact ? .hidden : .automatic, for: .tabBar)
        .toolbar {
            // Only the permission selector stays up here. The model is in the
            // bar above the composer now, next to the context figure it is read
            // with -- a bar that shows which model is answering and a button
            // somewhere else that changes it is one decision in two places.
            //
            // The title is the session's, truncated by the navigation bar, which
            // is what Messages does with a long contact name.
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    showingPermissionPicker = true
                } label: {
                    Label(permissionLabel, systemImage: "lock.shield")
                }
                .accessibilityIdentifier("session.permissions")
            }
        }
        .sheet(isPresented: $showingPermissionPicker) {
            PermissionPickerView(sessionId: sessionId)
        }
        .task(id: sessionId) {
            // Once per appearance. Coming back to a session should land at its
            // newest message again; a pull-to-refresh should not, which is why
            // this is reset here and not at the top of `reload()`.
            didReachBottom = false
            await reload()
        }
        .onChange(of: scenePhase) { _, phase in
            // Ask again when the operator comes back.
            //
            // Suspending the process cancels whatever was in flight, and this
            // screen had no way to notice: it would sit there showing whatever
            // the cancellation left behind -- usually nothing -- while the Mac
            // was perfectly reachable. Every phone app is backgrounded
            // constantly, so this is the ordinary path, not an edge one.
            guard phase == .active, !reloading else { return }
            Task { await reload() }
        }
    }

    /// Move the conversation to its newest message, once per appearance.
    ///
    /// One shot rather than on every growth of the list: a page of *older*
    /// messages grows it too, and jumping to the bottom then would undo the very
    /// scroll that asked for them.
    ///
    /// - Parameter proxy: the scroll view to move.
    private func reachBottom(_ proxy: ScrollViewProxy) {
        guard !didReachBottom, !items.isEmpty else { return }
        didReachBottom = true
        Task { @MainActor in
            // One turn of the runloop, so the lazy stack has laid the rows out
            // and there is something to scroll to.
            await Task.yield()
            proxy.scrollTo(ConversationView.bottomAnchor, anchor: .bottom)
        }
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
            // Synced rather than merely read. `conversation(for:)` returns the
            // flat list, and the screen draws *turns* whenever the host gave
            // turn numbers -- so a message that arrived only in the flat list
            // was a message that did not appear. It went unnoticed because the
            // stored conversation, from a previous visit, happened to contain an
            // equivalent prompt: pull-to-refresh fixed it, and a fresh install
            // did not need fixing.
            items = await model.syncConversation(for: sessionId)
            turns = (await model.cachedConversation(for: sessionId))?.turns ?? []
            let arrived = items.contains { item in
                if case .message(_, .user, let text, _) = item { return text == sent }
                return false
            }
            if arrived {
                // What was just typed is at the bottom, and a sent message that
                // lands below the fold reads as a send that did not happen. Every
                // messaging app moves to it; this one used to leave the operator
                // looking at whatever they had scrolled to.
                newMessageArrived += 1
                return
            }
            try? await Task.sleep(for: .milliseconds(500))
        }
    }

    /// The permission preset, as a word rather than a raw value.
    private var permissionLabel: String {
        guard let preset = stats?.permissionPreset else { return String(localized: "Permissions") }
        switch preset {
        case "read-only": return String(localized: "Read only")
        case "workspace-write": return String(localized: "Workspace write")
        case "danger-full-access": return String(localized: "Full access")
        default: return preset
        }
    }

    /// Refresh everything the screen shows.
    ///
    /// Not re-entrant, and that is load-bearing rather than tidy. Three things
    /// call this -- the screen appearing, the app returning to the foreground,
    /// and a pull-to-refresh -- and they overlap freely. Two overlapping loads
    /// interleave on one socket: the first one's failed request reconnects,
    /// which replaces the connection the second one is using, whose request then
    /// fails too and reconnects again.
    ///
    /// Measured from the host's side, that pair sustained itself: a fresh
    /// WebSocket every few seconds, each one re-downloading the same 244 KB
    /// page, `session.stats` printing twice for every `session.messages`, and no
    /// answer ever settling on screen. Every request the Mac received was
    /// answered correctly, which is why this looked like "cannot connect" while
    /// the connection was in fact fine.
    private func reload() async {
        guard !reloading else { return }
        reloading = true
        defer { reloading = false }

        loading = true
        loadingConversation = true
        // The phone's own copy first. It is instant, it is there when the
        // network is not, and the fetch below replaces it when it lands.
        if let cached = await model.cachedConversation(for: sessionId), !cached.items.isEmpty {
            items = cached.items
            turns = cached.turns ?? []
            loadingConversation = false
        }
        // The last known figures, drawn before the network is asked. Without
        // this the bar was blank until a read came back, and stayed blank
        // whenever one did not -- the model name and the context percentage
        // appeared and disappeared from one visit to the next.
        if let known = await model.cachedStats(for: sessionId) {
            stats = known
        }
        // Run together: the two reads are independent, and a conversation that
        // waits for a stats call would make the screen feel slower than it is.
        async let statsResult = model.stats(for: sessionId)
        stats = await statsResult
        // Synced rather than merely read: the result is folded into the cache,
        // so what is on screen and what is on disk are the same thing.
        let conversationResult = await model.syncConversation(for: sessionId)
        // Only replace what is on screen when there is something to replace it
        // with. A read that failed returns the cache rather than nothing, but a
        // cache can be empty on a first visit -- and assigning that over a
        // populated screen is what "pull to refresh loses my history" was.
        let fresh = conversationResult
        if !fresh.isEmpty || items.isEmpty { items = fresh }
        turns = (await model.cachedConversation(for: sessionId))?.turns ?? []
        loading = false
        loadingConversation = false
        await model.refreshInteractions()
        // Last, so the scroll anchor runs against the content that is actually
        // staying on screen.
        loadGeneration += 1
    }
}
