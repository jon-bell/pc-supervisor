package pcs.core

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import pcs.core.earlyreject.EarlyRejectArtifacts
import pcs.core.earlyreject.EarlyRejectPlan
import pcs.core.earlyreject.ErConfig
import pcs.core.earlyreject.ErStatus
import pcs.core.earlyreject.ErWindow
import pcs.core.phases.Window
import pcs.core.readings.Q15
import pcs.core.readings.Q16
import pcs.core.rules.Faults
import pcs.core.store.Store
import pcs.testing.Covers
import pcs.testing.Family
import pcs.testing.MirrorFixture
import java.time.Duration
import java.time.Instant

/**
 * Early reject over a hand-built mirror (PLAN M17): candidates from the snapshot at the window's opening, bumps from the
 * versions after it, and the artifacts. The mirror holds only what a sync and the history backfill would put there.
 */
@Family("T2")
class EarlyRejectPlanTest {
    private val open = Instant.parse("2030-02-02T00:00:00Z")
    private val close = open.plus(Duration.ofHours(48))
    private val window = ErWindow(open, close)
    private val cfg = ErConfig(Q15.REJECT_OR_WEAK, Q16.BUMP_WINDOW)

    private fun at(hours: Long) = open.plus(Duration.ofHours(hours)).epochSecond

    private fun store(build: MirrorFixture.() -> Unit): Store = MirrorFixture.temp(build)

    private fun done(h: Long, merit: Int) = Triple(at(h), merit, "complete")

    private val table: MirrorFixture.() -> Unit = {
        paper(1)
        review(1, "a", done(-30, 1))
        review(1, "b", done(-29, 1))
        review(1, "c", done(-28, 2))
        // 2: reviewer b moves 2 -> 3 ten hours into the window
        paper(2)
        review(2, "a", done(-30, 1))
        review(2, "b", done(-29, 2), done(10, 3))
        review(2, "c", done(-28, 1))
        // 3: one positive review: never a candidate
        paper(3)
        review(3, "a", done(-30, 1))
        review(3, "b", done(-29, 1))
        review(3, "c", done(-28, 4))
        // 4: only two initial reviews
        paper(4)
        review(4, "a", done(-30, 1))
        review(4, "b", done(-29, 1))
        // 5: the AC objects
        paper(5, tags = listOf("pcs-er-object#0"))
        review(5, "a", done(-30, 1))
        review(5, "b", done(-29, 1))
        review(5, "c", done(-28, 1))
        // 6: the change comes after the window closed: not a bump
        paper(6)
        review(6, "a", done(-30, 1))
        review(6, "b", done(-29, 1))
        review(6, "c", done(-28, 2), done(50, 4))
        // 7: reviewer c was positive before the window and moved to negative before it opened: the snapshot at the opening counts
        paper(7)
        review(7, "a", done(-30, 1))
        review(7, "b", done(-29, 1))
        review(7, "c", done(-40, 3), done(-5, 2))
        // 8: a reviewer comments in the window without changing a score
        paper(8)
        review(8, "a", done(-30, 1))
        review(8, "b", done(-29, 1))
        review(8, "c", done(-28, 1))
        comment(8, "b", at(5))
        // 9: already decided
        paper(9, decision = "Reject")
        review(9, "a", done(-30, 1))
        review(9, "b", done(-29, 1))
        review(9, "c", done(-28, 1))
        // 10: the third review is submitted after the window opened: not in the snapshot
        paper(10)
        review(10, "a", done(-30, 1))
        review(10, "b", done(-29, 1))
        review(10, "c", Triple(at(3), 1, "complete"))
    }

    private fun statuses(now: Long, cfg: ErConfig = this.cfg, faults: Faults = Faults.NONE) =
        store(table).use { s -> EarlyRejectPlan.compute(s, cfg, window, Instant.ofEpochSecond(now), faults).candidates.associate { it.pid to it.status } }

    @Test
    @Covers("prop:E-1", "card:R1", "card:R2")
    fun `at the opening the candidates are the papers whose initial reviews are all negative`() {
        assertEquals(
            mapOf(
                1L to ErStatus.WAITING,
                2L to ErStatus.WAITING,
                5L to ErStatus.OBJECTED,
                6L to ErStatus.WAITING,
                7L to ErStatus.WAITING,
                8L to ErStatus.WAITING,
            ),
            statuses(at(0)),
        )
    }

    @Test
    @Covers("prop:E-1", "card:R1")
    fun `a score change inside the window is a bump`() {
        assertEquals(ErStatus.WAITING, statuses(at(9))[2L])
        assertEquals(ErStatus.BUMPED, statuses(at(11))[2L])
        // the score change after the close does not count
        assertEquals(ErStatus.READY, statuses(at(51))[6L])
        assertEquals(ErStatus.WAITING, statuses(at(47))[6L])
    }

    @Test
    @Covers("prop:E-1", "card:R2")
    fun `at the close the unbumped, unobjected candidates are ready and nothing else is`() {
        assertEquals(
            mapOf(
                1L to ErStatus.READY,
                2L to ErStatus.BUMPED,
                5L to ErStatus.OBJECTED,
                6L to ErStatus.READY,
                7L to ErStatus.READY,
                8L to ErStatus.READY,
            ),
            statuses(at(60)),
        )
        // the closing instant itself has ended the window
        assertEquals(ErStatus.READY, statuses(at(48))[1L])
        assertEquals(ErStatus.WAITING, statuses(at(48) - 1)[1L])
    }

