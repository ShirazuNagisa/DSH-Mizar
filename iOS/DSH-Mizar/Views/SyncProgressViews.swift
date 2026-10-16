//
//  SyncProgressViews.swift
//  DSH-Mizar
//
//  The two places this app says how long something is going to take.
//
//  They are the same numbers in two sizes, and they exist because of the same
//  complaint: a first pairing downloads every conversation on the Mac, and a
//  refresh re-reads them all, and both used to be a spinner with no end and no
//  idea how far along it was. Over a relay on a phone that is minutes, which is
//  long enough that "is it working" becomes a real question.
//
//  The full-screen one is shown exactly once per pairing. After that the numbers
//  live in a small sheet, because a refresh is something the operator asked for
//  and is waiting on -- not something that should take the screen away.
//

import SwiftUI
import MizarKit

/// "2 min 14 s", at the coarseness a wait deserves.
///
/// Seconds under a minute, minutes above it, and nothing finer: an estimate
/// accurate to the second is not one, and showing it to the second invites the
/// operator to read precision into it that is not there.
///
/// - Parameter seconds: how long.
/// - Returns: the duration in words.
func spellDuration(_ seconds: TimeInterval) -> String {
    let total = max(0, Int(seconds.rounded()))
    if total < 60 { return String(format: String(localized: "%lld s"), total) }
    return String(format: String(localized: "%lld min %lld s"), total / 60, total % 60)
}

/// The one-time download, taking the whole screen.
///
/// Full screen rather than a sheet because there is nothing behind it worth
/// looking at: this runs immediately after pairing, when the phone has never
/// heard of this Mac, so every screen it could cover is empty -- and an empty
/// screen behind a small dialog is indistinguishable from a broken one.
struct FirstLoadView: View {
    let progress: AppModel.SyncProgress?

    var body: some View {
        VStack(spacing: 22) {
            Image(systemName: "arrow.down.circle")
                .font(.system(size: 44, weight: .light))
                .foregroundStyle(.tint)

            VStack(spacing: 6) {
                Text("Setting up")
                    .font(.title2.weight(.semibold))
                    .accessibilityIdentifier("firstload.title")
                Text("Downloading this Mac's conversations, so they are here when the network is not.")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            if let progress, progress.total > 0 {
                ProgressView(value: progress.fraction)
                    .progressViewStyle(.linear)
                VStack(spacing: 4) {
                    Text("Syncing \(progress.completed) of \(progress.total)")
                        .font(.callout.weight(.medium))
                        .monospacedDigit()
                        .accessibilityIdentifier("firstload.counter")
                    Text(progress.current.isEmpty ? "…" : progress.current)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    // Ticked rather than computed once. An estimate is
                    // arithmetic on the clock, and a screen that only re-reads
                    // it when the next session finishes sits on a number that is
                    // wrong for as long as the slowest session takes -- which on
                    // a relay is minutes, and is exactly when somebody is
                    // watching it.
                    if progress.remaining != nil {
                        TimelineView(.periodic(from: .now, by: 1)) { _ in
                            Text("About \(spellDuration(progress.remaining ?? 0)) left")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                                .accessibilityIdentifier("firstload.eta")
                        }
                    }
                }
            } else {
                // No count yet. A determinate bar at zero would be a claim that
                // nothing has happened; this says only that something is.
                ProgressView()
                Text("Looking for sessions…")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(36)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// How a refresh is going, in a sheet the operator can put away.
///
/// Reads the model itself rather than being handed a value, and that is not a
/// style choice. `.sheet`'s content closure is outside the presenting view's
/// body, so a `model.syncProgress` read in there is not tracked -- the sheet is
/// built once with whatever was true at the moment it opened, which is `nil`,
/// and it then says "Up to date" for the whole download. Reading it in *this*
/// body puts the observation inside the subtree that has to update.
struct SyncProgressSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    private var progress: AppModel.SyncProgress? { model.syncProgress }

    var body: some View {
        NavigationStack {
            VStack(spacing: 16) {
                if let progress, progress.total > 0 {
                    ProgressView(value: progress.fraction)
                        .progressViewStyle(.linear)
                    Text("Syncing \(progress.completed) of \(progress.total)")
                        .font(.headline)
                        .monospacedDigit()
                        .accessibilityIdentifier("sync.counter")
                    Text(progress.current.isEmpty ? "…" : progress.current)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    // The estimate is the whole point of the sheet. A count of
                    // "3 of 24" says how far it has come and nothing about how
                    // long that took; on a relay the two are not proportional.
                    if progress.remaining != nil {
                        TimelineView(.periodic(from: .now, by: 1)) { _ in
                            Text("About \(spellDuration(progress.remaining ?? 0)) left")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .monospacedDigit()
                                .accessibilityIdentifier("sync.eta")
                        }
                    }
                } else if progress != nil {
                    ProgressView()
                    Text("Looking for sessions…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if let problem = model.syncProblem {
                    // Not "up to date". Saying everything is stored when the
                    // request was never sent is a claim about the operator's
                    // data made out of nothing -- and it is what tapping refresh
                    // with the Mac unreachable used to say.
                    Label("Could not refresh", systemImage: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text(problem)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .accessibilityIdentifier("sync.problem")
                } else {
                    Label("Up to date", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                    Text("Every conversation on this Mac is stored on this phone.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
            }
            .padding(28)
            .navigationTitle("History")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                        .accessibilityIdentifier("sync.done")
                }
            }
        }
        .presentationDetents([.height(240)])
    }
}
