package pcs.core

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.TestMethodOrder
import pcs.core.assignment.Assignment
import pcs.core.assignment.AssignmentBuild
import pcs.core.assignment.AssignmentData
import pcs.core.assignment.AssignmentInput
import pcs.core.assignment.AssignmentSettings
import pcs.core.assignment.Cycles
import pcs.core.assignment.Planner
import pcs.core.assignment.Slot
import pcs.core.imports.ImportKind
import pcs.core.imports.ImportResult
import pcs.core.imports.Imports
import pcs.core.readings.Answers
import pcs.core.readings.Readings
import pcs.core.rules.Faults
import pcs.core.store.Store
import pcs.core.store.Sync
import pcs.core.time.Clock
import pcs.core.writeback.AssignmentArtifact
import pcs.core.writeback.Writeback
import pcs.core.writeback.WritebackStatus
import pcs.seed.AssignScenario
import pcs.seed.Driver
import pcs.testing.Covers
import pcs.testing.Family
import java.nio.file.Files
import java.time.Instant

/**
 * PLAN M15 end to end (spec §10.4 C, §10.5): the `assignment` scenario seeded into the harness, synced and imported, planned, and the
 * bulk-assign CSV put through Writeback's dry run, confirmation and application. It runs last, adds papers 201 to 212 and PC members,
 * and removes them again.
 */
