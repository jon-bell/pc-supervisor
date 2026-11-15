package net.jonbell.pcs.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import net.jonbell.pcs.core.solver.FlowNetwork
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import net.jonbell.pcs.testing.FlowArc
import net.jonbell.pcs.testing.FlowCheck
import net.jonbell.pcs.testing.FlowInstance
import net.jonbell.pcs.testing.FlowInstances
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.Random

/**
 * T2 (PLAN §A5) for `prop:A5`: the solver against HotCRP's own `MinCostMaxFlow`, run by
 * `scripts/mcmf-driver.php` inside the harness container. The instances are random, with lower
 * bounds, with and without negative costs (acyclic, so none has a negative cycle), plus the
 * Lean corpus.
 */
@Family("T2")
@Covers("prop:A5")
class MinCostMaxFlowPhpTest {
    private fun compose(vararg args: String): List<String> =
        listOf(
            "docker",
            "compose",
            "-p",
            System.getenv("HOTCRP_COMPOSE_PROJECT") ?: "pcs",
            "-f",
            Repo.path("hotcrp/compose.yaml").toString(),
        ) + args

    private fun run(
        cmd: List<String>,
        stdin: String? = null,
    ): String {
        Harness.url // refuses to run unless this is the local harness
        val p = ProcessBuilder(cmd).redirectError(ProcessBuilder.Redirect.INHERIT).start()
        val writer =
            Thread {
                p.outputStream.use { o -> stdin?.let { o.write(it.toByteArray()) } }
            }
        writer.start()
        val out = p.inputStream.readAllBytes().decodeToString()
        writer.join()
        check(p.waitFor() == 0) { "${cmd.joinToString(" ")} failed: $out" }
        return out
    }

    /** HotCRP's answer: null when its push-relabel did not finish within the driver's watchdog. */
    private class Php(val infeasible: Boolean, val flow: Long, val cost: Long)

    private fun phpResults(
        instances: List<FlowInstance>,
        patched: Boolean,
    ): List<Php?> {
        run(compose("cp", Repo.path("scripts/mcmf-driver.php").toString(), "hotcrp:/tmp/mcmf-driver.php"))
        val out =
            run(
                compose("exec", "-T", "hotcrp", "php", "/tmp/mcmf-driver.php") +
                    listOfNotNull(
                        "patched".takeIf {
                            patched
                        },
                    ),
                instances.joinToString(",", "[", "]") { it.toJson() },
            )
        return Json.parseToJsonElement(out.trim().lines().last()).jsonArray.map {
            val o = it.jsonObject
            if (o["timeout"]!!.jsonPrimitive.boolean) {
                null
            } else {
                Php(o["infeasible"]!!.jsonPrimitive.boolean, o["flow"]!!.jsonPrimitive.long, o["cost"]!!.jsonPrimitive.long)
            }
        }
    }

    /**
     * Compares every instance HotCRP finishes, and returns (compared, compared with lower bounds, timeouts).
     * HotCRP's push-relabel spins forever on some feasible instances that have lower bounds (see
     * PLAN M14); those are skipped, and it is an error if one without a lower bound times out.
     */
    private fun check(
        instances: List<FlowInstance>,
        patched: Boolean = true,
    ): Triple<Int, Int, Int> {
        val php = phpResults(instances, patched)
        assertEquals(instances.size, php.size)
        var withLower = 0
        var compared = 0
        var timeouts = 0
        instances.zip(php).forEach { (inst, p) ->
            if (p == null) {
                assertTrue(inst.arcs.any { it.lower > 0 }, "HotCRP timed out without lower bounds: ${inst.toJson()}")
                timeouts++
                return@forEach
            }
            compared++
            val net = FlowNetwork(inst.n)
            inst.arcs.forEach { net.addArc(it.from, it.to, it.cap, it.cost, it.lower) }
            val got = net.solve(inst.s, inst.t)
            assertFalse(p.infeasible, "HotCRP calls a feasible-by-construction instance infeasible: ${inst.toJson()}")
            assertEquals(true, got.feasible, inst.toJson())
            assertEquals(p.flow, got.value, "flow value on ${inst.toJson()}")
            assertEquals(p.cost, got.cost, "cost on ${inst.toJson()}")
            assertEquals(emptyList<String>(), FlowCheck.problems(inst, got.flow, got.value, got.cost), inst.toJson())
            if (inst.arcs.any { it.lower > 0 }) withLower++
        }
        println("php: compared $compared, with lower bounds $withLower, HotCRP timeouts $timeouts")
        return Triple(compared, withLower, timeouts)
    }

    @Test
    fun `equals HotCRP on random instances with lower bounds, half with negative costs`() {
        val rnd = Random(1414)
        val instances = List(800) { FlowInstances.random(rnd, signedCosts = it % 2 == 1) }
        val (compared, withLower, _) = check(instances)
        assertTrue(compared >= 400 && withLower >= 100, "compared $compared, with lower bounds $withLower")
    }

    @Test
    fun `equals HotCRP on the Lean corpus`() {
        val lines = java.nio.file.Files.readAllLines(Repo.path("model/export/oracle-mcmf.jsonl"))
        val instances =
            lines.map { line ->
                val q = Json.parseToJsonElement(line).jsonObject["query"]!!.jsonObject
                FlowInstance(
                    q["n"]!!.jsonPrimitive.content.toInt(),
                    q["s"]!!.jsonPrimitive.content.toInt(),
                    q["t"]!!.jsonPrimitive.content.toInt(),
                    q["arcs"]!!.jsonArray.map { a ->
                        a.jsonArray.map { it.jsonPrimitive.long }.let { FlowArc(it[0].toInt(), it[1].toInt(), it[2], it[3], it[4]) }
                    },
                )
            }
        assertTrue(instances.size >= 200)
        val (compared, _, _) = check(instances)
        assertTrue(compared >= 200, "compared $compared")
    }

    /**
     * HotCRP's code as shipped, without the fix in the driver: its flow is never larger than the true
     * maximum, and it is sometimes smaller (the source's distance bug; PLAN M14). Where the two flow
     * values agree, so do the costs, as long as the instance is unchanged by the bug.
     */
    @Test
    fun `unpatched HotCRP never beats the maximum, and sometimes falls short`() {
        val rnd = Random(1415)
        val instances = List(400) { FlowInstances.random(rnd, signedCosts = it % 2 == 1) }
        val php = phpResults(instances, patched = false)
        var short = 0
        var same = 0
        var sameCostDiffers = 0
        instances.zip(php).forEach { (inst, p) ->
            if (p == null) return@forEach
            val net = FlowNetwork(inst.n)
            inst.arcs.forEach { net.addArc(it.from, it.to, it.cap, it.cost, it.lower) }
            val got = net.solve(inst.s, inst.t)
            assertTrue(p.flow <= got.value, "HotCRP found more than the maximum on ${inst.toJson()}")
            if (p.flow < got.value) {
                short++
            } else {
                same++
                if (p.cost != got.cost) sameCostDiffers++
            }
        }
        println("php unpatched: $short of ${short + same} compared fall short of the maximum; of the other $same, $sameCostDiffers differ in cost")
        assertTrue(short + same >= 200)
    }
}
