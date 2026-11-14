package pcs.core.solver

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import pcs.testing.Covers
import pcs.testing.Family
import java.util.Random
import kotlin.time.measureTimedValue

/**
 * The pruned assignment network of spec §10.5 at conference size: 4,000 papers with a senior slot
 * (2 seats) and a third slot (1 seat), 3,300 reviewers in 24 areas, the top 25 candidates per slot
 * from the paper's area and its neighbors, a load band of 6 with convex costs.
 */
@Family("T9")
@Covers("prop:A5")
@Tag("slow")
class MinCostMaxFlowScaleTest {
    @Test
    fun `a 4,000-paper, 3,300-reviewer pruned instance solves in under 30 seconds`() {
        val rnd = Random(4000)
        val papers = 4000
        val reviewers = 3300
        val areas = 24
        val band = 6
        val byArea = List(areas) { a -> (0 until reviewers).filter { it % areas == a } }
        val net = FlowNetwork(2 + reviewers + 2 * papers)
        val source = 0
        val sink = 1
        val reviewer = { r: Int -> 2 + r }
        val slot = { p: Int, third: Int -> 2 + reviewers + 2 * p + third }
        for (r in 0 until reviewers) for (k in 1..band) net.addArc(source, reviewer(r), 1, 10L * k * k)
        var edges = 0
        for (p in 0 until papers) {
            val a = rnd.nextInt(areas)
            val pool = byArea[a] + byArea[(a + 1) % areas] + byArea[(a + areas - 1) % areas]
            for (third in 0..1) {
                val picked = pool.shuffled(rnd).take(25)
                for (r in picked) {
                    net.addArc(reviewer(r), slot(p, third), 1, (100 - rnd.nextInt(101)).toLong() + 100)
                    edges++
                }
                net.addArc(slot(p, third), sink, if (third == 0) 2 else 1, 0)
            }
        }
        val (res, elapsed) = measureTimedValue { net.solve(source, sink) }
        println("scale: ${net.nodes} nodes, ${net.arcs} arcs ($edges candidate edges), flow ${res.value}, cost ${res.cost}, $elapsed")
        assertTrue(res.feasible)
        assertEquals(3L * papers, res.value, "every slot is fillable on this instance")
        assertTrue(elapsed.inWholeSeconds < 30, "took $elapsed")
        val load = LongArray(reviewers)
        var arc = 0
        for (r in 0 until reviewers) for (k in 1..band) load[r] += res.flow[arc++]
        assertTrue(load.all { it <= band })
    }
}
