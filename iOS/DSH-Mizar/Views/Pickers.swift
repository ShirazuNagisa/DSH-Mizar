//
//  Pickers.swift
//  DSH-Mizar
//
//  Changing the model, the reasoning effort, and the permission preset.
//
//  All three are shown as the current value rather than as a menu, because the
//  question an operator actually has is "what is it on now", and that should not
//  require opening anything.
//

import SwiftUI
import MizarKit

/// Model and reasoning effort.
struct ModelPickerView: View {
    let sessionId: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var chosenProvider: String?
    @State private var chosenModel: String?
    @State private var chosenEffort: String?

    var body: some View {
        NavigationStack {
            List {
                if let catalog = model.modelCatalog {
                    ForEach(catalog.providers) { provider in
                        Section(provider.name) {
                            ForEach(provider.models) { option in
                                modelRow(provider: provider, option: option)
                            }
                        }
                    }
                    if !catalog.failures.isEmpty {
                        // A provider that could not be listed is shown, not
                        // hidden: its models being absent is information.
                        Section("Unavailable") {
                            ForEach(catalog.failures) { failure in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(failure.name)
                                    Text(failure.message)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                } else {
                    ProgressView().task { await model.loadCatalogs() }
                }
            }
            .navigationTitle("Model")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                // Seed from what this session was last told to use. Without it
                // the picker opened with nothing marked, so there was no way to
                // tell which model was in force -- the row builder has always
                // drawn a checkmark, it just never had anything to draw it on.
                guard chosenModel == nil, let choice = model.modelChoice[sessionId] else { return }
                chosenProvider = choice.provider
                chosenModel = choice.model
                chosenEffort = choice.effort
            }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .task { await model.loadCatalogs() }
    }

    @ViewBuilder
    private func modelRow(provider: ProviderGroup, option: ModelOption) -> some View {
        let isChosen = chosenModel == option.id && chosenProvider == provider.id
        VStack(alignment: .leading, spacing: 6) {
            Button {
                chosenProvider = provider.id
                chosenModel = option.id
                chosenEffort = option.defaultEffort
                // A model with no effort levels commits immediately: there is
                // nothing else to choose, and an extra tap would be a formality.
                if option.efforts.isEmpty {
                    Task { await commit(provider: provider.id, model: option.id, effort: nil) }
                }
            } label: {
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(option.name)
                        if let description = option.description {
                            Text(description)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    Spacer()
                    if isChosen { Image(systemName: "checkmark").foregroundStyle(Color.accentColor) }
                }
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("model.row.\(option.id)")

            if isChosen && !option.efforts.isEmpty {
                effortPicker(provider: provider.id, option: option)
            }
        }
    }

    @ViewBuilder
    private func effortPicker(provider: String, option: ModelOption) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Thinking")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Picker("Thinking", selection: Binding(
                get: { chosenEffort ?? "" },
                set: { newValue in
                    chosenEffort = newValue.isEmpty ? nil : newValue
                    Task { await commit(provider: provider, model: option.id, effort: chosenEffort) }
                },
            )) {
                ForEach(option.efforts) { effort in
                    Text(effort.name).tag(effort.id)
                }
            }
            .pickerStyle(.segmented)
        }
        .padding(.leading, 4)
    }

    private func commit(provider: String, model: String, effort: String?) async {
        await self.model.setModel(
            provider: provider,
            model: model,
            effort: effort,
            sessionId: sessionId,
        )
        dismiss()
    }
}

/// Permission presets.
struct PermissionPickerView: View {
    let sessionId: String

    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var confirming: PermissionOption?

    var body: some View {
        NavigationStack {
            List {
                if let catalog = model.permissionCatalog {
                    Section {
                        ForEach(catalog.options) { option in
                            Button {
                                if option.isDangerous {
                                    confirming = option
                                } else {
                                    Task { await apply(option) }
                                }
                            } label: {
                                optionRow(option)
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier("permission.row.\(option.value)")
                        }
                    } footer: {
                        Text("Applies to this session immediately. A running turn is not interrupted.")
                    }
                } else {
                    ProgressView().task { await model.loadCatalogs() }
                }
            }
            .navigationTitle("Permissions")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .alert(
                "Allow full access?",
                isPresented: Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }),
                presenting: confirming,
            ) { option in
                Button("Cancel", role: .cancel) { confirming = nil }
                Button("Allow", role: .destructive) {
                    confirming = nil
                    Task { await apply(option) }
                }
            } message: { option in
                Text(option.description ?? "This preset grants unrestricted access to your machine.")
            }
        }
        .task { await model.loadCatalogs() }
    }

    private func optionRow(_ option: PermissionOption) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(option.name)
                    if option.isDangerous {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                            .font(.caption)
                    }
                }
                if let description = option.description {
                    Text(description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer()
        }
    }

    private func apply(_ option: PermissionOption) async {
        _ = await model.setPermission(option.value, sessionId: sessionId)
        dismiss()
    }
}
