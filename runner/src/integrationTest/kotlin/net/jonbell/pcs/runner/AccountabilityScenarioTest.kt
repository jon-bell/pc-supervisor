package net.jonbell.pcs.runner

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.core.accountability.AccConfig
import net.jonbell.pcs.core.accountability.AccDrafts
import net.jonbell.pcs.core.accountability.AccLoader
import net.jonbell.pcs.core.accountability.AccLocal
import net.jonbell.pcs.core.accountability.AccountabilityPlan
import net.jonbell.pcs.core.accountability.AccountabilityReport
import net.jonbell.pcs.core.accountability.CaseStatus
import net.jonbell.pcs.core.accountability.Criterion
import net.jonbell.pcs.core.accountability.ReqStatus
import net.jonbell.pcs.core.accountability.SignalConfig
import net.jonbell.pcs.core.accountability.SuggestionStatus
import net.jonbell.pcs.core.accountability.Tiers
import net.jonbell.pcs.core.hotcrp.HotcrpClient
import net.jonbell.pcs.core.imports.ImportKind
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.nominations.NominationData
import net.jonbell.pcs.core.readings.QId
import net.jonbell.pcs.core.readings.Readings
import net.jonbell.pcs.core.rules.Conventions
import net.jonbell.pcs.core.rules.ReqDisposition
import net.jonbell.pcs.core.rules.Trace
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.Sync
import net.jonbell.pcs.core.time.Clock
import net.jonbell.pcs.core.writeback.Artifact
import net.jonbell.pcs.core.writeback.Writeback
import net.jonbell.pcs.seed.AccountabilityScenario
import net.jonbell.pcs.seed.At
import net.jonbell.pcs.seed.Driver
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import java.nio.file.Files
import java.time.Duration
import java.time.Instant

/**
 * Runs before the scenario runner's JVM-wide proxy is in place (the seeder talks to the harness directly).
 *
 * PLAN M16's multi-stage scenario: the harness is seeded with `accountability` (papers 301-303), and the clock then moves through
 * the life of three requests while PC Supervisor drafts and a chair records through Writeback: sent, answered by a revision,
 * recorded as revised; reminded after the due date; "no reply" refused until the due date, the reminder and the grace period have
 * all passed. A dismissed suggestion leaves nothing in HotCRP or on the engagement record (AR4), and at every stage the engagement
 * record is checked against the dispositions HotCRP holds, read as a chair through the API.
 */
