package net.jonbell.pcs.core

import net.jonbell.pcs.testing.Measurements
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class MeasurementsTest {
    @Test
    fun `nearest rank is the ceil(q n)-th smallest`() {
        assertEquals(10L, Measurements.p95((1L..10L).shuffled()))
        assertEquals(19L, Measurements.p95((1L..20L).toList()))
        assertEquals(95L, Measurements.p95((1L..100L).toList()))
        assertEquals(7L, Measurements.p95(listOf(7L)))
    }

    @Test
    fun `the bootstrap interval is deterministic and inside the sample`() {
        val xs = listOf(410L, 395L, 402L, 520L, 399L, 404L, 398L, 401L, 407L, 396L)
        val a = Measurements.bootstrapCi(xs)
        assertEquals(a, Measurements.bootstrapCi(xs.reversed().shuffled()), "the interval does not depend on the order of the runs")
        assertTrue(a.first >= xs.min() && a.second <= xs.max() && a.first <= a.second)
    }

    @Test
    fun `a constant sample has a point interval`() {
        assertEquals(5L to 5L, Measurements.bootstrapCi(List(10) { 5L }))
    }
}
