package pcs.runner

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import pcs.testing.CoversLog
import pcs.testing.Family

/**
 * The desk-reject subsystem's exported traces (witnesses, refusals, denials), executed through the
 * bindings against the harness (PLAN M3a). The model's expected outcome and observations come from
 * the export; the records go to build/evidence for `lake exe check-evidence`.
 */
@Order(1)
@Family("T5")
class RunnerTest {
    @Test
    fun `the desk-reject witness traces run against the harness and agree with the model`() {
        val specs = Session.traces()
        assertTrue(specs.size >= 30, "expected the desk-reject traces, found ${specs.size}")
        val runner = Session.runner
        val pids = runner.createPapers(specs.size)
        val failures = mutableListOf<String>()
        var executed = 0
        for ((spec, pid) in specs.zip(pids)) {
            val res = runner.run(spec, pid)
            check(res.skipped == null) { "${spec.id}: ${res.skipped}" }
            executed++
            runner.write("traces/" + spec.id.replace('/', '_') + ".json", res.record)
            val outcome = if (res.mismatches.isEmpty()) "pass" else "fail"
            spec.claims.forEach { CoversLog.record(spec.id, it, outcome, spec.family) }
            res.mismatches.forEach { failures += "${spec.id}: $it" }
        }
        assertEquals(specs.size, executed)
        assertEquals(emptyList<String>(), failures)
        assertEquals(emptyList<String>(), runner.allViolations(), "the boundary observer saw something it must not")
    }
}