@Order(0)
@Family("T11")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class AccountabilityScenarioTest {
    private val repo = Session.repo
    private val driver by lazy { Driver(Session.harness, Session.token, repo, System.getenv("HOTCRP_COMPOSE_PROJECT") ?: "pcs") }
    private val api by lazy { HotcrpApi(Session.harness, Session.token) }
    private val store: Store = Store.open(Files.createTempFile("pcs-acc-scenario", ".db").also { Files.delete(it) }, "test-only-key")
    private var now: Instant = Instant.EPOCH
    private val clock = Clock { now }
    private lateinit var due: Instant
    private val readings = Readings().base().with(QId.Q20, "yes")!!.with(QId.Q11, "reject-own-papers")!!
    private val criteria =
        listOf(
            Criterion(1, "backs each weakness with evidence", setOf("thin")),
            Criterion(2, "tells the authors what would change the reviewer's mind", setOf("thin", "rated")),
        )

    private fun at(hours: Long) = due.plus(Duration.ofHours(hours))

    private fun sync() = runBlocking { HotcrpClient(Session.harness, Session.token, chunk = 50, strict = true).use { Sync(store, clock).run(it) } }

    private fun report(): AccountabilityReport {
        val data = NominationData(store, Imports(store, clock))
        val input = data.input()
        val tiers = Tiers.build(input.sheet, emptyMap(), mapOf("junior" to "junior", "nominee" to "nominee"))
        val acc = AccLoader.load(store, now, tiers, "OveMer")
        val mine = acc.copy(reviews = acc.reviews.filter { it.pid in 301..303 }, paperTags = acc.paperTags.filterKeys { it in 301..303 })
        return AccountabilityPlan.compute(mine, AccConfig(criteria, 48, SignalConfig(reviewDue = due)), readings, data.report(readings).obligations)
    }

    /** What a chair records: the artifact goes through Writeback's dry run and confirmation, then the next sync must show it. */
    private fun record(a: Artifact) {
        val wb = Writeback(store, clock, Session.harness, Session.token)
        val id = wb.draft(a)
        wb.dryRun(id)
        wb.confirm(id)
        wb.apply(id)
    }

    private fun chairTags(pid: Long): List<String> = api.call("GET", "$pid/tags")["tags"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()

    /** The engagement record HotCRP's own tags give: the dispositions of the requests on 301-303, by reviewer. */
    private fun fromHotcrp(): Map<String, Pair<Int, Int>> {
        val byReviewer = mutableMapOf<String, Pair<Int, Int>>()
        for (pid in 301L..303L) {
            val owner = api.reviews(pid).filter { it.str("rtype") != "5" }.associate { it.str("ordinal") to it.str("reviewer_email")!! }
            for (t in Conventions.decode(pid, chairTags(pid)).filterIsInstance<Trace.RequestSent>()) {
                val who = owner.getValue(t.ordinal)
                val (e, n) = byReviewer[who] ?: (0 to 0)
                byReviewer[who] = (e + if (t.disposition?.engaged == true) 1 else 0) to (n + if (t.disposition?.notEngaged == true) 1 else 0)
            }
        }
        return byReviewer.filterValues { it != 0 to 0 }
    }

    private fun engagement(r: AccountabilityReport) =
        r.engagement.filter { it.engaged + it.notEngaged > 0 }.associate {
            it.reviewer to
                (it.engaged to it.notEngaged)
        }

    @BeforeAll
    fun seed() {
        driver.seed(AccountabilityScenario.scenario)
        due = Instant.ofEpochSecond(driver.epoch(At("REVIEW_DUE", 0.0)))
        // the mirror first sees the reviews before the deadline, as a sync every few minutes would have; one that first met them
        // after it would date every submission late
        now = at(-12)
        sync()
        now = at(24)
        sync()
        val sheet =
            "email,origin,nominated_by,area,ac_email,decision,tier,consent,on_pc_at\n" +
                "${AccountabilityScenario.nominee},nominee,301;303,db,${AccountabilityScenario.ac},accept,junior,yes,\n" +
                "${AccountabilityScenario.junior1},invited,,db,${AccountabilityScenario.ac},accept,junior,yes,\n" +
                "${AccountabilityScenario.junior2},invited,,db,${AccountabilityScenario.ac},accept,junior,yes,\n"
        Imports(store, Clock { at(1) }).import(ImportKind.APPOINTMENTS, sheet.toByteArray(), "sheet.csv")
    }

    @Test
    @Covers("card:C1", "card:C2", "card:C3", "card:C4", "prop:AR2", "prop:AR4", "prop:AR5", "prop:AR6", "prop:V4", "card:X10")
    fun `requests are sent, answered, reminded and disposed through Writeback, and the engagement record equals HotCRP's dispositions`() {
        val s = AccountabilityScenario
        // ---- the review deadline has passed a day ago: progress, the nominee view, the coaching queue, and the suggestions the metadata gives
        var r = report()
        val ord =
            store.conn.createStatement().use { st ->
                st.executeQuery("SELECT pid, email, ordinal FROM review WHERE pid BETWEEN 301 AND 303 AND ordinal IS NOT NULL").use { rs ->
                    buildMap { while (rs.next()) put(rs.getLong(1) to rs.getString(2), rs.getString(3)) }
                }
            }
        assertEquals("B", ord[301L to s.junior1], "the scenario's ordinals follow submission order: $ord")
        assertEquals("C", ord[301L to s.nominee])
        assertEquals(listOf(303L), r.nomineeOutstanding.map { it.pid }, "the nominee's review of 303 was never submitted")
        assertEquals(1L, r.nomineeOutstanding.single().lateDays)
        assertEquals(listOf(301L to "B", 301L to "C", 302L to "C"), r.coaching.map { it.pid to it.ordinal })
        assertEquals(listOf(301L to "B", 301L to "C", 302L to "C"), r.suggestions.map { it.pid to it.ordinal })
        assertTrue(
            r.suggestions.all {
                it.status == SuggestionStatus.OPEN &&
                    it.criteria == listOf(1, 2) &&
                    it.reasons.single().contains("below the depth floor")
            },
        )

        // ---- AR4: the AC dismisses the suggestion for 302C; nothing reaches HotCRP and the record is unchanged
        AccLocal.dismiss(store, 302, "C", s.ac, now)
        r = report()
        assertEquals(SuggestionStatus.DISMISSED, r.suggestions.single { it.pid == 302L }.status)
        assertEquals(emptyMap<String, Pair<Int, Int>>(), engagement(r))
        assertEquals(emptyList<String>(), chairTags(302).filter { it.startsWith("pcs-") || it.startsWith("~~pcs-") }, "a dismissal leaves no trace in HotCRP")

        // ---- the AC sends requests on 301B and 301C (a chair sends the mail from HotCRP; PC Supervisor drafts it and records it)
        now = at(48)
        val draft =
            AccDrafts.draft(
                r.suggestions.single {
                    it.pid == 301L && it.ordinal == "B"
                },
                listOf(1, 2),
                criteria,
                "I would value a second look.",
                48,
                null,
            )
        assertTrue(draft.body.contains("1. backs each weakness with evidence") && !draft.body.contains("CANARY"))
        record(AccDrafts.recordSent(301, "B"))
        record(AccDrafts.recordSent(301, "C"))
        sync()
        r = report()
        assertEquals(listOf(ReqStatus.SENT, ReqStatus.SENT), r.requests.map { it.status })
        assertEquals(now.plus(Duration.ofHours(48)), r.requests.first().due)
        assertEquals(emptyMap<String, Pair<Int, Int>>(), engagement(r), "a sent request is not yet a disposition")
        assertEquals(SuggestionStatus.SENT, r.suggestions.single { it.pid == 301L && it.ordinal == "B" }.status)
        val sent = now

        // ---- 301B's reviewer revises the review; the next sync sees it, and the AC records the disposition
        now = sent.plus(Duration.ofHours(5))
        val rid = api.reviews(301, actas = s.junior1).first { it.str("reviewer_email") == s.junior1 }.str("rid")!!
        check(
            api.ok(
                api.call(
                    "POST",
                    "301/review",
                    mapOf("r" to rid),
                    actas = s.junior1,
                    json = """{"object":"review","PapSum":"Synthetic revised summary.","status":"complete"}""",
                ),
            ),
        )
        sync()
        r = report()
        assertEquals(ReqStatus.REPLIED, r.requests.single { it.ordinal == "B" }.status)
        assertTrue(r.requests.single { it.ordinal == "B" }.revised)
        record(AccDrafts.recordDisposition(301, "B", 1, ReqDisposition.REVISED))
        now = now.plusSeconds(3600)
        sync()
        r = report()
        assertEquals(mapOf(s.junior1 to (1 to 0)), engagement(r), "card C1: revised counts as engaged")
        assertEquals(fromHotcrp(), engagement(r))

        // ---- 301C: nothing after the due date; the reminder; and "no reply" only after the grace period (AR5)
        fun c(): AccountabilityReport = report()

        fun req() = c().requests.single { it.ordinal == "C" }
        now = sent.plus(Duration.ofHours(47))
        assertFalse(req().mayRemind, "the due date is at +48 h")
        now = sent.plus(Duration.ofHours(49))
        assertTrue(req().mayRemind)
        assertFalse(req().mayNoReply)
        record(AccDrafts.recordReminder(301, "C"))
        sync()
        assertEquals(ReqStatus.REMINDED, req().status)
        for (h in listOf(50L, 72L, 96L)) {
            now = sent.plus(Duration.ofHours(h))
            assertFalse(req().mayNoReply, "inside the grace period at +$h h")
        }
        assertEquals(mapOf(s.junior1 to (1 to 0)), engagement(c()), "no \"no reply\" is on the record before the grace period ends")
        now = sent.plus(Duration.ofHours(97))
        assertTrue(req().mayNoReply, "after the due date, the reminder and the grace period")
        record(AccDrafts.recordDisposition(301, "C", 1, ReqDisposition.NO_REPLY))
        now = now.plusSeconds(3600)
        sync()
        r = report()
        assertEquals(mapOf(s.junior1 to (1 to 0), s.nominee to (0 to 1)), engagement(r), "card C3: no reply counts against engagement")
        assertEquals(fromHotcrp(), engagement(r), "the engagement record equals the dispositions HotCRP holds")
        assertFalse(r.engagement.any { it.reviewer == s.junior2 }, "the dismissed suggestion for 302C is on nobody's record")

        // ---- an Accountability case about the nominee: their review of 303 is missing, and one case lists their papers (X10)
        val case = r.cases.single()
        assertEquals(s.nominee, case.nominee)
        assertTrue(case.missingReview)
        assertEquals(listOf(301L, 303L), case.papers)
        assertEquals(net.jonbell.pcs.core.nominations.Resolved.Decided(true), case.mayOpen)
        assertEquals(CaseStatus.CANDIDATE, case.status)
        AccLocal.setCase(store, case.nominee, "open", now)
        assertEquals(CaseStatus.OPEN, report().cases.single().status)
        record(AccDrafts.recordCase(case.papers, case.number, upheld = true))
        now = now.plusSeconds(3600)
        sync()
        assertEquals(CaseStatus.UPHELD, report().cases.single().status)
        assertTrue(chairTags(301).any { it.startsWith("~~pcs-case-1") }, chairTags(301).toString())
        val artifacts = Writeback(store, clock, Session.harness, Session.token).list()
        assertTrue(artifacts.all { it.status.key == "observed" }, artifacts.map { it.status.key }.toString())
    }
}
