package pcs.core.discussion

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import pcs.core.rules.CommentView
import pcs.core.rules.Discussion
import pcs.core.rules.DiscussionContext
import pcs.core.rules.PaperStage
import pcs.core.rules.PaperView
import pcs.core.rules.Phases
import pcs.core.rules.ReviewView
import pcs.core.rules.Thresholds
import pcs.core.rules.Version
import pcs.testing.Covers
import pcs.testing.Family
import java.time.Duration
import java.time.Instant

/**
 * Each discussion rule on its own, with a positive, a negative and a boundary case (PLAN M18). Papers are built directly; the
 * expectations are the spec §5c definitions, with the numbers of each threshold's default.
 */
@Family("T2")
class DiscussionRulesTest {
    private val open = Instant.parse("2030-02-12T05:00:00Z")
    private val ph = Phases(open.minus(Duration.ofDays(10)), open, open.plus(Duration.ofDays(20)))
    private val t = Thresholds()

    private fun day(d: Double): Instant = open.plus(Duration.ofMinutes((d * 24 * 60).toLong()))

    private fun rev(
        who: String,
        merit: Int?,
        exp: Int = 3,
        words: Int = 250,
        ratings: List<String> = emptyList(),
        complete: Boolean = true,
        versions: List<Version> = emptyList(),
        at: Instant = day(-9.0),
    ) = ReviewView(who, false, complete, merit, exp, words, ratings, at, versions, ordinal = "A")

    private fun ac() = ReviewView("ac", true, true, null, null, 0, emptyList(), day(-9.0), emptyList())

    private fun com(who: String, d: Double, mentions: List<String> = emptyList(), response: Boolean = false) =
        CommentView(who, day(d), response, who == "ac", mentions)

    private fun paper(reviews: List<ReviewView>, comments: List<CommentView> = emptyList(), decided: Boolean = false) =
        PaperView(1, decided, listOf(ac()) + reviews, comments)

    private val healthy get() = listOf(rev("a", 3), rev("b", 3), rev("c", 4))

    private fun fires(p: PaperView, now: Instant, th: Thresholds = t) = Discussion.reasons(p, ph, now, th).map { it.rule }.toSet()

    private fun ctx(p: PaperView, now: Instant, th: Thresholds = t) = DiscussionContext(p, ph, now, th)

    private fun chatter() = listOf(com("ac", 1.0), com("a", 2.0), com("b", 2.0), com("c", 2.0))

    // ---- MISSING_REVIEWS

    @Test
    @Covers("golden:pid2")
    fun `MISSING_REVIEWS fires after the review deadline when fewer than the required reviews are complete, and quotes the counts`() {
        val p = paper(listOf(rev("a", 3), rev("b", 3), rev("c", null, complete = false)))
        val m = Discussion.missingReviews(ctx(p, ph.reviewDue.plusSeconds(1)))
        assertEquals("2 of 3 reviews complete", m)
    }

    @Test
    fun `MISSING_REVIEWS is quiet before the deadline, at the deadline instant, and with enough reviews`() {
        val p = paper(listOf(rev("a", 3), rev("b", 3), rev("c", null, complete = false)))
        assertNull(Discussion.missingReviews(ctx(p, ph.reviewDue.minusSeconds(1))))
        assertNull(Discussion.missingReviews(ctx(p, ph.reviewDue)), "at the deadline itself reviews are still on time")
        assertNull(Discussion.missingReviews(ctx(paper(healthy), day(1.0))))
    }

    @Test
    fun `MISSING_REVIEWS follows the required-reviews setting`() {
        val p = paper(healthy)
        assertNull(Discussion.missingReviews(ctx(p, day(1.0), t.copy(reviewsRequired = 3))))
        assertEquals("3 of 4 reviews complete", Discussion.missingReviews(ctx(p, day(1.0), t.copy(reviewsRequired = 4))))
    }

    // ---- SPLIT

