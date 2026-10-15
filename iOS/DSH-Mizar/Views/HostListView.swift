//
//  HostListView.swift
//  DSH-Mizar
//
//  The machines this phone is paired with, and the way to add another.
//
//  This is the first screen once anything is paired, and the only screen when
//  nothing is. A phone that manages one Mac is the common case and gets a list
//  of one; a phone that manages three should not have to unpair to switch, which
//  is what the first version required.
//
//  Naming lives here rather than on the host. `Shirazus-Mac-mini.local` is fine
//  once and useless three times, and a name the operator typed on this phone is
//  theirs to change without touching a machine.
//

import SwiftUI
import MizarKit

/// Every paired machine, with a way to add more.
struct HostListView: View {
    @Environment(AppModel.self) private var model
    @State private var showingPairing = false
    @State private var renaming: PairedHost?

    var body: some View {
        List {
            Section("Paired") {
                ForEach(model.hosts, id: \.hostId) { host in
                    Button {
                        Task { await model.open(hostId: host.hostId) }
                    } label: {
                        HostRow(host: host, isOpen: model.host?.hostId == host.hostId)
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("host.row.\(host.hostId)")
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { await model.forget(hostId: host.hostId) }
                        } label: {
                            Label("Forget", systemImage: "trash")
                        }
                        Button {
                            renaming = host
                        } label: {
                            Label("Rename", systemImage: "pencil")
                        }
                    }
                    .contextMenu {
                        Button("Rename…") { renaming = host }
                        Button("Forget", role: .destructive) {
                            Task { await model.forget(hostId: host.hostId) }
                        }
                    }
                }
            }
        }
        .navigationTitle("DSH-Mizar")
        .toolbar {
            ToolbarItemGroup(placement: .topBarLeading) {
                Button {
                    showingPairing = true
                } label: {
                    Label("Add a Mac", systemImage: "plus")
                }
                .accessibilityIdentifier("hosts.add")
            }
        }
        .sheet(isPresented: $showingPairing) {
            PairingView()
        }
        .sheet(item: $renaming) { host in
            RenameSheet(host: host) { name in
                Task { await model.rename(hostId: host.hostId, to: name) }
            }
        }
    }
}

/// One machine.
private struct HostRow: View {
    let host: PairedHost
    let isOpen: Bool

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: "desktopcomputer")
                .foregroundStyle(isOpen ? Color.accentColor : Color.secondary)
                .font(.title3)

            VStack(alignment: .leading, spacing: 3) {
                Text(host.displayName)
                    .font(.body)
                    .foregroundStyle(.primary)
                // The host's own name is shown under a chosen one, so a machine
                // renamed to something memorable can still be identified.
                Text(host.label == nil ? host.pairedAt.formatted(.relative(presentation: .named)) : host.hostName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if isOpen {
                Text("connected")
                    .font(.caption2)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.quaternary, in: Capsule())
                    .foregroundStyle(.secondary)
            }
        }
        .contentShape(Rectangle())
        .padding(.vertical, 2)
    }
}

/// The name prompt.
///
/// Offered once, immediately after pairing, because that is the moment the
/// operator still knows which machine they just scanned. Offered again from the
/// row's menu when they have thought of a better one.
struct RenameSheet: View {
    let host: PairedHost
    let onSave: (String?) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField(host.hostName, text: $name)
                        .textInputAutocapitalization(.words)
                        .accessibilityIdentifier("rename.field")
                } header: {
                    Text("Name this Mac")
                } footer: {
                    Text("Shown only on this phone. Leave it empty to use the machine's own name, \(host.hostName).")
                }
            }
            .navigationTitle("Rename")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    // "Skip", not "Cancel": naming is optional, and a pairing
                    // that has already succeeded must not look like something
                    // the operator can back out of from here.
                    Button("Skip") {
                        onSave(nil)
                        dismiss()
                    }
                    .accessibilityIdentifier("rename.skip")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        onSave(name)
                        dismiss()
                    }
                    .accessibilityIdentifier("rename.save")
                }
            }
            .onAppear { name = host.label ?? "" }
        }
    }
}

extension PairedHost: @retroactive Identifiable {
    /// Identity for `sheet(item:)`.
    public var id: String { hostId }
}

/// The screen a phone shows when it has never been paired.
///
/// It says what to do rather than showing an empty list, and it is the whole of
/// the first-run experience: there is nothing else this app can usefully do
/// without a machine on the other end.
struct UnpairedView: View {
    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("No Mac paired yet", systemImage: "desktopcomputer.trianglebadge.exclamationmark")
            } description: {
                Text("Open DSH on your Mac, find the DSH-Mizar panel in the sidebar, and scan the code it shows.")
            } actions: {
                NavigationLink {
                    PairingView()
                } label: {
                    Text("Scan the code")
                }
                .buttonStyle(.borderedProminent)
                .accessibilityIdentifier("unpaired.scan")
            }
            .navigationTitle("DSH-Mizar")
        }
    }
}
