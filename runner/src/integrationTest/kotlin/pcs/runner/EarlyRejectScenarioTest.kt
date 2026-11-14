package pcs.runner

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import pcs.core.earlyreject.EarlyRejectArtifacts
import pcs.core.earlyreject.EarlyRejectPlan
import pcs.core.earlyreject.ErConfig
import pcs.core.earlyreject.ErWindow
import pcs.core.hotcrp.HotcrpClient
import pcs.core.readings.Q15
import pcs.core.readings.Q16
import pcs.core.store.Backfill
import pcs.core.store.Store
import pcs.core.store.Sync
import pcs.core.time.Clock
import pcs.seed.At
import pcs.seed.Driver
import pcs.seed.EarlyRejectScenario
import pcs.seed.EarlyRejectScenario.Expect
import pcs.testing.Covers
import pcs.testing.Family
import java.nio.file.Files
import java.time.Duration
import java.time.Instant

/**
 * PLAN M17's multi-stage scenario: the harness is seeded with `early-reject` (papers 201-210 beside golden's), synced, and the
 * history backfilled, which gives the mirror the snapshots a sync every few minutes through the window would have taken. The plan
 * is then computed at the instants of the three stages (window open, inside it, closed). The expected lists are the scenario's own
 * table (`EarlyRejectScenario.expected`), not the plan's computation.
 */
@Order(3)
@Family("T11")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class EarlyRejectScenarioTest {
    private val repo = Session.repo
    private val driver by lazy { Driver(Session.harness, Session.token, repo, System.getenv("HOTCRP_COMPOSE_PROJECT") ?: "pcs") }
    private val store: Store = Store.open(Files.createTempFile("pcs-early", ".db").also { Files.delete(it) }, "test-only-key")
    private lateinit var open: Instant
    private lateinit var close: Instant
    private val cfg = ErConfig(Q15.REJECT_OR_WEAK, Q16.BUMP_WINDOW)

    @BeforeAll
    fun seedSyncBackfill() {
        driver.seed(EarlyRejectScenario.scenario)
        open = Instant.ofEpochSecond(driver.epoch(At("EARLYREJECT_OPEN", 0.0)))
        close = Instant.ofEpochSecond(driver.epoch(At("EARLYREJECT_CLOSE", 0.0)))
        assertEquals(Duration.ofHours(48), Duration.between(open, close))
        val clock = Clock { Instant.parse("2030-02-26T12:00:00Z") }
        runBlocking {
            HotcrpClient(Session.harness, Session.token, chunk = 50, strict = true).use { Sync(store, clock).run(it) }
            HotcrpClient(Session.harness, Session.token, chunk = 50, strict = true).use { Backfill(store, clock).run(it, rps = 50) }
        }
    }

    /** Only the scenario's papers: golden's 5 and 11 (all weak rejects, reviewed before the window) are candidates too, and are not this scenario's concern. */
    private fun statuses(hours: Int) =
        EarlyRejectPlan.compute(store, cfg, ErWindow(open, close), open.plus(Duration.ofHours(hours.toLong()))).candidates
            .filter { it.pid > 200 }.associate { it.pid to it.status.name }

    private fun expected(hours: Int) = EarlyRejectScenario.expected(hours).mapValues { it.value.name }

    @Test
    @Covers("prop:E-1", "card:R1", "card:R2")
    fun `the candidates at the opening, the bump inside the window, and the lists at the close match the scenario`() {
        for (h in listOf(1, 11, 13, 45, 47, 48, 49, 72)) assertEquals(expected(h), statuses(h), "at window open + $h hours")
        // the stages in words: nobody has bumped at the opening; 202 bumps at +12 h and 203 at +45.6 h; 204's later change is outside the window
        assertTrue(statuses(1).values.none { it == Expect.BUMPED.name })
        assertEquals(setOf(202L, 203L), statuses(48).filterValues { it == Expect.BUMPED.name }.keys)
        assertEquals(Expect.READY.name, statuses(72)[204L], "a change after the close is not a bump")
    }

    @Test
    @Covers("prop:E-1", "prop:E-2")
    fun `at the close the bumped, the not bumped, the reviewers who never replied, and the artifacts`() {
        val all = EarlyRejectPlan.compute(store, cfg, ErWindow(open, close), close)
        val report = all.copy(candidates = all.candidates.filter { it.pid > 200 })
        assertEquals(listOf(202L, 203L), report.bumped.map { it.pid })
        assertEquals(listOf(201L, 204L, 207L, 208L, 209L), report.notBumped.map { it.pid })
        assertEquals(listOf("er-r2@example.org"), report.bumped.single { it.pid == 202L }.bumpedBy)
        val never = report.neverResponded
        assertFalse(207L to "er-r2@example.org" in never, "reviewer 2 commented on 207 inside the window")
        assertTrue(207L to "er-r1@example.org" in never)
        assertTrue(201L to "er-r1@example.org" in never && 201L to "er-r2@example.org" in never && 201L to "er-r3@example.org" in never)
        val art = EarlyRejectArtifacts.decisions(report)
        assertEquals(listOf(201L, 204L, 207L, 208L), art.rows.map { it.pid }, "the objected paper is not ready")
        // the mail, drafted while the window was open, reaches every reviewer of every candidate waiting then (E-2)
        val midAll = EarlyRejectPlan.compute(store, cfg, ErWindow(open, close), open.plus(Duration.ofHours(1)))
        val mid = midAll.copy(candidates = midAll.candidates.filter { it.pid > 200 })
        val draft = EarlyRejectArtifacts.mailDraft(mid)
        assertEquals("201-204 207 208", draft.search)
        assertEquals(mid.candidates.filter { it.status.name == "WAITING" }.flatMap { c -> c.reviewers.map { it.email } }.toSet(), draft.recipients)
    }
}
