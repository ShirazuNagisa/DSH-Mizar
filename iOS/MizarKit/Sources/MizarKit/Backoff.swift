//
//  Backoff.swift
//  MizarKit
//
//  Reconnection timing.
//
//  Modelled on what DSH's own browser client does — 50%–100% jitter under an
//  escalating cap — because the problem is the same one: a phone that comes back
//  from the background along with every other device should not have them all
//  reconnect in lockstep and knock the host over.
//
//  Jitter is not decoration here. Without it, a host restart produces a
//  synchronised thundering herd from every paired device at exactly the same
//  offset, and the retry that was supposed to recover the connection becomes the
//  thing that prevents it.
//

import Foundation

/// An escalating, jittered retry schedule.
public struct Backoff: Sendable {
    /// Delays for successive attempts, in seconds. The last value repeats.
    public let steps: [Double]
    /// Fraction of a step to jitter away, in `[0, 1)`.
    public let jitter: Double

    private var attempt = 0

    /// DSH's own schedule: 0.5s doubling to a 10s ceiling.
    public static let standard = Backoff(steps: [0.5, 1, 2, 4, 8, 10], jitter: 0.5)

    public init(steps: [Double], jitter: Double = 0.5) {
        precondition(!steps.isEmpty, "a backoff schedule needs at least one step")
        self.steps = steps
        self.jitter = min(max(jitter, 0), 0.99)
    }

    /// The delay before the next attempt, and advance the schedule.
    ///
    /// Each call returns a value in `[step * (1 - jitter), step]`, so a caller
    /// never waits longer than the nominal cap and never waits a fixed amount.
    ///
    /// - Parameter random: a source of randomness in `[0, 1)`; injectable so
    ///   tests are deterministic.
    /// - Returns: the delay in seconds.
    public mutating func nextDelay(random: () -> Double = { Double.random(in: 0..<1) }) -> Double {
        let step = steps[min(attempt, steps.count - 1)]
        attempt += 1
        let floor = step * (1 - jitter)
        return floor + (step - floor) * random()
    }

    /// Return to the first step after a successful connection.
    public mutating func reset() {
        attempt = 0
    }

    /// How many attempts have been made since the last reset.
    public var attempts: Int { attempt }
}
