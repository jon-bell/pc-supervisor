package net.jonbell.pcs.core.discussion

import net.jonbell.pcs.core.config.Settings
import net.jonbell.pcs.core.rules.Discussion
import net.jonbell.pcs.core.rules.PaperStage
import net.jonbell.pcs.core.rules.Thresholds
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.LocalDateTime

/**
 * The phase logic at several `PCS_NOW` values, over the golden scenario's phase dates read through the settings loader, and the
 * threshold and weight settings (spec §4.1, §5c).
 */
@Family("T2")
class DiscussionPhaseAndSettingsTest {
    private val base =
        mapOf(
            "PCS_HOTCRP_URL" to "http://127.0.0.1:8080",
            "PCS_ANSWERS" to "/tmp/a.txt",
            "PCS_TZ" to "America/New_York",
            "PCS_PHASE_REVIEW_DUE" to "2030-02-01T23:59",
            "PCS_PHASE_DISCUSSION_OPEN" to "2030-02-12T00:00",
            "PCS_PHASE_DECISIONS_DUE" to "2030-03-03T23:59",
        )

    private fun settings(extra: Map<String, String> = emptyMap()) = Settings.load(base + extra).getOrThrow()

    private fun now(local: String) = LocalDateTime.parse(local).atZone(settings().zone).toInstant()

    private fun phases() = DiscussionLoader.phases(settings().phases).first!!

    private fun fired(pid: Long, at: String): Set<String> =
        Discussion.reasons(
            GoldenViews.papers.first {
                it.pid == pid
            },
            phases(),
            now(at),
        ).map { it.rule }.toSet()

    /** What the mirror would hold at [at]: the golden view with the comments that did not exist yet removed (reviews are as seeded). */
    private fun firedAsOf(pid: Long, at: String): Set<String> {
        val t = now(at)
        val p = GoldenViews.papers.first { it.pid == pid }
        return Discussion.reasons(p.copy(comments = p.comments.filter { it.at <= t }), phases(), t).map { it.rule }.toSet()
    }

    private fun stage(pid: Long, at: String) = Discussion.stage(GoldenViews.papers.first { it.pid == pid }, phases(), now(at))

    @Test
    fun `the phase dates come from the settings in the conference's zone, and a missing one blocks the dashboard`() {
        val ph = phases()
        assertEquals(GoldenViews.phases, ph)
        val (none, missing) = DiscussionLoader.phases(settings(mapOf("PCS_PHASE_DISCUSSION_OPEN" to "")).phases)
        assertNull(none)
        assertEquals(listOf("PCS_PHASE_DISCUSSION_OPEN is not set"), missing)
    }

    @Test
    fun `stages follow PCS_NOW across the process`() {
        assertEquals(PaperStage.AWAITING_REVIEWS, stage(5, "2030-01-20T12:00"))
        assertEquals(PaperStage.AWAITING_REVIEWS, stage(5, "2030-02-01T23:59"), "at the deadline the reviews are still on time")
        assertEquals(PaperStage.BETWEEN, stage(5, "2030-02-05T12:00"))
        assertEquals(PaperStage.IN_DISCUSSION, stage(5, "2030-02-12T00:00"))
        assertEquals(PaperStage.IN_DISCUSSION, stage(5, "2030-03-10T12:00"), "past the decisions deadline an undecided paper is still in discussion")
        assertEquals(PaperStage.DECIDED, stage(1, "2030-02-20T12:00"))
    }

    @Test
    @Covers("golden:pid2", "golden:pid5")
    fun `during reviewing only the review-reading rules can fire`() {
        // pid 2's third review is empty, but the deadline has not passed
        assertEquals(emptySet<String>(), fired(2, "2030-01-25T12:00"))
        assertEquals(emptySet<String>(), firedAsOf(5, "2030-01-25T12:00"), "nobody is expected to comment yet")
        assertEquals(setOf("SPLIT"), fired(3, "2030-01-25T12:00"))
        assertEquals(setOf("LOW_EXPERTISE"), fired(9, "2030-01-25T12:00"))
        assertEquals(setOf("THIN_REVIEWS"), fired(10, "2030-01-25T12:00"))
        assertEquals(setOf("REVIEW_FLAGGED"), fired(13, "2030-01-25T12:00"), "phase-independent")
    }

