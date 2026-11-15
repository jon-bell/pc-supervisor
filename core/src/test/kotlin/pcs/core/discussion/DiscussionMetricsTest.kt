package pcs.core.discussion

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import pcs.core.rules.CommentView
import pcs.core.rules.PaperView
import pcs.core.rules.Phases
import pcs.core.rules.ReviewView
import pcs.core.rules.Thresholds
import pcs.core.rules.Version
import pcs.testing.Family
import java.time.Duration
import java.time.Instant

/** The per-AC and per-reviewer metrics of spec §5a and §5b on small hand-built conferences, with the boundaries of their definitions. */
@Family("T2")
class DiscussionMetricsTest {
    private val open = Instant.parse("2030-02-12T00:00:00Z")
    private val ph = Phases(open.minus(Duration.ofDays(10)), open, open.plus(Duration.ofDays(20)))
    private val now = open.plus(Duration.ofDays(10))

    private fun day(d: Double): Instant = open.plus(Duration.ofMinutes((d * 1440).toLong()))

    private fun rev(who: String, merit: Int = 3, words: Int = 250, complete: Boolean = true, landed: Double = -9.0, ratings: List<String> = emptyList(), versions: List<Version> = emptyList()) =
        ReviewView(who, false, complete, merit, 3, words, ratings, day(landed), versions, completeAt = day(landed))

    private fun ac(who: String = "ac", status: String = "complete") =
        ReviewView(
            who,
            true,
            status == "complete",
            null,
            null,
            0,
            emptyList(),
            day(-9.0),
            emptyList(),
            status = status,
        )

    private fun c(who: String, d: Double, vararg m: String, response: Boolean = false) = CommentView(who, day(d), response, who.startsWith("ac"), m.toList())

    private fun input(vararg papers: PaperView) = DiscussionInput(papers.toList(), emptyMap(), { "senior" })

    private fun build(vararg papers: PaperView, th: Thresholds = Thresholds(), at: Instant = now) = DiscussionReports.build(input(*papers), ph, at, th)

    private fun paper(pid: Long, reviews: List<ReviewView>, comments: List<CommentView>, decided: Boolean = false) =
        PaperView(
            pid,
            decided,
            listOf(ac()) + reviews,
            comments,
        )

    private val trio = listOf(rev("a"), rev("b"), rev("c"))

    // ---- AC

    @Test
    fun `time to first post runs from opening, or from the last review landing if later`() {
        val early = paper(1, trio, listOf(c("ac", 2.0)))
        val late = paper(2, listOf(rev("a"), rev("b"), rev("c", landed = 1.0)), listOf(c("ac", 2.5)))
        val row = build(early, late).acs.single()
        assertEquals((48.0 + 36.0) / 2, row.medianHoursToFirstPost, "48 h from opening, 36 h from the review that landed on day 1")
        assertEquals(1.0, build(early).acs.single().medianHoursToFirstPost!! / 48.0)
    }

    @Test
    fun `an AC comment before the last review landed counts as zero hours, not negative`() {
        val p = paper(1, listOf(rev("a"), rev("b"), rev("c", landed = 3.0)), listOf(c("ac", 1.0)))
        assertEquals(0.0, build(p).acs.single().medianHoursToFirstPost)
    }

    @Test
    fun `coverage is the share of papers with an AC comment since opening, and a comment before opening does not count`() {
        val p1 = paper(1, trio, listOf(c("ac", 1.0)))
        val p2 = paper(2, trio, listOf(c("ac", -1.0)))
        val row = build(p1, p2).acs.single()
        assertEquals(1, row.covered)
        assertEquals(0.5, row.coverage)
        assertEquals(2, row.papers)
    }

    @Test
    fun `nudges count an @mention of a reviewer, or a comment posted while a reviewer had not yet commented`() {
        val p =
            paper(
                1,
                trio,
                listOf(
                    c("ac", 1.0, "a"), // mentions a reviewer
                    c("a", 2.0),
                    c("b", 2.0),
                    c("c", 2.0),
                    c("ac", 3.0), // everyone has spoken: not a nudge
                ),
            )
        val row = build(p).acs.single()
        assertEquals(1, row.mentionNudges)
        assertEquals(1, row.nudges)
        val q = paper(2, trio, listOf(c("ac", 1.0), c("ac", 1.5)))
        assertEquals(listOf(2, 0), build(q).acs.single().let { listOf(it.nudges, it.mentionNudges) }, "no reviewer has spoken, so both count as the proxy")
    }

