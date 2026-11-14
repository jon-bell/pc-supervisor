package pcs.core

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.TestMethodOrder
import pcs.core.imports.ImportKind
import pcs.core.imports.ImportResult
import pcs.core.imports.Imports
import pcs.core.nominations.Appointments
import pcs.core.nominations.CapCase
import pcs.core.nominations.NominationData
import pcs.core.nominations.NominationReport
import pcs.core.nominations.PaperCheck
import pcs.core.nominations.Resolved
import pcs.core.readings.Answers
import pcs.core.rules.Compliance
import pcs.core.rules.Faults
import pcs.core.rules.Tier
import pcs.core.store.Store
import pcs.core.store.Sync
import pcs.core.time.Clock
import pcs.core.writeback.TagArtifact
import pcs.core.writeback.TagChange
import pcs.core.writeback.UserArtifact
import pcs.core.writeback.Writeback
import pcs.core.writeback.WritebackStatus
import pcs.seed.Driver
import pcs.seed.Nomination
import pcs.testing.Covers
import pcs.testing.Family
import java.nio.file.Files
import java.time.Instant

/**
 * PLAN M7 end to end (spec §10.4 A): the `nomination` scenario seeded into the harness (papers and authors in
 * HotCRP, nominations in the appointments sheet), synced and imported, and reported. It runs last, adds papers
 * 101 to 117 and PC members, and removes them again, so the golden-based tests never see them.
 */