    @Test
    @Covers("golden:pid2")
    fun `between the review deadline and opening, MISSING_REVIEWS appears and the discussion rules stay quiet`() {
        assertEquals(setOf("MISSING_REVIEWS"), fired(2, "2030-02-05T12:00"))
        // the talk rules about opening the discussion stay quiet before it opens: nothing here is SILENT_DISCUSSION or AC_ABSENT
        assertEquals(setOf("GONE_QUIET"), fired(5, "2030-02-05T12:00"), "no activity since the reviews: only GONE_QUIET, which needs no phase")
        assertTrue("RESPONSE_UNADDRESSED" !in firedAsOf(11, "2030-02-05T12:00"), "no response yet, so nothing to address")
    }

    @Test
    @Covers("golden:pid5", "golden:pid8", "golden:pid11")
    fun `CHAMPION_MISSING, GONE_QUIET and RESPONSE_UNADDRESSED fire as soon as their conditions hold, before discussion opens (owner's ruling, 2026-11-15)`() {
        // CHAMPION_MISSING (pid 8: merit 4/3/3, the 4 never comments): from the first instant a complete review holds an accept-side top score
        for (at in listOf("2030-01-25T12:00", "2030-02-01T23:59", "2030-02-05T12:00", "2030-02-11T23:59", "2030-02-12T00:00")) {
            assertTrue("CHAMPION_MISSING" in firedAsOf(8, at), at)
        }
        // not for a paper whose top score is below the accept line (pid 5: 2/2/2)
        assertTrue("CHAMPION_MISSING" !in firedAsOf(5, "2030-01-25T12:00"))
        // RESPONSE_UNADDRESSED (pid 11, response on 02-09): cannot fire before there is a response, fires from the response on, in reviewing or in between
        assertTrue("RESPONSE_UNADDRESSED" !in firedAsOf(11, "2030-02-08T12:00"))
        assertTrue("RESPONSE_UNADDRESSED" in firedAsOf(11, "2030-02-10T12:00"), "the response window is still open, discussion is not")
        assertTrue("RESPONSE_UNADDRESSED" in firedAsOf(11, "2030-02-11T23:59"))
        assertTrue("RESPONSE_UNADDRESSED" in firedAsOf(11, "2030-02-12T00:00"), "and it stays on once discussion opens")
        // GONE_QUIET (pid 5, nothing since the reviews): in no phase before its threshold, from the threshold on in every phase
        assertEquals(emptySet<String>(), firedAsOf(5, "2030-01-25T12:00"))
        assertEquals(setOf("GONE_QUIET"), firedAsOf(5, "2030-02-05T12:00"))
        assertEquals(setOf("GONE_QUIET"), firedAsOf(5, "2030-02-11T23:59"))
        // and the rules that need the discussion to have opened still do
        for (at in listOf("2030-01-25T12:00", "2030-02-05T12:00", "2030-02-11T23:59")) {
            val f = firedAsOf(5, at) + firedAsOf(7, at) + firedAsOf(4, at)
            assertTrue(f.none { it == "SILENT_DISCUSSION" || it == "AC_ABSENT" || it == "UNRESOLVED_SPLIT" }, "$at: $f")
        }
    }

    @Test
    @Covers("golden:pid5", "golden:pid7", "golden:pid4")
    fun `in discussion the rules come on as their windows pass`() {
        // day 0 at midnight: silent and AC-absent at once, a split is not yet unresolved
        assertEquals(setOf("SILENT_DISCUSSION", "AC_ABSENT", "GONE_QUIET"), fired(5, "2030-02-12T00:00"))
        assertEquals(setOf("SPLIT"), fired(4, "2030-02-12T00:00").filter { it == "SPLIT" }.toSet())
        assertEquals(setOf("SPLIT"), fired(4, "2030-02-17T00:00").filter { it.startsWith("SPLIT") || it.startsWith("UNRES") }.toSet(), "exactly 5 days")
        assertEquals(setOf("SPLIT", "UNRESOLVED_SPLIT"), fired(4, "2030-02-17T00:01").filter { it.startsWith("SPLIT") || it.startsWith("UNRES") }.toSet())
    }