    @Test
    fun `an @mention of someone who is not a reviewer on the paper is not a nudge`() {
        val p = paper(1, trio, listOf(c("a", 1.0), c("b", 1.0), c("c", 1.0), c("ac", 2.0, "stranger")))
        assertEquals(0, build(p).acs.single().nudges)
    }

    @Test
    fun `stale papers are undecided ones with no activity beyond the threshold`() {
        val quiet = paper(1, trio, listOf(c("ac", 1.0)))
        val busy = paper(2, trio, listOf(c("ac", 9.0)))
        val decided = paper(3, trio, listOf(c("ac", 1.0)), decided = true)
        assertEquals(1, build(quiet, busy, decided).acs.single().stale)
        assertEquals(0, build(quiet, busy, decided, th = Thresholds(staleDays = 20)).acs.single().stale)
    }

    @Test
    fun `metareview status counts the AC's own reviews by status, and the load column counts papers and flagged ones`() {
        val a = PaperView(1, false, listOf(ac("ac", "complete")) + trio, listOf(c("ac", 1.0)))
        val b = PaperView(2, false, listOf(ac("ac", "draft")) + trio, emptyList())
        val row = build(a, b).acs.single()
        assertEquals(mapOf("complete" to 1, "draft" to 1), row.metareviews)
        assertEquals(2, row.papers)
        assertEquals(2, row.flagged, "paper 1: no reviewer has commented, so the top scorer's silence fires; paper 2 is silent")
    }

    @Test
    fun `the sparkline is the AC's comments per day over the last 14 days, oldest first`() {
        val p = paper(1, trio, listOf(c("ac", 10.0), c("ac", 9.5), c("ac", 8.5), c("ac", 0.0)))
        val a = build(p).acs.single().activity
        assertEquals(14, a.size)
        assertEquals(2, a.last(), "two comments within the last day")
        assertEquals(1, a[12], "one the day before")
        assertEquals(1, a[3], "day 0 is 10 days before now")
        assertEquals(4, a.sum())
    }

    // ---- reviewers

    @Test
    fun `participation is the share of undecided in-discussion papers where the reviewer commented since opening`() {
        val p1 = paper(1, trio, listOf(c("a", 1.0)))
        val p2 = paper(2, trio, listOf(c("b", 1.0)))
        val p3 = paper(3, trio, listOf(c("a", 1.0)), decided = true)
        val a = build(p1, p2, p3).reviewers.first { it.person.email == "a" }
        assertEquals(listOf(2, 1), listOf(a.inDiscussion, a.commented), "the decided paper is not in discussion")
        assertEquals(0.5, a.participation)
    }

    @Test
    fun `participation is empty before discussion opens`() {
        val a = build(paper(1, trio, emptyList()), at = day(-2.0)).reviewers.first { it.person.email == "a" }
        assertNull(a.participation)
        assertEquals(0, a.inDiscussion)
    }

    @Test
    fun `responsiveness is the median time to the next comment after an @mention or an AC comment`() {
        val p1 = paper(1, trio, listOf(c("ac", 1.0, "a"), c("a", 1.5)))
        val p2 = paper(2, trio, listOf(c("ac", 2.0), c("a", 3.0)))
        val a = build(p1, p2).reviewers.first { it.person.email == "a" }
        assertEquals(18.0, a.medianResponseHours, "12 h and 24 h")
    }

    @Test
    fun `unanswered pings are @mentions with no later comment from the person, listed past the ping threshold`() {
        val p = paper(1, trio, listOf(c("ac", 6.0, "a"), c("ac", 9.0, "b")))
        val rows = build(p).reviewers
        // a was pinged 4 days ago, b 1 day ago; the threshold is 3 days
        assertEquals(listOf(4L), rows.first { it.person.email == "a" }.openPings.map { it.ageDays })
        assertEquals(emptyList<Long>(), rows.first { it.person.email == "b" }.openPings.map { it.ageDays })
        assertEquals(emptyList<Long>(), build(p, th = Thresholds(pingDays = 5)).reviewers.first { it.person.email == "a" }.openPings.map { it.ageDays })
    }

