//
//  SettingsView.swift
//  DSH-Mizar
//
//  The second tab, and for now an empty one.
//
//  It is here because the tab bar is here: a bar with one tab is not a bar, and
//  the settings screen is where the pairings, the notification preferences and
//  the cache controls are going to live. Until they do, it says so -- a blank
//  screen reads as a screen that failed to load, and this one is deliberate.
//

import SwiftUI
import MizarKit

struct SettingsView: View {
    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("Nothing to set yet", systemImage: "gearshape")
            } description: {
                // Identified on the text rather than on the container. An
                // identifier set on a `ContentUnavailableView` does not reach the
                // accessibility tree, so a test that looks for it finds nothing
                // and reports the screen as missing -- while it is right there.
                Text("Pairings, notifications and stored history will live here.")
                    .accessibilityIdentifier("settings.empty")
            }
            .navigationTitle("Settings")
        }
    }
}

#Preview {
    SettingsView()
}