    @Test
    @Covers("golden:pid12", "golden:pid1")
    fun `near the deadline the window opens, and a decided paper stays quiet`() {
        assertTrue("DEADLINE_NO_CONSENSUS" !in fired(12, "2030-02-28T12:00"), "5 days out")
        assertTrue("DEADLINE_NO_CONSENSUS" in fired(12, "2030-03-01T12:00"))
        assertTrue("DEADLINE_NO_CONSENSUS" in fired(12, "2030-03-03T12:00"))
        assertEquals(emptySet<String>(), fired(1, "2030-03-03T12:00"))
    }

    @Test
    fun `after the decisions deadline the undecided papers keep their reasons`() {
        assertTrue("DEADLINE_NO_CONSENSUS" in fired(12, "2030-03-10T12:00"), "negative hours to the deadline are still under the window")
    }

    // ---- settings

    @Test
    @Covers("golden:pid3")
    fun `thresholds and weights come from PCS_THRESH and PCS_RULE settings, with the scale values from their own settings`() {
        val s =
            settings(
                mapOf(
                    "PCS_THRESH_SPLIT_RANGE" to "3",
                    "PCS_THRESH_STALE_DAYS" to "7",
                    "PCS_THRESH_PING_DAYS" to "9",
                    "PCS_RULE_SPLIT_WEIGHT" to "5",
                    "PCS_MERIT_ACCEPT_MIN" to "4",
                    "PCS_REVIEWS_REQUIRED" to "4",
                ),
            )
        val (t, problems) = Thresholds.fromSettings(s.raw, s.meritAcceptMin, s.expertiseOkMin, s.reviewsRequired)
        assertEquals(emptyList<String>(), problems)
        assertEquals(3, t.splitRange)
        assertEquals(7L, t.staleDays)
        assertEquals(9L, t.pingDays)
        assertEquals(5, t.weights.getValue("SPLIT"))
        assertEquals(4, t.meritAcceptMin)
        assertEquals(4, t.reviewsRequired)
        assertEquals(Thresholds.DEFAULT_WEIGHTS.getValue("GONE_QUIET"), t.weights.getValue("GONE_QUIET"))
        assertEquals(Thresholds().unresolvedDays, t.unresolvedDays)
    }

    @Test
    fun `a bad threshold, a bad weight and an unknown name are each reported, and the defaults stand`() {
        val raw = mapOf("PCS_THRESH_STALE_DAYS" to "soon", "PCS_RULE_SPLIT_WEIGHT" to "-1", "PCS_RULE_NOPE_WEIGHT" to "1", "PCS_THRESH_NOPE" to "1")
        val (t, problems) = Thresholds.fromSettings(raw, 3, 3, 3)
        assertEquals(4, problems.size, problems.toString())
        assertTrue(problems.any { it.startsWith("PCS_THRESH_STALE_DAYS") })
        assertTrue(problems.any { it.startsWith("PCS_RULE_SPLIT_WEIGHT") })
        assertTrue(problems.any { it.startsWith("PCS_RULE_NOPE_WEIGHT") })
        assertTrue(problems.any { it.startsWith("PCS_THRESH_NOPE") })
        assertEquals(Thresholds(), t)
    }

    @Test
    fun `a weight of zero keeps the chip but drops its severity, and PCS_RULE overrides move the triage order`() {
        val heavy = Thresholds(weights = Thresholds.DEFAULT_WEIGHTS + ("GONE_QUIET" to 9))
        val r = DiscussionReports.build(GoldenViews.input(), GoldenViews.phases, GoldenViews.primary, heavy)
        // pid 6 (GONE_QUIET alone) now has severity 9, ahead of pid 5's 3+2+9
        assertEquals(14, r.paper(5)!!.severity)
        assertEquals(9, r.paper(6)!!.severity)
        assertEquals(listOf(5L, 6L), r.papers.map { it.pid }.take(2))
    }
}