    @Test
    fun `SPLIT fires on a range of at least the threshold, and at the boundary`() {
        assertEquals("scores 1/4/4", Discussion.split(ctx(paper(listOf(rev("a", 1), rev("b", 4), rev("c", 4))), day(1.0))))
        // 4/4/2: range 2 = threshold, and 2 is below the accept line (3): both readings agree here
        assertNotNull(Discussion.split(ctx(paper(listOf(rev("a", 2), rev("b", 4), rev("c", 4))), day(1.0))))
        // 2/2/1 has range 1 < 2 and is all below the line: no split. Raising the range threshold to 3 leaves 2/4/4 unsplit by range, but the accept line still splits it
        assertNull(Discussion.split(ctx(paper(listOf(rev("a", 2), rev("b", 2), rev("c", 1))), day(1.0))))
        assertNotNull(Discussion.split(ctx(paper(listOf(rev("a", 2), rev("b", 4), rev("c", 4))), day(1.0), t.copy(splitRange = 3))))
    }

    @Test
    fun `SPLIT also fires on scores either side of the accept line with a range of one, and not when all sit on one side`() {
        val acrossLine = paper(listOf(rev("a", 2), rev("b", 3), rev("c", 3)))
        assertEquals("scores 2/3/3", Discussion.split(ctx(acrossLine, day(1.0))))
        assertNull(Discussion.split(ctx(paper(listOf(rev("a", 3), rev("b", 4), rev("c", 4))), day(1.0))), "3/4/4 is all on the accept side")
        assertNull(Discussion.split(ctx(paper(listOf(rev("a", 1), rev("b", 2), rev("c", 2))), day(1.0))), "1/2/2 is all on the reject side")
        assertNull(Discussion.split(ctx(acrossLine, day(1.0), t.copy(meritAcceptMin = 2))), "with the line at 2, all three are on the accept side")
    }

    @Test
    fun `SPLIT counts only complete reviews`() {
        assertNull(Discussion.split(ctx(paper(listOf(rev("a", 1, complete = false), rev("b", 4), rev("c", 4))), day(1.0))))
    }

    // ---- UNRESOLVED_SPLIT

    private val splitReviews = listOf(rev("a", 2), rev("b", 4), rev("c", 4))

    @Test
    @Covers("golden:pid4")
    fun `UNRESOLVED_SPLIT fires on a split with no movement once discussion is older than the threshold`() {
        val r = Discussion.unresolvedSplit(ctx(paper(splitReviews), day(14.0)))
        assertEquals("scores 2/4/4; no movement since discussion opened 14 days ago", r)
    }

    @Test
    fun `UNRESOLVED_SPLIT is quiet at exactly the threshold age, just past it it fires`() {
        assertNull(Discussion.unresolvedSplit(ctx(paper(splitReviews), day(5.0))), "exactly 5 days is not older than 5 days")
        assertNull(Discussion.unresolvedSplit(ctx(paper(splitReviews), day(5.0).plusSeconds(-1))))
        assertNotNull(Discussion.unresolvedSplit(ctx(paper(splitReviews), day(5.0).plusSeconds(1))))
    }

    @Test
    @Covers("golden:pid3", "golden:pid12")
    fun `movement since discussion opened suppresses UNRESOLVED_SPLIT, movement before it does not`() {
        val moved = rev("a", 2, versions = listOf(Version(day(-9.0), 1), Version(day(3.0), 2)))
        assertNull(Discussion.unresolvedSplit(ctx(paper(listOf(moved, rev("b", 4), rev("c", 4))), day(14.0))))
        val earlier = rev("a", 2, versions = listOf(Version(day(-5.0), 1), Version(day(-1.0), 2)))
        assertNotNull(Discussion.unresolvedSplit(ctx(paper(listOf(earlier, rev("b", 4), rev("c", 4))), day(14.0))))
    }

