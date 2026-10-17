package me.shirazu.mizar.kit

import org.junit.jupiter.api.Test
import kotlin.test.*

/**
 * Jitter is the whole point of this type, so the tests pin its bounds rather than a
 * specific schedule: a fixed delay would make every paired device retry in lockstep
 * after a host restart, which is the failure it exists to avoid.
 *
 * Ported from `BackoffTests.swift`. Swift's `Backoff` was a struct, so its tests held a
 * `var`; the Kotlin one is a class that advances in place, and the injected `random`
 * closure plays the part of the Swift closure argument.
 */
class BackoffTest {

    @Test
    fun `escalates through the steps and then holds at the cap`() {
        val backoff = Backoff(steps = listOf(0.5, 1.0, 2.0), jitter = 0.0)
        assertEquals(0.5, backoff.nextDelay(random = { 0.5 }))
        assertEquals(1.0, backoff.nextDelay(random = { 0.5 }))
        assertEquals(2.0, backoff.nextDelay(random = { 0.5 }))
        // The last step repeats rather than overflowing.
        assertEquals(2.0, backoff.nextDelay(random = { 0.5 }))
        assertEquals(2.0, backoff.nextDelay(random = { 0.5 }))
    }

    @Test
    fun `keeps every delay within the jitter bounds`() {
        val backoff = Backoff(steps = listOf(10.0), jitter = 0.5)
        // random == 0 must still respect the floor, not collapse to zero.
        assertEquals(5.0, backoff.nextDelay(random = { 0.0 }))
        assertEquals(7.5, backoff.nextDelay(random = { 0.5 }))
        // random == 1 must not exceed the nominal step.
        assertTrue(backoff.nextDelay(random = { 0.999 }) <= 10.0)
    }

    @Test
    fun `never returns the same delay twice for the same step with jitter on`() {
        val backoff = Backoff(steps = listOf(10.0), jitter = 0.5)
        val values = (0 until 20).map { backoff.nextDelay() }.toSet()
        assertTrue(values.size > 1)
    }

    @Test
    fun `resets to the first step`() {
        val backoff = Backoff(steps = listOf(0.5, 1.0, 2.0), jitter = 0.0)
        backoff.nextDelay(random = { 0.0 })
        backoff.nextDelay(random = { 0.0 })
        assertEquals(2, backoff.attempts)
        backoff.reset()
        assertEquals(0, backoff.attempts)
        assertEquals(0.5, backoff.nextDelay(random = { 0.0 }))
    }

    @Test
    fun `clamps an out-of-range jitter rather than producing a negative delay`() {
        val overJittered = Backoff(steps = listOf(10.0), jitter = 5.0)
        assertTrue(overJittered.nextDelay(random = { 0.0 }) > 0)

        val negative = Backoff(steps = listOf(10.0), jitter = -1.0)
        assertEquals(10.0, negative.nextDelay(random = { 0.5 }))
    }
}
