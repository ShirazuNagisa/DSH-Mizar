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
                // Nothing paired at all: the only useful thing on screen is the
                // way to fix that.
                UnpairedView()
            case .connecting where model.host == nil:
                ProgressView("Connecting…")
            case .ready, .connecting:
                MainView()
            case .failed(let message):
                ContentUnavailableView {
                    Label("Cannot reach the Mac", systemImage: "exclamationmark.triangle")
                } description: {
                    Text(message)
                } actions: {
                    // Neither button forgets the pairing, and that is the fix for
                    // a bug that cost people their setup: this screen used to
                    // offer "Pair again", which called `unpair()` and wiped the
                    // stored credential. One dropped request -- a phone changing
                    // networks is enough -- landed here, and the obvious button
                    // made it permanent.
                    Button("Try again") {
                        Task { await model.reconnect() }
                    }
                    .buttonStyle(.borderedProminent)
                    if !model.hosts.isEmpty {
                        NavigationLink("Choose another Mac") {
                            HostListView()
                        }
                    } else {
                        NavigationLink("Scan a code") {
                            PairingView()
                        }
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