    @Test
    fun `UNRESOLVED_SPLIT needs a split, and discussion open`() {
        assertNull(Discussion.unresolvedSplit(ctx(paper(healthy), day(14.0))))
        assertNull(Discussion.unresolvedSplit(ctx(paper(splitReviews), day(-1.0))))
        assertNotNull(Discussion.unresolvedSplit(ctx(paper(splitReviews), day(2.0), t.copy(unresolvedDays = 1))))
    }

    // ---- SILENT_DISCUSSION

    @Test
    @Covers("golden:pid5")
    fun `SILENT_DISCUSSION fires when discussion is open and nobody has commented since it opened`() {
        assertEquals("no comments since discussion opened 3 days ago", Discussion.silentDiscussion(ctx(paper(healthy), day(3.5))))
        assertNull(Discussion.silentDiscussion(ctx(paper(healthy, listOf(com("a", 1.0))), day(3.5))))
    }

    @Test
    fun `SILENT_DISCUSSION ignores comments before opening and the author response, and is quiet before opening`() {
        val before = paper(healthy, listOf(com("a", -1.0), com("author", 1.0, response = true)))
        assertNotNull(Discussion.silentDiscussion(ctx(before, day(3.0))))
        assertNull(Discussion.silentDiscussion(ctx(before, day(-0.5))), "discussion has not opened")
        assertNotNull(Discussion.silentDiscussion(ctx(before, open)), "at the opening instant discussion is open")
    }

    // ---- GONE_QUIET

    @Test
    @Covers("golden:pid6")
    fun `GONE_QUIET fires when the last activity is older than the threshold`() {
        val p = paper(healthy, listOf(com("a", 2.0)), decided = false)
        val reasons = Discussion.goneQuiet(ctx(p, day(12.0)))
        assertEquals("no activity for 10 days (threshold 4)", reasons)
    }

    @Test
    fun `GONE_QUIET boundary, and review changes count as activity`() {
        val p = paper(listOf(rev("a", 3, at = day(1.0)), rev("b", 3, at = day(1.0)), rev("c", 4, at = day(1.0))), listOf(com("a", 2.0)))
        assertNull(Discussion.goneQuiet(ctx(p, day(6.0))), "exactly 4 days after the last activity")
        assertNotNull(Discussion.goneQuiet(ctx(p, day(6.0).plusSeconds(1))))
        val revised = paper(listOf(rev("a", 3, at = day(5.0)), rev("b", 3), rev("c", 4)), listOf(com("a", 2.0)))
        assertNull(Discussion.goneQuiet(ctx(revised, day(8.0))), "a review modified on day 5 is activity")
        assertNull(Discussion.goneQuiet(ctx(PaperView(1, false, emptyList(), emptyList()), day(30.0))), "no activity at all is not 'gone quiet'")
    }

    @Test
    fun `GONE_QUIET uses the stale-days setting`() {
        val p = paper(healthy, listOf(com("a", 2.0)))
        assertNull(Discussion.goneQuiet(ctx(p, day(8.0), t.copy(staleDays = 7))))
        assertNotNull(Discussion.goneQuiet(ctx(p, day(10.0), t.copy(staleDays = 7))))
    }

    // ---- AC_ABSENT

    @Test
    @Covers("golden:pid7")
    fun `AC_ABSENT fires when the AC has no comment since opening, and a reviewer comment does not stand in`() {
        val p = paper(healthy, listOf(com("a", 1.0)))
        assertEquals("no AC comment since discussion opened 4 days ago", Discussion.acNoComment(ctx(p, day(4.5))))
        assertNull(Discussion.acNoComment(ctx(paper(healthy, listOf(com("ac", 1.0))), day(4.5))))
    }

    @Test
    fun `AC_ABSENT counts only comments since opening and is quiet before it`() {
        assertNotNull(Discussion.acNoComment(ctx(paper(healthy, listOf(com("ac", -2.0))), day(2.0))))
        assertNull(Discussion.acNoComment(ctx(paper(healthy), day(-1.0))))
        assertNull(Discussion.acNoComment(ctx(paper(healthy, listOf(com("ac", 0.0))), day(2.0))), "a comment at the opening instant counts")
    }

