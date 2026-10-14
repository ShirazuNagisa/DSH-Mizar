//
//  RootView.swift
//  DSH-Mizar
//

import SwiftUI
import MizarKit

/// Chooses between pairing and the main screen.
struct RootView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            switch model.phase {
            case .launching:
                ProgressView("Connecting…")
            case .unpaired:
                PairingView()
            case .connecting where model.host == nil:
                ProgressView("Connecting…")
            case .ready, .connecting:
                MainView()
            case .failed(let message):
                ContentUnavailableView {
                    Label("Cannot reach the host", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    Button("Pair again") {
                        Task { await model.unpair() }
                    }
                }
            }
        }
        .task { await model.start() }
    }
}

#Preview {
    RootView().environment(AppModel())
}
