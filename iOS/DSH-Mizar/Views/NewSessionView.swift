//
//  NewSessionView.swift
//  DSH-Mizar
//
//  Choosing where to work.
//
//  The directory list is derived from the sessions the host has already run,
//  because those are the directories the operator actually uses. A text field is
//  kept alongside it for anywhere new: a picker that cannot reach a path is
//  worse than no picker at all.
//

import SwiftUI

struct NewSessionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    @State private var path = ""
    @State private var creating = false

    var body: some View {
        NavigationStack {
            Form {
                if !model.knownWorkingDirectories.isEmpty {
                    Section("Recent") {
                        ForEach(model.knownWorkingDirectories, id: \.self) { directory in
                            Button {
                                Task { await create(directory) }
                            } label: {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text((directory as NSString).lastPathComponent)
                                        .foregroundStyle(.primary)
                                    Text(directory)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .truncationMode(.head)
                                }
                            }
                        }
                    }
                }

                Section("Anywhere else") {
                    TextField("/Users/you/projects/thing", text: $path)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                }

                Section {
                    Button("Start session") {
                        Task { await create(path.trimmingCharacters(in: .whitespacesAndNewlines)) }
                    }
                    .disabled(path.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || creating)
                } footer: {
                    Text("The host opens this directory and starts a session in it.")
                }
            }
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .disabled(creating)
        }
    }

    private func create(_ cwd: String) async {
        guard !cwd.isEmpty else { return }
        creating = true
        _ = await model.createSession(cwd: cwd)
        creating = false
        dismiss()
    }
}