    // ---- CHAMPION_MISSING

    @Test
    @Covers("golden:pid8")
    fun `CHAMPION_MISSING fires when nobody holding the top merit has commented`() {
        val p = paper(listOf(rev("a", 4), rev("b", 3), rev("c", 3)), listOf(com("b", 2.0), com("c", 3.0)))
        assertEquals("no comment from the reviewer(s) who scored 4", Discussion.championMissing(ctx(p, day(5.0))))
    }

    @Test
    fun `CHAMPION_MISSING is quiet when any holder of the top merit has commented, and when the top merit is below the accept line`() {
        val twoTop = paper(listOf(rev("a", 4), rev("b", 4), rev("c", 3)), listOf(com("b", 2.0)))
        assertNull(Discussion.championMissing(ctx(twoTop, day(5.0))))
        val allLow = paper(listOf(rev("a", 2), rev("b", 2), rev("c", 2)))
        assertNull(Discussion.championMissing(ctx(allLow, day(5.0))))
    }

    @Test
    fun `CHAMPION_MISSING boundary at the accept line, and the author response does not count as the champion's comment`() {
        val atLine = paper(listOf(rev("a", 3), rev("b", 2), rev("c", 2)))
        assertNotNull(Discussion.championMissing(ctx(atLine, day(5.0))))
        assertNull(Discussion.championMissing(ctx(atLine, day(5.0), t.copy(meritAcceptMin = 4))))
        val responded = paper(listOf(rev("a", 4), rev("b", 3), rev("c", 3)), listOf(com("a", 2.0, response = true)))
        assertNotNull(Discussion.championMissing(ctx(responded, day(5.0))))
    }

    // ---- LOW_EXPERTISE

    @Test
    @Covers("golden:pid9")
    fun `LOW_EXPERTISE fires when no complete review reaches the threshold and quotes the best`() {
        val p = paper(listOf(rev("a", 3, exp = 2), rev("b", 3, exp = 1), rev("c", 4, exp = 2)))
        assertEquals("no review with expertise ≥ 3 (best 2)", Discussion.lowExpertise(ctx(p, day(1.0))))
    }

    @Test
    fun `LOW_EXPERTISE boundary at the threshold, and with no complete review`() {
        val at = paper(listOf(rev("a", 3, exp = 2), rev("b", 3, exp = 3), rev("c", 4, exp = 1)))
        assertNull(Discussion.lowExpertise(ctx(at, day(1.0))))
        assertNotNull(Discussion.lowExpertise(ctx(at, day(1.0), t.copy(expertiseOkMin = 4))))
        assertNull(Discussion.lowExpertise(ctx(paper(emptyList()), day(1.0))), "no complete review: MISSING_REVIEWS speaks, not this")
    }

    // ---- THIN_REVIEWS

    @Test
    @Covers("golden:pid10")
    fun `THIN_REVIEWS fires on word count under the floor, or short and vague flags from enough raters`() {
        val short = paper(listOf(rev("a", 3, words = 35), rev("b", 3), rev("c", 4)))
        assertEquals("review A: 35 words (floor 150), 0× short/vague (needs 2)", Discussion.thinReviews(ctx(short, day(1.0))))
        val flagged = paper(listOf(rev("a", 3, ratings = listOf("short", "vague")), rev("b", 3), rev("c", 4)))
        assertNotNull(Discussion.thinReviews(ctx(flagged, day(1.0))))
    }