    @Test
    fun `a reply clears the ping, an earlier comment does not, and the person's own mention is not a ping`() {
        val replied = paper(1, trio, listOf(c("ac", 2.0, "a"), c("a", 3.0)))
        val earlier = paper(2, trio, listOf(c("a", 1.0), c("ac", 2.0, "a")))
        val self = paper(3, trio, listOf(c("a", 2.0, "a")))
        val a = build(replied, earlier, self).reviewers.first { it.person.email == "a" }
        assertEquals(listOf(2L), a.openPings.map { it.pid })
    }

    @Test
    fun `silent on split lists the split papers in discussion where the reviewer has no comment, counting complete reviews only`() {
        val split = listOf(rev("a", 1), rev("b", 4), rev("c", 4))
        val p1 = paper(1, split, listOf(c("b", 1.0)))
        val p2 = paper(2, split, listOf(c("a", 1.0)))
        val p3 = paper(3, listOf(rev("a", 1, complete = false), rev("b", 4), rev("c", 4)), emptyList())
        val rows = build(p1, p2, p3).reviewers
        assertEquals(listOf(1L), rows.first { it.person.email == "a" }.silentOnSplit)
        assertEquals(listOf(2L), rows.first { it.person.email == "b" }.silentOnSplit)
    }

    @Test
    fun `movement counts merit changes after opening and not before`() {
        val moves = rev("a", 2, versions = listOf(Version(day(-8.0), 1), Version(day(-2.0), 3), Version(day(2.0), 2), Version(day(4.0), 4)))
        val a = build(paper(1, listOf(moves, rev("b"), rev("c")), emptyList())).reviewers.first { it.person.email == "a" }
        assertEquals(2, a.movements, "3→2 and 2→4, not the changes before opening")
    }

    @Test
    fun `depth flags the bottom decile by median words, below the PC median`() {
        val people = (1..10).map { rev("p$it", words = 100 + it * 10) }
        val papers = people.mapIndexed { i, r -> paper(i + 1L, listOf(r, rev("x$i", words = 400), rev("y$i", words = 400)), listOf(c("ac", 1.0))) }
        val rows = build(*papers.toTypedArray()).reviewers
        assertEquals(listOf("p1", "p2", "p3"), rows.filter { it.shortest }.map { it.person.email }.sorted(), "30 reviewers: the shortest 3")
        assertEquals(110, rows.first { it.person.email == "p1" }.medianWords)
    }

    @Test
    fun `when every reviewer writes about the same length nobody is flagged`() {
        val rows = build(paper(1, trio, listOf(c("ac", 1.0))), paper(2, trio, emptyList())).reviewers
        assertFalse(rows.any { it.shortest })
    }

    @Test
    fun `negative flags are counted from the reviewer's own reviews, good ones separately, and the coaching case needs several papers`() {
        val p1 = paper(1, listOf(rev("a", ratings = listOf("vague", "good")), rev("b"), rev("c")), emptyList())
        val p2 = paper(2, listOf(rev("a", ratings = listOf("needswork")), rev("b"), rev("c")), emptyList())
        val a = build(p1, p2).reviewers.first { it.person.email == "a" }
        assertEquals(listOf(2, 1, 2, true), listOf(a.negativeFlags, a.positiveFlags, a.negativePapers, a.coaching))
        val once = build(p1).reviewers.first { it.person.email == "a" }
        assertFalse(once.coaching, "flags from one paper only")
        assertTrue(build(p1, th = Thresholds(coachPapers = 1)).reviewers.first { it.person.email == "a" }.coaching)
    }

    @Test
    fun `no outlier reason is worded as a judgement about the person`() {
        val split = listOf(rev("a", 1), rev("b", 4), rev("c", 4))
        val rows = build(paper(1, split, listOf(c("ac", 6.0, "a"))), paper(2, split, emptyList())).reviewers
        val text = rows.flatMap { it.outlierReasons }.joinToString(" ").lowercase()
        assertTrue(text.contains("no comments yet"), text)
        assertTrue(listOf("disengaged", "absent", "lazy").none { it in text })
    }
}
