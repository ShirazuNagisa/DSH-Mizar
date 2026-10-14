//
//  BackoffTests.swift
//  MizarKitTests
//
//  Jitter is the whole point of this type, so the tests pin its bounds rather
//  than a specific schedule: a fixed delay would make every paired device retry
//  in lockstep after a host restart, which is the failure it exists to avoid.
//

import Foundation
import Testing
@testable import MizarKit

@Suite("Backoff")
struct BackoffTests {
    @Test("escalates through the steps and then holds at the cap")
    func escalation() {
        var backoff = Backoff(steps: [0.5, 1, 2], jitter: 0)
        #expect(backoff.nextDelay(random: { 0.5 }) == 0.5)
        #expect(backoff.nextDelay(random: { 0.5 }) == 1)
        #expect(backoff.nextDelay(random: { 0.5 }) == 2)
        // The last step repeats rather than overflowing.
        #expect(backoff.nextDelay(random: { 0.5 }) == 2)
        #expect(backoff.nextDelay(random: { 0.5 }) == 2)
    }

    @Test("keeps every delay within the jitter bounds")
    func jitterBounds() {
        var backoff = Backoff(steps: [10], jitter: 0.5)
        // random == 0 must still respect the floor, not collapse to zero.
        #expect(backoff.nextDelay(random: { 0 }) == 5)
        #expect(backoff.nextDelay(random: { 0.5 }) == 7.5)
        // random == 1 must not exceed the nominal step.
        #expect(backoff.nextDelay(random: { 0.999 }) <= 10)
    }

    @Test("never returns the same delay twice for the same step with jitter on")
    func jitterVaries() {
        var backoff = Backoff(steps: [10], jitter: 0.5)
        let values = Set((0..<20).map { _ in backoff.nextDelay() })
        #expect(values.count > 1)
    }

    @Test("resets to the first step")
    func reset() {
        var backoff = Backoff(steps: [0.5, 1, 2], jitter: 0)
        _ = backoff.nextDelay(random: { 0 })
        _ = backoff.nextDelay(random: { 0 })
        #expect(backoff.attempts == 2)
        backoff.reset()
        #expect(backoff.attempts == 0)
        #expect(backoff.nextDelay(random: { 0 }) == 0.5)
    }

    @Test("clamps an out-of-range jitter rather than producing a negative delay")
    func clampsJitter() {
        var overJittered = Backoff(steps: [10], jitter: 5)
        #expect(overJittered.nextDelay(random: { 0 }) > 0)

        var negative = Backoff(steps: [10], jitter: -1)
        #expect(negative.nextDelay(random: { 0.5 }) == 10)
    }
}