    @Test
    fun `THIN_REVIEWS boundary at the word floor and at the rater count, and other flags do not count`() {
        assertNull(Discussion.thinReviews(ctx(paper(listOf(rev("a", 3, words = 150), rev("b", 3), rev("c", 4))), day(1.0))), "exactly the floor is fine")
        assertNotNull(Discussion.thinReviews(ctx(paper(listOf(rev("a", 3, words = 149), rev("b", 3), rev("c", 4))), day(1.0))))
        assertNull(
            Discussion.thinReviews(ctx(paper(listOf(rev("a", 3, ratings = listOf("short")), rev("b", 3), rev("c", 4))), day(1.0))),
            "one rater is under 2",
        )
        assertNotNull(
            Discussion.thinReviews(ctx(paper(listOf(rev("a", 3, ratings = listOf("short")), rev("b", 3), rev("c", 4))), day(1.0), t.copy(ratingRaters = 1))),
        )
        assertNull(Discussion.thinReviews(ctx(paper(listOf(rev("a", 3, ratings = listOf("good", "good", "needswork")), rev("b", 3), rev("c", 4))), day(1.0))))
        assertNull(
            Discussion.thinReviews(ctx(paper(listOf(rev("a", 3, words = 10, complete = false), rev("b", 3), rev("c", 4))), day(1.0))),
            "an unfinished review is not thin yet",
        )
    }

    // ---- RESPONSE_UNADDRESSED

    @Test
    @Covers("golden:pid11")
    fun `RESPONSE_UNADDRESSED fires when no reviewer commented after the response, and the AC does not count`() {
        val p = paper(healthy, listOf(com("author", -3.0, response = true), com("ac", 1.0), com("ac", 12.0)))
        assertEquals("author response 17 days ago with no reviewer comment after it", Discussion.responseUnaddressed(ctx(p, day(14.0))))
    }

    @Test
    fun `RESPONSE_UNADDRESSED is quiet after a reviewer comment, and with no response`() {
        val addressed = paper(healthy, listOf(com("author", -3.0, response = true), com("b", -2.0)))
        assertNull(Discussion.responseUnaddressed(ctx(addressed, day(14.0))))
        assertNotNull(
            Discussion.responseUnaddressed(ctx(paper(healthy, listOf(com("author", -3.0, response = true), com("b", -4.0))), day(14.0))),
            "a comment before the response doesn't address it",
        )
        assertNull(Discussion.responseUnaddressed(ctx(paper(healthy, listOf(com("b", 1.0))), day(14.0))))
    }

    // ---- REVIEW_FLAGGED (phase-independent)

    @Test
    @Covers("golden:pid13")
    fun `REVIEW_FLAGGED fires on disrespectful or wrong, in every phase and on a decided paper`() {
        val p = paper(listOf(rev("a", 3, ratings = listOf("disrespectful")), rev("b", 3), rev("c", 4)))
        assertEquals(setOf("REVIEW_FLAGGED"), Discussion.reasons(p, ph, day(-30.0)).map { it.rule }.toSet() - "MISSING_REVIEWS")
        assertEquals(setOf("REVIEW_FLAGGED"), fires(p, day(-5.0)).filter { it == "REVIEW_FLAGGED" }.toSet())
        assertEquals(listOf("REVIEW_FLAGGED"), Discussion.reasons(p.copy(decided = true), ph, day(14.0)).map { it.rule })
        assertNotNull(Discussion.reviewFlagged(ctx(paper(listOf(rev("a", 3, ratings = listOf("wrong")))), day(1.0))))
    }

    @Test
    fun `REVIEW_FLAGGED is quiet for the other flags`() {
        val p = paper(listOf(rev("a", 3, ratings = listOf("short", "vague", "needswork", "narrow", "good")), rev("b", 3), rev("c", 4)))
        assertNull(Discussion.reviewFlagged(ctx(p, day(1.0))))
    }

    // ---- DEADLINE_NO_CONSENSUS

