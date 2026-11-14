package pcs.core.solver

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import pcs.core.LiveOracle
import pcs.core.Repo
import pcs.testing.Covers
import pcs.testing.Family
import pcs.testing.FlowArc
import pcs.testing.FlowCheck
import pcs.testing.FlowInstance
import pcs.testing.FlowInstances
import java.nio.file.Files
import java.util.Random

fun FlowInstance.solve(): FlowResult {
    val net = FlowNetwork(n)
    arcs.forEach { net.addArc(it.from, it.to, it.cap, it.cost, it.lower) }
    return net.solve(s, t)
}

/** T2 (PLAN §A5) for `prop:A5`: the solver against the Lean solver, through its committed corpus. */
@Family("T2")
@Covers("prop:A5")
class MinCostMaxFlowOracleTest {
    @Test
    fun `flow value and cost equal the Lean solver's, and the flows are feasible`() {
        val lines = Files.readAllLines(Repo.path("model/export/oracle-mcmf.jsonl"))
        assertTrue(lines.size >= 200, "corpus has ${lines.size} instances")
        var withLower = 0
        for (line in lines) {
            val o = Json.parseToJsonElement(line).jsonObject
            val q = o["query"]!!.jsonObject
            val want = o["answer"]!!.jsonObject
            val inst =
                FlowInstance(
                    q["n"]!!.jsonPrimitive.content.toInt(),
                    q["s"]!!.jsonPrimitive.content.toInt(),
                    q["t"]!!.jsonPrimitive.content.toInt(),
                    q["arcs"]!!.jsonArray.map { a ->
                        a.jsonArray.map { it.jsonPrimitive.long }.let { FlowArc(it[0].toInt(), it[1].toInt(), it[2], it[3], it[4]) }
                    },
                )
            if (inst.arcs.any { it.lower > 0 }) withLower++
            val got = inst.solve()
            assertEquals(want["feasible"]!!.jsonPrimitive.boolean, got.feasible, line)
            assertEquals(want["flow"]!!.jsonPrimitive.long, got.value, line)
            assertEquals(want["cost"]!!.jsonPrimitive.long, got.cost, line)
            assertEquals(emptyList<String>(), FlowCheck.problems(inst, got.flow, got.value, got.cost), line)
        }
        assertTrue(withLower >= 30, "only $withLower instances have lower bounds")
    }
}

/** The same comparison on fresh random instances, asked of the live Lean oracle when it is built. */
@Family("T2")
@Covers("prop:A5")
class MinCostMaxFlowLiveOracleTest {
    @Test
    fun `equals the live Lean solver on 500 fresh instances`() {
        if (!LiveOracle.available) return
        val rnd = Random(2026)
        repeat(500) {
            val inst = FlowInstances.random(rnd, signedCosts = false) // the Lean solver takes nonnegative costs
            val a = LiveOracle.ask(Json.parseToJsonElement("{\"q\":\"minCostMaxFlow\"," + inst.toJson().drop(1)).jsonObject)
            val got = inst.solve()
            assertEquals(a["feasible"]!!.jsonPrimitive.boolean, got.feasible, inst.toJson())
            assertEquals(a["flow"]!!.jsonPrimitive.long, got.value, inst.toJson())
            assertEquals(a["cost"]!!.jsonPrimitive.long, got.cost, inst.toJson())
        }
    }
}

/** T2 against brute force: every flow on tiny instances, with lower bounds and negative costs. */
@Family("T2")
@Covers("prop:A5")
class MinCostMaxFlowBruteForceTest {
    private fun brute(inst: FlowInstance): Triple<Boolean, Long, Long> {
        val m = inst.arcs.size
        val flow = LongArray(m)
        var best: Pair<Long, Long>? = null

        fun rec(i: Int) {
            if (i == m) {
                val net = LongArray(inst.n)
                var c = 0L
                inst.arcs.forEachIndexed { k, a ->
                    net[a.from] -= flow[k]
                    net[a.to] += flow[k]
                    c += flow[k] * a.cost
                }
                if ((0 until inst.n).any { it != inst.s && it != inst.t && net[it] != 0L }) return
                val v = net[inst.t]
                val b = best
                if (b == null || v > b.first || (v == b.first && c < b.second)) best = v to c
                return
            }
            for (f in inst.arcs[i].lower..inst.arcs[i].cap) {
                flow[i] = f
                rec(i + 1)
            }
        }
        rec(0)
        return best?.let { Triple(true, it.first, it.second) } ?: Triple(false, 0, 0)
    }

    @Test
    fun `agrees with brute force on 1,500 tiny instances`() {
        val rnd = Random(14)
        var feasible = 0
        var lower = 0
        var negative = 0
        repeat(1500) {
            val n = 3 + rnd.nextInt(3)
            val arcs =
                List(1 + rnd.nextInt(6)) {
                    val u = rnd.nextInt(n - 1)
                    var v = 1 + rnd.nextInt(n - 1)
                    if (v == u) v = n - 1
                    val cap = 1L + rnd.nextInt(3)
                    // HotCRP's contract: no lower bound on an arc out of the source
                    val lo = if (u != 0 && rnd.nextInt(3) == 0) rnd.nextLong(cap + 1) else 0L
                    FlowArc(u, v, lo, cap, (rnd.nextInt(13) - 4).toLong())
                }
            val inst = FlowInstance(n, 0, n - 1, arcs)
            val (ok, value, cost) = brute(inst)
            val got = inst.solve()
            assertEquals(ok, got.feasible, inst.toString())
            if (ok) {
                feasible++
                if (arcs.any { it.lower > 0 }) lower++
                if (arcs.any { it.cost < 0 }) negative++
                assertEquals(value, got.value, inst.toString())
                assertEquals(cost, got.cost, inst.toString())
                assertEquals(emptyList<String>(), FlowCheck.problems(inst, got.flow, got.value, got.cost), inst.toString())
            }
        }
        assertTrue(feasible > 400 && lower > 50 && negative > 100, "coverage: feasible $feasible, lower $lower, negative $negative")
    }
}

@Family("T2")
@Covers("prop:A5")
class MinCostMaxFlowCasesTest {
    @Test
    fun `a lower bound that cannot be met is reported as infeasible`() {
        val net = FlowNetwork(4)
        net.addArc(0, 1, 1, 0)
        net.addArc(1, 3, 1, 0)
        net.addArc(2, 3, 5, 0, lower = 2) // node 2 has no supply
        assertFalse(net.solve(0, 3).feasible)
    }

    @Test
    fun `an unreachable sink gives zero flow`() {
        val net = FlowNetwork(3)
        net.addArc(0, 1, 4, 1)
        val r = net.solve(0, 2)
        assertTrue(r.feasible)
        assertEquals(0, r.value)
        assertEquals(0, r.cost)
    }

    @Test
    fun `a lower bound forces flow through a costlier path`() {
        val net = FlowNetwork(4)
        net.addArc(0, 1, 1, 1)
        net.addArc(1, 3, 1, 1)
        net.addArc(0, 2, 1, 5)
        net.addArc(2, 3, 1, 5, lower = 1)
        val r = net.solve(0, 3)
        assertEquals(2, r.value)
        assertEquals(12, r.cost)
    }

    @Test
    fun `random instances from the shared generator are solved feasibly`() {
        val rnd = Random(7)
        repeat(300) { k ->
            val inst = FlowInstances.random(rnd, signedCosts = k % 2 == 0)
            val r = inst.solve()
            assertTrue(r.feasible, inst.toJson())
            assertEquals(emptyList<String>(), FlowCheck.problems(inst, r.flow, r.value, r.cost), inst.toJson())
        }
    }
}