@Order(Int.MAX_VALUE)
@Family("T10")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class NominationTest {
    private val store = Store.open(Files.createTempFile("pcs-nom", ".db").also { Files.delete(it) }, "test-only-key")
    private var t = Instant.parse("2030-02-26T17:00:00Z")
    private val clock = Clock { t }
    private val token = System.getenv("PCS_HOTCRP_TOKEN")!!
    private val imports = Imports(store, clock)
    private val data = NominationData(store, imports)
    private val wb get() = Writeback(store, clock, Harness.url, token)
    private val project = System.getenv("HOTCRP_COMPOSE_PROJECT") ?: "pcs"

    private fun sync() {
        t = t.plusSeconds(60)
        runBlocking { Harness.client().use { Sync(store, clock).run(it) } }
    }

    private fun e(local: String) = "$local@example.org"

    @BeforeAll
    fun seedAndImport() {
        Driver(Harness.url, token, Repo.root, project).seed(Nomination.scenario)
        sync()
        for ((kind, csv) in listOf(ImportKind.APPOINTMENTS to Nomination.appointmentsCsv, ImportKind.TPMS_REGISTRATIONS to Nomination.registrationsCsv)) {
            val r = imports.import(kind, csv.toByteArray(), "nomination-${kind.id}.csv")
            assertTrue(r is ImportResult.Accepted, (r as? ImportResult.Rejected)?.errors.toString())
        }
    }

    @AfterAll
    fun cleanUp() {
        store.close()
        // the scenario's papers, and every contact it made, so nothing else sees them
        Hotcrp.php("batch/deletepapers.php", "-y", "-q", "101-117")
        val sql = "delete from ContactInfo where email like 'nom-%@example.org';\n"
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
        assertEquals(0, Hotcrp.pcEmails().count { it.startsWith("nom-") }, "the scenario's PC members are gone")
        assertNull(Hotcrp.api("GET", "papers", mapOf("q" to "101-117"))["papers"]?.let { (it as kotlinx.serialization.json.JsonArray).firstOrNull() })
    }

    private fun answered(
        q8: String = "up-to-n",
        q10: String = "warn-then-reject",
        q17: String = "9",
        q18: String = "once",
        q19: String = "equal",
        q19b: String = "others-absorb",
    ) =
        Answers.parse("Q8=$q8\nQ10=$q10\nQ17=$q17\nQ18=$q18\nQ19=$q19\nQ19b=$q19b").readings

    private fun report(r: pcs.core.readings.Readings = answered()): NominationReport = data.report(r)

    private fun NominationReport.paper(pid: Long): PaperCheck = papers.first { it.pid == pid }

    private fun NominationReport.owes(who: String) = obligations.first { it.email == e(who) }.owes

    @Test
    @Order(1)
    @Covers("card:X1", "rule:compliance", "q:Q8=one", "q:Q8=up-to-n", "q:Q8=at-least-one", "q:Q10=desk-reject", "q:Q10=warn-then-reject", "q:Q10=warn-only")
    fun `a paper with no nominee is reported, a paper with an unregistered one too, and Q10 says what each may lead to`() {
        val r = report()
        assertEquals(Compliance.MISSING_NOMINEE, r.paper(104).compliance.decided)
        assertEquals(Compliance.OK, r.paper(101).compliance.decided)
        assertEquals(Compliance.OK, r.paper(105).compliance.decided)
        assertEquals(Compliance.UNREGISTERED, r.paper(106).compliance.decided, "its only nominee is not registered with the matching system")
        assertEquals(Compliance.UNREGISTERED, r.paper(112).compliance.decided)
        assertEquals(listOf(104L, 106L, 112L), r.noncompliant.map { it.pid })
        // Q10 on paper 104: before any warning, then after the chair's warning is written and synced
        for ((q10, expected) in mapOf("desk-reject" to true, "warn-then-reject" to false, "warn-only" to false)) {
            assertEquals(Resolved.Decided(expected), report(answered(q10 = q10)).paper(104).referable, q10)
        }
        val warn = wb.draft(TagArtifact(listOf(TagChange(104, add = listOf("pcs-warned")))))
        wb.dryRun(warn)
        wb.confirm(warn)
        wb.apply(warn)
        sync()
        assertEquals(WritebackStatus.OBSERVED, wb.get(warn).status, wb.get(warn).mismatch)
        for ((q10, expected) in mapOf("desk-reject" to true, "warn-then-reject" to true, "warn-only" to false)) {
            val p = report(answered(q10 = q10)).paper(104)
            assertTrue(p.warned)
            assertEquals(Resolved.Decided(expected), p.referable, "$q10 after the warning")
        }
        assertEquals(Compliance.TOO_MANY_NOMINEES, report(answered(q8 = "one")).paper(105).compliance.decided, "two nominees where Q8 allows one")
        assertEquals(Compliance.OK, report(answered(q8 = "at-least-one")).paper(105).compliance.decided)
    }

    @Test
    @Order(2)
    @Covers("card:X2", "rule:owes", "q:Q18=once", "q:Q18=per-paper", "q:Q18=share-weighted", "q:Q18=capped-at-band", "assume:A4")
    fun `a person nominated by three papers owes once as a person, under every reading of Q18`() {
        val expected = mapOf("once" to 18, "per-paper" to 54, "share-weighted" to 54, "capped-at-band" to 48)
        for ((q18, sixths) in expected) {
            val r = report(answered(q18 = q18))
            assertEquals(Resolved.Decided<Int?>(sixths), r.owes("nom-nina"), q18)
            assertEquals(listOf(101L, 102L, 103L), r.obligations.first { it.email == e("nom-nina") }.papers)
        }
        assertEquals(1, report().obligations.count { it.email == e("nom-nina") })
        assertEquals(Tier.JUNIOR, report().obligations.first { it.email == e("nom-nina") }.tier)
    }

    @Test
    @Order(3)
    @Covers("card:X9", "card:X8", "prop:V2", "q:Q19=equal", "q:Q19=authors-allocate", "q:Q19=solver", "q:Q19b=others-absorb", "q:Q19b=paper-short")
    fun `a declined co-nominee's share is absorbed by the other nominee or the paper is short, never moved to an unnamed person`() {
        val absorb = report(answered(q18 = "share-weighted", q19b = "others-absorb"))
        assertEquals(Resolved.Decided<Int?>(18), absorb.owes("nom-eli"))
        assertEquals(Resolved.Decided(0), absorb.paper(105).shortfall)
        val short = report(answered(q18 = "share-weighted", q19b = "paper-short"))
        assertEquals(Resolved.Decided<Int?>(9), short.owes("nom-eli"))
        assertEquals(Resolved.Decided(9), short.paper(105).shortfall, "the paper is short by a review and a half")
        assertEquals(Resolved.Decided<Int?>(0), short.owes("nom-fay"))
        assertTrue(short.paper(105).nominees.single { it.email == e("nom-fay") }.decision.key == "decline")
        // the solver pools the paper's obligation
        val solver = report(answered(q18 = "share-weighted", q19 = "solver"))
        assertEquals(Resolved.Decided<Int?>(null), solver.owes("nom-eli"))
        // people with an obligation are people the authors named, and nobody else
        val named = Nomination.papers.flatMap { it.authors }.toSet()
        assertTrue(absorb.obligations.all { it.email in named })
        // pending: owes nothing yet, and the figure is marked provisional
        assertEquals(Resolved.Decided<Int?>(0), absorb.owes("nom-hana"))
        assertTrue(absorb.obligations.first { it.email == e("nom-hana") }.provisional)
    }

    @Test
    @Order(3)
    @Covers("mutant:3", "mutant:4")
    fun `the scenario catches the Q18 and declined-share mutants`() {
        // "combine ignores Q18": under per-paper the report would say 18, not 54
        val perPaper = answered(q18 = "per-paper")
        assertEquals(Resolved.Decided<Int?>(54), report(perPaper).owes("nom-nina"))
        assertNotEquals(report(perPaper).owes("nom-nina"), data.report(perPaper, Faults(combineIgnoresQ18 = true)).owes("nom-nina"))
        // "a declined share goes to someone unnamed": the nominee who stays would not absorb it
        val absorb = answered(q18 = "share-weighted", q19b = "others-absorb")
        assertEquals(Resolved.Decided<Int?>(18), report(absorb).owes("nom-eli"))
        assertNotEquals(report(absorb).owes("nom-eli"), data.report(absorb, Faults(declinedShareToUnnamed = true)).owes("nom-eli"))
    }

    @Test
    @Order(4)
    @Covers("card:X7", "prop:M4", "q:Q17=none", "q:Q17=9")
    fun `an author over the cap is reported with the papers, and nothing is withdrawn`() {
        val papers = (107L..117L).toList()
        assertEquals(Resolved.Decided(listOf(CapCase(Nomination.prolific, papers, 2))), report(answered(q17 = "9")).capCases)
        assertEquals(Resolved.Decided(emptyList<CapCase>()), report(answered(q17 = "none")).capCases)
        val open = report(Answers.parse("Q8=up-to-n").readings).capCases
        assertTrue(open is Resolved.Open, "Q17 unanswered: reported under each reading, not defaulted")
        // nothing was withdrawn: all 17 papers are still in HotCRP
        val live =
            store.conn.createStatement().use { st ->
                st.executeQuery("SELECT count(*) FROM paper WHERE pid >= 101 AND gone_at IS NULL").use { rs ->
                    rs.next()
                    rs.getInt(1)
                }
            }
        assertEquals(17, live)
    }

    @Test
    @Order(5)
    @Covers("card:X3", "prop:V3", "prop:M4", "rule:compliance")
    fun `a senior who always nominates a junior is shown as a pattern with no consequence`() {
        val r = report()
        val p = r.patterns.single()
        assertEquals(Nomination.prolific, p.author, "a PC member with no sheet row is senior")
        assertEquals((107L..117L).toList(), p.papers)
        assertEquals("no consequence by itself", p.consequence)
        // no ground: those papers stay compliant (112 only for its unregistered nominee) and none is referable on the pattern
        assertTrue(r.papers.filter { it.pid in 107..117 && it.pid != 112L }.all { it.compliance.decided == Compliance.OK && it.referable == null })
    }

    @Test
    @Order(6)
    @Covers("prop:L2", "prop:V1", "rule:eligible", "assume:A4")
    fun `an accepted, classified, consenting candidate gets a membership artifact that passes its dry run, and the chair's command adds them`() {
        val tierTags = mapOf("junior" to "junior", "nominee" to "nominee")
        val plan = Appointments.plan(data.input(), tierTags)
        val drafted = plan.drafts.map { it.email.substringBefore('@') }
        assertEquals((listOf("nom-eli", "nom-nina") + listOf(1, 4, 5, 6, 7, 8, 9, 10).map { "nom-stu$it" }).sorted(), drafted.sorted())
        assertEquals(
            mapOf(
                "nom-fay" to "declined",
                "nom-hana" to "the AC has not decided (or the decision isn't an AC's)",
                "nom-stu2" to "consent not recorded",
                "nom-stu3" to "declined",
                "nom-stu11" to "the AC has not decided (or the decision isn't an AC's)",
            ),
            plan.skipped.associate { it.first.substringBefore('@') to it.second },
        )
        assertTrue(report().anomalies.any { it.subject == e("nom-stu11") && "never acted on" in it.message }, "the decision by a non-AC is reported")
        assertTrue(plan.drafts.all { it.roles == "pc" && it.tags == listOf("junior", "nominee") })

        val id = Appointments.draft(wb, plan) ?: error("nothing was drafted")
        assertNull(Appointments.draft(wb, plan), "a second pass drafts nothing: the first is still waiting")
        val dr = wb.dryRun(id)
        assertTrue(dr.valid, dr.messages.toString())
        assertEquals(plan.drafts.size, dr.lines.size)
        assertTrue(dr.lines.all { "not on the PC" in it }, "the preview shows each candidate as not yet on the PC")
        assertFalse(Hotcrp.pcEmails().any { it.startsWith("nom-nina") })
        wb.confirm(id)
        assertEquals(WritebackStatus.HANDED_OFF, wb.apply(id).status)
        assertFalse(Hotcrp.pcEmails().any { it.startsWith("nom-nina") }, "PC Supervisor writes no users; the chair runs the command")
        wb.handOffCommands(id).forEach { cmd -> Hotcrp.php("batch/saveusers.php", "-e", cmd.removePrefix("php batch/saveusers.php -e '").removeSuffix("'")) }
        sync()
        assertEquals(WritebackStatus.OBSERVED, wb.get(id).status, wb.get(id).mismatch)
        val onPc = Hotcrp.pcEmails()
        plan.drafts.forEach { assertTrue(it.email in onPc, "${it.email} is on the PC") }
        // the sheet is untouched, and once they are on the PC nothing more is drafted
        assertEquals(10, plan.drafts.size)
        assertEquals(emptyList<Any>(), Appointments.plan(data.input(), tierTags).drafts)
        assertNull(Appointments.draft(wb, Appointments.plan(data.input(), tierTags)))
        assertTrue(wb.list().none { it.artifact is UserArtifact && it.status == WritebackStatus.MISMATCH })
    }
}