    @Test
    @Covers("prop:E-1")
    fun `a change of the early-reject-before-close mutant would make a waiting candidate ready`() {
        assertEquals(ErStatus.READY, statuses(at(5), faults = Faults(earlyRejectBeforeWindowCloses = true))[1L])
        // a bump still stops it, even under the mutant
        assertEquals(ErStatus.BUMPED, statuses(at(20), faults = Faults(earlyRejectBeforeWindowCloses = true))[2L])
    }

    @Test
    @Covers("card:R3", "card:R4", "prop:E-1")
    fun `Q15 decides what is negative, and Q16 without a window needs no wait`() {
        val onlyReject = statuses(at(60), ErConfig(Q15.REJECT_ONLY, Q16.BUMP_WINDOW))
        assertEquals(setOf(5L, 8L), onlyReject.keys, "a weak reject is not negative: only the papers of three plain rejects remain")
        val noWindow = ErConfig(Q15.REJECT_OR_WEAK, Q16.NO_WINDOW)
        store(table).use { s ->
            val r = EarlyRejectPlan.compute(s, noWindow, ErWindow(open, null), Instant.ofEpochSecond(at(0)))
            assertEquals(ErStatus.READY, r.candidates.single { it.pid == 1L }.status)
            assertEquals(ErStatus.OBJECTED, r.candidates.single { it.pid == 5L }.status)
        }
    }

    @Test
    @Covers("prop:E-1")
    fun `the lists at close hold the bumped, the not bumped, and the reviewers who never responded`() {
        store(table).use { s ->
            val r = EarlyRejectPlan.compute(s, cfg, window, Instant.ofEpochSecond(at(60)))
            assertEquals(listOf(2L), r.bumped.map { it.pid })
            assertEquals(listOf("b@example.org"), r.bumped.single().bumpedBy)
            assertEquals(listOf(1L, 5L, 6L, 7L, 8L), r.notBumped.map { it.pid })
            val never = r.neverResponded
            assertTrue(1L to "a@example.org" in never)
            assertFalse(8L to "b@example.org" in never, "a comment in the window is a response")
            assertFalse(2L to "b@example.org" in never, "a bump is a response")
        }
    }

    @Test
    @Covers("prop:E-2")
    fun `the mail search reaches every reviewer of every waiting candidate`() {
        store(table).use { s ->
            val r = EarlyRejectPlan.compute(s, cfg, window, Instant.ofEpochSecond(at(1)))
            val draft = EarlyRejectArtifacts.mailDraft(r)
            val waiting = r.candidates.filter { it.status == ErStatus.WAITING }
            assertEquals(waiting.map { it.pid }, draft.pids)
            assertEquals(waiting.flatMap { c -> c.reviewers.map { it.email } }.toSet(), draft.recipients)
            assertEquals("1 2 6-8", draft.search)
            assertTrue("%NUMBER%" in draft.body && "2030-02-04 00:00" in draft.body, draft.body)
            assertTrue("@" !in draft.body && draft.recipients.none { it in draft.body }, "the mail names no reviewer")
        }
    }

    @Test
    @Covers("prop:E-1", "prop:C2")
    fun `the decision artifact holds only ready papers, and the author notice names no reviewer`() {
        store(table).use { s ->
            val closed = EarlyRejectPlan.compute(s, cfg, window, Instant.ofEpochSecond(at(60)))
            val art = EarlyRejectArtifacts.decisions(closed)
            assertEquals(closed.ready.map { it.pid }, art.rows.map { it.pid })
            assertEquals("paper,action,decision\n1,decision,Reject\n6,decision,Reject\n7,decision,Reject\n8,decision,Reject\n", art.toCsv())
            assertEquals("1 6-8", art.authorSearch)
            assertTrue(closed.candidates.flatMap { c -> c.reviewers.map { it.email } }.none { it in art.notice } && !art.notice.contains("bump", true))
            // a chair who confirms fewer gets fewer; a paper that isn't ready can't be added
            assertEquals(listOf(6L), EarlyRejectArtifacts.decisions(closed, setOf(6L, 2L, 5L)).rows.map { it.pid })
            val early = EarlyRejectPlan.compute(s, cfg, window, Instant.ofEpochSecond(at(1)))
            assertEquals(emptyList<Long>(), EarlyRejectArtifacts.decisions(early).rows.map { it.pid }, "nothing is ready while the window is open")
        }
    }

    @Test
    fun `the window comes from the phase dates, or from the configured hours`() {
        val dates = mapOf(Window.EARLY_REJECT.open to open, Window.EARLY_REJECT.close to open.plusSeconds(3600))
        assertEquals(ErWindow(open, open.plusSeconds(3600)), ErWindow.of(dates, Q16.BUMP_WINDOW, 48))
        assertEquals(ErWindow(open, open.plus(Duration.ofHours(72))), ErWindow.of(mapOf(Window.EARLY_REJECT.open to open), Q16.BUMP_WINDOW, 72))
        assertEquals(ErWindow(open, null), ErWindow.of(dates, Q16.NO_WINDOW, 48))
        assertEquals(null, ErWindow.of(emptyMap(), Q16.BUMP_WINDOW, 48))
    }
}