    @Test
    @Covers("golden:pid12")
    fun `DEADLINE_NO_CONSENSUS fires inside the window for a split or a silent paper, quoting the hours`() {
        val now = ph.decisionsDue.minus(Duration.ofHours(60))
        val r = Discussion.deadlineNoConsensus(ctx(paper(splitReviews, chatter()), now))
        assertEquals("60 hours to decisions (window 3 days), no decision, split", r)
        assertEquals("60 hours to decisions (window 3 days), no decision, silent", Discussion.deadlineNoConsensus(ctx(paper(healthy), now)))
    }

    @Test
    fun `DEADLINE_NO_CONSENSUS boundary at 72 hours, with consensus, and decided`() {
        val p = paper(splitReviews, chatter())
        assertNull(Discussion.deadlineNoConsensus(ctx(p, ph.decisionsDue.minus(Duration.ofHours(72)))), "exactly 3 days is not inside the window")
        assertNotNull(Discussion.deadlineNoConsensus(ctx(p, ph.decisionsDue.minus(Duration.ofHours(72)).plusSeconds(60))))
        assertNull(Discussion.deadlineNoConsensus(ctx(paper(healthy, chatter()), ph.decisionsDue.minus(Duration.ofHours(10)))), "agreed and talking")
        assertFalse("DEADLINE_NO_CONSENSUS" in fires(paper(splitReviews, chatter(), decided = true), ph.decisionsDue.minus(Duration.ofHours(10))))
    }

    // ---- severity, weights, phases

    @Test
    fun `severity is the sum of the weights, and a weight setting changes it`() {
        val p = paper(splitReviews)
        val now = day(14.0)
        val base = Discussion.reasons(p, ph, now)
        assertEquals(setOf("SPLIT", "UNRESOLVED_SPLIT", "SILENT_DISCUSSION", "AC_ABSENT", "GONE_QUIET", "CHAMPION_MISSING"), base.map { it.rule }.toSet())
        assertEquals(base.sumOf { it.weight }, Discussion.severity(base))
        val heavier = Discussion.reasons(p, ph, now, t.copy(weights = t.weights + ("SPLIT" to 10)))
        assertEquals(Discussion.severity(base) + 7, Discussion.severity(heavier))
        assertEquals(3 + 2 + 3 + 2 + 2 + 1, Discussion.severity(base), "the default weights of spec 5c")
        assertEquals(0, Discussion.severity(Discussion.reasons(p, ph, now, t.copy(weights = t.weights.mapValues { 0 }))))
    }

    @Test
    fun `a decided paper fires nothing but REVIEW_FLAGGED`() {
        assertEquals(emptyList<String>(), Discussion.reasons(paper(splitReviews, decided = true), ph, day(14.0)).map { it.rule })
    }

    @Test
    fun `before the review deadline and before opening, only the rules that apply to that phase can fire`() {
        val p = paper(listOf(rev("a", 1), rev("b", 4), rev("c", 4)))
        assertEquals(setOf("SPLIT"), fires(p, day(-12.0)), "reviewing: scores are in, discussion rules are silent")
        assertEquals(setOf("SPLIT"), fires(p, day(-5.0)), "between review deadline and opening")
    }

    @Test
    fun `stage follows the phase dates and the decision`() {
        assertEquals(PaperStage.AWAITING_REVIEWS, Discussion.stage(paper(healthy), ph, ph.reviewDue))
        assertEquals(PaperStage.BETWEEN, Discussion.stage(paper(healthy), ph, ph.reviewDue.plusSeconds(1)))
        assertEquals(PaperStage.IN_DISCUSSION, Discussion.stage(paper(healthy), ph, open))
        assertEquals(PaperStage.DECIDED, Discussion.stage(paper(healthy, decided = true), ph, open))
    }

    @Test
    fun `the rule list holds one rule per spec 5c name, each with a default weight`() {
        assertEquals(Thresholds.DEFAULT_WEIGHTS.keys, Discussion.RULES.map { it.name }.toSet())
        assertEquals(12, Discussion.RULES.size)
        assertTrue(Discussion.RULES.all { Thresholds.DEFAULT_WEIGHTS.getValue(it.name) > 0 })
    }
}
