package pcs.core.assignment

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import pcs.core.imports.ImportKind
import pcs.core.imports.ImportResult
import pcs.core.imports.Imports
import pcs.core.readings.Answers
import pcs.core.store.Store
import pcs.core.time.Clock
import pcs.testing.Covers
import pcs.testing.Family
import pcs.testing.MirrorFixture
import java.time.Instant

/**
 * S11 through T4: two runs that differ only in a second-opinion member's answer give the same loads. The pair is two mirrors that
 * are identical except for what that member's screen review says (and whether it is submitted), plus the same imports. The plan
 * reads who reviews which paper, never what a review says.
 */
@Family("T4")
@Covers("prop:S11")
class SecondOpinionPairTest {
    private val readings = Answers.parse("Q13=one-junior\nQ14=tier-decides").readings
    private val settings = AssignmentSettings(loadMax = mapOf("senior" to 3, "junior" to 3))

    private fun mirror(opinion: Triple<Long, Int, String>): Pair<PlanInput, PlanResult> {
        val store: Store =
            MirrorFixture.temp {
                (1L..4).forEach { paper(it) }
                // the second-opinion member (s1) reviews paper 1, whatever they said
                review(1, "s1", opinion)
            }
        for (e in listOf("s1", "s2", "s3", "s4", "j1", "j2")) {
            store.conn.createStatement().use { it.executeUpdate("INSERT INTO person(email,name,roles,tags,first_seen_at,last_seen_at) VALUES('$e@example.org','$e','[]','[]',0,0)") }
        }
        val csv = "paper,email,score\n" + (1..4).flatMap { p -> listOf("s1", "s2", "s3", "s4", "j1", "j2").mapIndexed { i, e -> "$p,$e@example.org,${"%.2f".format(0.9 - 0.1 * ((i + p) % 5))}" } }.joinToString("\n") + "\n"
        val clock = Clock { Instant.parse("2030-01-01T00:00:00Z") }
        val r = Imports(store, clock).import(ImportKind.TPMS_SCORES, csv.toByteArray(), "scores.csv")
        assertTrue(r is ImportResult.Accepted)
        val b = (AssignmentData(store, Imports(store, clock)).build(readings, settings) as AssignmentInput.Ready).build
        return b.input to Planner.solve(b.input, b.config).also { store.close() }
    }

    @Test
    fun `the member's answer does not move anyone's load`() {
        val (inA, a) = mirror(Triple(100L, 1, "complete"))
        val (inB, b) = mirror(Triple(100L, 4, "draft"))
        assertEquals(inA.pinned, inB.pinned)
        assertEquals(1, inA.pinned.size, "the second-opinion member is pinned to the paper")
        assertEquals(a.loads, b.loads)
        assertEquals(a.edges, b.edges)
    }
}