@Order(Int.MAX_VALUE - 1)
@Family("T10")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class AssignmentTest {
    private val store = Store.open(Files.createTempFile("pcs-asg", ".db").also { Files.delete(it) }, "test-only-key")
    private var t = Instant.parse("2030-02-26T17:00:00Z")
    private val clock = Clock { t }
    private val token = System.getenv("PCS_HOTCRP_TOKEN")!!
    private val imports = Imports(store, clock)
    private val project = System.getenv("HOTCRP_COMPOSE_PROJECT") ?: "pcs"
    private val settings = AssignmentSettings(loadMax = mapOf("senior" to 4, "junior" to 3))
    private val wb get() = Writeback(store, clock, Harness.url, token)

    private fun sync() {
        t = t.plusSeconds(60)
        runBlocking { Harness.client().use { Sync(store, clock).run(it) } }
    }

    private val answers: Readings =
        Answers.parse("Q8=up-to-n\nQ13=one-junior\nQ14=tier-decides\nQ18=once\nQ19=equal\nQ19b=others-absorb").readings

    private fun build(r: Readings = answers, faults: Faults = Faults.NONE): AssignmentBuild =
        (AssignmentData(store, imports).build(r, settings, faults) as AssignmentInput.Ready).build

    private fun email(local: String) = "$local@example.org"

    @BeforeAll
    fun seedAndImport() {
        Driver(Harness.url, token, Repo.root, project).seed(AssignScenario.scenario)
        sync()
        for (
        (kind, csv) in
        listOf(
            ImportKind.APPOINTMENTS to AssignScenario.appointmentsCsv,
            ImportKind.TPMS_REGISTRATIONS to AssignScenario.registrationsCsv,
            ImportKind.TPMS_SCORES to AssignScenario.scoresCsv,
            ImportKind.TPMS_ASSIGNMENTS to AssignScenario.tpmsAssignmentCsv,
        )
        ) {
            val r = imports.import(kind, csv.toByteArray(), "assignment-${kind.id}.csv")
            assertTrue(r is ImportResult.Accepted, (r as? ImportResult.Rejected)?.run?.toString())
        }
    }

    @AfterAll
    fun cleanUp() {
        store.close()
        Hotcrp.php("batch/deletepapers.php", "-y", "-q", "201-212")
        val sql = "delete from ContactInfo where email like 'asg-%@example.org';\n"
        val cmd =
            listOf(
                "docker",
                "compose",
                "-p",
                project,
                "-f",
                Repo.path("hotcrp/compose.yaml").toString(),
                "exec",
                "-T",
                "db",
                "mariadb",
                "-uroot",
                "-proot",
                "hotcrp",
            )
        val p = ProcessBuilder(cmd).redirectErrorStream(true).start()
        p.outputStream.use { it.write(sql.toByteArray()) }
        val out = p.inputStream.bufferedReader().readText()
        check(p.waitFor() == 0) { out }
        assertEquals(0, Hotcrp.pcEmails().count { it.startsWith("asg-") }, "the scenario's PC members are gone")
    }

    private fun id(b: AssignmentBuild, local: String) = b.emailOf.entries.first { it.value == email(local) }.key

    @Test
    @Order(1)
    @Covers(
        "rule:composition",
        "rule:load",
        "rule:cycle-free",
        "prop:A1",
        "prop:A2",
        "prop:A3",
        "prop:A4",
        "prop:V1",
        "prop:V5",
        "prop:M3",
        "q:Q13=one-junior",
        "q:Q14=tier-decides",
    )
    fun `on the assignment scenario every paper is composed or reported, no band is exceeded, no ineligible edge appears and cycles are broken`() {
        val b = build()
        val report = Assignment.report(b)
        val plan = report.plan
        assertEquals(emptyList<String>(), report.audit, report.render())
        // composition: every paper but #210, whose seniors are all in conflict
        val notComposed = plan.papers.filter { !it.composed }.map { it.pid }
        assertEquals(listOf(210L), notComposed, report.render())
        val s = plan.shortfalls.single { it.pid == 210L && it.slot == Slot.SENIOR }
        assertEquals(1, s.needed - s.filled, "the senior nominee fills one of the two senior seats: tier alone decides")
        assertTrue("7 conflicted" in s.reason, s.reason)
        // bands: the overloaded senior has two existing reviews and is held to four
        assertEquals(0, plan.bandViolations.size)
        val s7 = id(b, "asg-s7")
        assertEquals(4, plan.loads[s7])
        assertEquals(2, plan.edges.count { it.who == s7 })
        // eligibility: nobody unaccepted, no author, no conflict
        val n3 = id(b, "asg-n3")
        assertTrue(plan.edges.none { it.who == n3 }, "the unaccepted nominee is never assigned, though they are the best match for every paper but their own")
        assertTrue(plan.edges.none { e -> b.input.papers.first { it.pid == e.pid }.let { e.who in it.authors || e.who in it.conflicts } })
        // the cycles: present in the first solve, gone at the end
        assertTrue(plan.cyclesFirst >= 2, "the 2-cycle and the 3-cycle are in the first solve (${plan.cyclesFirst})")
        assertEquals(0, plan.cyclesLeft.size)
        assertTrue(plan.repairs.any { "2 papers" in it.reason } && plan.repairs.any { "3 papers" in it.reason }, plan.repairs.toString())
        // nominees: within a review of what they owe, or the report says why (V5)
        assertTrue(plan.nominees.all { it.withinOne || it.reason != null })
        assertEquals(setOf(id(b, "asg-n1"), id(b, "asg-n2")), plan.nominees.map { it.who }.toSet(), "only accepted nominees have an obligation")
        // the conflict-engineering monitor reports #210 to the chairs, and the plan doesn't treat it as a ground
        assertEquals(listOf(210L), report.signals.map { it.pid })
        assertTrue(report.signals.single().share >= 0.5, "more than half of the qualified reviewers are in conflict: ${report.signals.single()}")
        assertTrue(report.signals.single().excluded >= 3)
        assertTrue("Conflict engineering" in report.render() && "never a ground" in report.render())
        // the model's two-junior and nominee readings change nothing here, but Q14 does: a senior nominee stops counting as a senior
        val notSenior = Planner.solve(b.input, b.config.copy(q14 = pcs.core.readings.Q14.NOMINEE_NOT_SENIOR))
        assertTrue(notSenior.seniorShort > plan.seniorShort, "under Q14 'nominee not senior' the senior nominee's seat is lost")
    }

    @Test
    @Order(2)
    @Covers("mutant:2", "mutant:9", "prop:V1", "prop:A3")
    fun `the scenario catches the assign-unaccepted and cycle K = 1 mutants`() {
        val b = build()
        val n3 = id(b, "asg-n3")
        // the unaccepted nominee is the best match on every paper but their own: the mutant plans them, and the audit says V1 is broken
        val bad = Planner.solve(b.input, b.config.copy(faults = Faults(assignUnaccepted = true)))
        assertTrue(bad.edges.any { it.who == n3 }, "the mutant assigns the unaccepted nominee")
        assertTrue(Planner.audit(b.input, b.config, bad).any { it.startsWith("V1") })
        // the K = 1 mutant checks nothing, so the reciprocal 2-cycle survives, which an independent check finds
        val k1 = Planner.solve(b.input, b.config.copy(faults = Faults(cycleK1 = true)))
        val left = Cycles.find(k1.edges, b.input.papers, b.input.pinned, 2)
        assertTrue(left.any { it.papers.toSet() == setOf(201L, 202L) }, "#201 and #202 still review each other")
        assertTrue(Planner.audit(b.input, b.config, k1).any { it.startsWith("A3") })
        assertEquals(0, Planner.solve(b.input, b.config).let { Cycles.find(it.edges, b.input.papers, b.input.pinned, 3) }.size)
    }

    @Test
    @Order(4)
    @Covers("prop:A1", "prop:A2", "prop:A3", "prop:A4", "prop:V1", "assume:A3")
    fun `a TPMS assignment is validated before it reaches HotCRP and corrected`() {
        val b = build()
        val report = Assignment.report(b)
        val t = report.tpms ?: error("no TPMS validation")
        val problems = t.issues.map { b.email(it.who) to it.pid }
        val issue = { who: String, pid: Long -> t.issues.firstOrNull { b.email(it.who) == email(who) && it.pid == pid }?.problem }
        assertTrue("author" in issue("asg-s1", 201).orEmpty(), problems.toString())
        assertTrue("conflict" in issue("asg-s1", 210).orEmpty(), problems.toString())
        assertTrue("accepted" in issue("asg-n3", 207).orEmpty(), problems.toString())
        assertTrue(t.issues.any { "cycle" in it.problem }, problems.toString())
        assertTrue(t.issues.any { "load band" in it.problem && b.email(it.who) == email("asg-s7") }, problems.toString())
        assertTrue(t.compositionGaps.any { it.first == 211L }, "#211 has three juniors: ${t.compositionGaps}")
        // the corrected plan fixes #211 and keeps what is valid
        val fixed = t.corrected.papers.first { it.pid == 211L }
        assertTrue(fixed.composed && fixed.seniors.size == 2, fixed.toString())
        assertTrue(t.kept.isNotEmpty())
        assertEquals(emptyList<String>(), Planner.audit(b.input, b.config, t.corrected))
    }

    @Test
    @Order(5)
    @Covers("prop:H1", "prop:H2", "prop:L2", "assume:A3")
    fun `the bulk-assign CSV passes its dry run, a confirmed run assigns the reviewers, and the next sync observes them`() {
        val b = build()
        val csv = Assignment.report(b).csv
        assertTrue(csv.rows.isNotEmpty() && csv.awaitingMembership.isEmpty())
        assertTrue(csv.toCsv().startsWith("paper,action,email\n"))
        val art = AssignmentArtifact.fromCsv(csv.toCsv(), "Assignment plan").getOrThrow()
        assertEquals(csv.rows.size, art.rows.size)
        val id = wb.draft(art)
        val before = Hotcrp.reviews(201).size
        val dr = wb.dryRun(id)
        assertTrue(dr.valid, dr.messages.toString())
        assertEquals(before, Hotcrp.reviews(201).size, "the dry run changes nothing")
        wb.confirm(id)
        val r = wb.apply(id)
        assertEquals(WritebackStatus.APPLIED, r.status)
        sync()
        assertEquals(WritebackStatus.OBSERVED, wb.get(id).status, wb.get(id).mismatch)
        // now they are existing reviews: a second plan has nothing left to add, and nobody is over a band
        val again = Assignment.report(build())
        assertEquals(emptyList<pcs.core.assignment.Candidate>(), again.plan.edges.filter { e -> e.pid != 210L })
        assertEquals(0, again.plan.bandViolations.size)
        assertFalse(again.plan.papers.filter { it.pid != 210L }.any { !it.composed })
    }
}
