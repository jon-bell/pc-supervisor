package pcs.runner

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import pcs.testing.Covers
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

    @Test
    @Covers("prop:E-1", "prop:L2", "card:R1", "card:R2", "card:R3", "card:R4")
    fun `the early-reject witness traces run against the harness and agree with the model`() {
        val all = Session.earlyTraces()
        assertTrue(all.size >= 30, "expected the early-reject traces, found ${all.size}")
        // PCS_TRACE_ONLY=<substring of a trace id> runs just those traces while developing a binding
        val specs = System.getenv("PCS_TRACE_ONLY")?.let { only -> all.filter { only in it.id } } ?: all
        val runner = Session.runner
        val pids = runner.createPapers(specs.size)
        val failures = mutableListOf<String>()
        for ((spec, pid) in specs.zip(pids)) {
            val res = runner.run(spec, pid)
            check(res.skipped == null) { "${spec.id}: ${res.skipped}" }
            runner.write("traces/" + spec.id.replace('/', '_') + ".json", res.record)
            val outcome = if (res.mismatches.isEmpty()) "pass" else "fail"
            spec.claims.forEach { CoversLog.record(spec.id, it, outcome, spec.family) }
            res.mismatches.forEach { failures += "${spec.id}: $it" }
        }
        assertEquals(emptyList<String>(), failures)
        assertEquals(emptyList<String>(), runner.allViolations(), "the boundary observer saw something it must not")
    }

    @Test
    @Covers("prop:L2", "prop:V1", "prop:H1", "prop:H2", "rule:eligible", "cell:pc-member/classify", "cell:pc-member/apply-writeback")
    fun `the appointment and assignment traces run against the harness and agree with the model`() {
        val all = Session.apptTraces()
        assertTrue(all.size >= 12, "expected the appointment traces, found ${all.size}")
        val specs = System.getenv("PCS_TRACE_ONLY")?.let { only -> all.filter { only in it.id } } ?: all
        val runner = Session.runner
        val pids = runner.createPapers(specs.size)
        val failures = mutableListOf<String>()
        for ((spec, pid) in specs.zip(pids)) {
            val res = runner.run(spec, pid)
            check(res.skipped == null) { "${spec.id}: ${res.skipped}" }
            runner.write("traces/" + spec.id.replace('/', '_') + ".json", res.record)
            val outcome = if (res.mismatches.isEmpty()) "pass" else "fail"
            spec.claims.forEach { CoversLog.record(spec.id, it, outcome, spec.family) }
            res.mismatches.forEach { failures += "${spec.id}: $it" }
        }
        assertEquals(emptyList<String>(), failures)
        assertEquals(emptyList<String>(), runner.allViolations(), "the boundary observer saw something it must not")
    }

    @Test
    @Covers("prop:AR1", "prop:AR2", "prop:AR4", "prop:AR5", "prop:AR6", "prop:V4", "card:C1", "card:C2", "card:C3", "card:C4", "card:C5")
    fun `the accountability witness traces run against the harness and agree with the model`() {
        val all = Session.accTraces()
        assertTrue(all.size >= 50, "expected the accountability traces, found ${all.size}")
        val specs = System.getenv("PCS_TRACE_ONLY")?.let { only -> all.filter { only in it.id } } ?: all
        val runner = Session.runner
        val pids = runner.createPapers(specs.size)
        val failures = mutableListOf<String>()
        for ((spec, pid) in specs.zip(pids)) {
            val res = runner.run(spec, pid)
            check(res.skipped == null) { "${spec.id}: ${res.skipped}" }
            runner.write("traces/" + spec.id.replace('/', '_') + ".json", res.record)
            val outcome = if (res.mismatches.isEmpty()) "pass" else "fail"
            spec.claims.forEach { CoversLog.record(spec.id, it, outcome, spec.family) }
            res.mismatches.forEach { failures += "${spec.id}: $it" }
        }
        assertEquals(emptyList<String>(), failures)
        assertEquals(emptyList<String>(), runner.allViolations(), "the boundary observer saw something it must not")
    }
}
