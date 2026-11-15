package net.jonbell.pcs.core.discussion

import net.jonbell.pcs.core.accountability.OutstandingReview
import net.jonbell.pcs.core.rules.Discussion
import net.jonbell.pcs.core.rules.PaperStage
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.Duration

/**
 * The golden table (PLAN M2/M18) against the rules, over views written out from the table's rows (GoldenViews). Each row is
 * checked in both directions: every rule it lists fires, and no other does. The harness version of this check (through the
 * mirror, after a sync) is in the integration tests and the UI tests.
 */
@Family("T2")
class DiscussionGoldenTest {
    private val report = DiscussionReports.build(GoldenViews.input(), GoldenViews.phases, GoldenViews.primary)

    @Test
    @Covers(
        "golden:pid1",
        "golden:pid2",
        "golden:pid3",
        "golden:pid4",
        "golden:pid5",
        "golden:pid6",
        "golden:pid7",
        "golden:pid8",
        "golden:pid9",
        "golden:pid10",
        "golden:pid11",
        "golden:pid12",
        "golden:pid13",
    )
    fun `every golden row fires exactly its rules at the primary instant, no more and no fewer`() {
        val fired = report.papers.associate { it.pid to it.reasons.map { r -> r.rule }.toSet() }
        assertEquals(GoldenViews.expected, fired)
    }

    @Test
    @Covers("golden:pid12", "golden:pid1")
    fun `at the second instant pid 12 adds DEADLINE_NO_CONSENSUS and pid 1 fires nothing`() {
        val later = DiscussionReports.build(GoldenViews.input(), GoldenViews.phases, GoldenViews.second)
        assertTrue("DEADLINE_NO_CONSENSUS" in later.paper(12)!!.reasons.map { it.rule })
        assertEquals(emptyList<String>(), later.paper(1)!!.reasons.map { it.rule })
    }

    @Test
    fun `the triage order is severity descending, from the table's rules and the default weights`() {
        val weights =
            mapOf(
                "MISSING_REVIEWS" to 3,
                "SPLIT" to 3,
                "UNRESOLVED_SPLIT" to 2,
                "SILENT_DISCUSSION" to 3,
                "GONE_QUIET" to 2,
                "AC_ABSENT" to 2,
                "CHAMPION_MISSING" to 1,
                "LOW_EXPERTISE" to 2,
                "THIN_REVIEWS" to 1,
                "RESPONSE_UNADDRESSED" to 2,
                "REVIEW_FLAGGED" to 4,
                "DEADLINE_NO_CONSENSUS" to 3,
            )
        val order =
            GoldenViews.expected.entries.sortedWith(
                compareByDescending<Map.Entry<Long, Set<String>>> { e ->
                    e.value.sumOf { weights.getValue(it) }
                }.thenBy { it.key },
            ).map { it.key }
        assertEquals(listOf(5L, 4L, 13L, 2L, 3L, 12L, 6L, 7L, 9L, 11L, 8L, 10L, 1L), order, "the order worked out by hand from the table")
        assertEquals(order, report.papers.map { it.pid })
    }

    @Test
    fun `reasons quote their numbers`() {
        val text = { pid: Long, rule: String -> report.paper(pid)!!.reasons.first { it.rule == rule }.text }
        assertEquals("1 of 3 reviews complete".replace("1", "2"), text(2, "MISSING_REVIEWS"))
        assertEquals("scores 2/4/4", text(4, "SPLIT"))
        assertTrue("14 days" in text(4, "UNRESOLVED_SPLIT"), text(4, "UNRESOLVED_SPLIT"))
        assertTrue("35 words" in text(10, "THIN_REVIEWS"), text(10, "THIN_REVIEWS"))
        assertTrue("best 2" in text(9, "LOW_EXPERTISE"))
    }

    @Test
    @Covers("golden:pid1")
    fun `paper 1 has no reasons at all and is the lowest of the list`() {
        assertEquals(emptyList<String>(), report.paper(1)!!.reasons.map { it.rule })
        assertEquals(PaperStage.DECIDED, report.paper(1)!!.stage)
        assertEquals(1L, report.papers.last().pid)
    }

    // ---- people (PLAN, golden "People")

    @Test
    fun `AC-busy holds 6 papers with 5 flagged and comments on all of them, AC-idle 2 with 2 flagged and none`() {
        val busy = report.acs.first { it.ac.email == GoldenViews.acBusy }
        val idle = report.acs.first { it.ac.email == GoldenViews.acIdle }
        val normal = report.acs.first { it.ac.email == GoldenViews.acNormal }
        assertEquals(listOf(6, 5, 6), listOf(busy.papers, busy.flagged, busy.covered))
        assertEquals(listOf(2, 2, 0), listOf(idle.papers, idle.flagged, idle.covered))
        assertEquals(5, normal.papers)
        assertEquals(5, normal.covered)
        assertEquals(1.0, busy.coverage)
        assertEquals(0.0, idle.coverage)
        assertEquals(null, idle.medianHoursToFirstPost, "no first post to time")
        assertNotNull(busy.medianHoursToFirstPost)
        assertEquals(24.0, busy.medianHoursToFirstPost, "every AC-busy first post is on day +1")
    }

    @Test
    fun `AC stale papers and metareview status`() {
        val idle = report.acs.first { it.ac.email == GoldenViews.acIdle }
        assertEquals(1, idle.stale, "pid 5 has had nothing for 27 days; pid 7's last comment was on day 13, 1.5 days ago")
        assertEquals(mapOf("complete" to 2), idle.metareviews)
        assertEquals(0, report.acs.first { it.ac.email == GoldenViews.acBusy }.stale)
    }

    @Test
    fun `R-silent tops silent-on-split with 3 papers, and R-pinged has the unanswered ping on paper 4`() {
        val silent = report.reviewers.first { it.person.email == GoldenViews.rSilent }
        assertEquals(listOf(3L, 4L, 12L), silent.silentOnSplit)
        assertEquals(silent, report.reviewers.maxBy { it.silentOnSplit.size })
        assertEquals(3, silent.silentOnSplit.size)
        val pinged = report.reviewers.first { it.person.email == GoldenViews.rPinged }
        assertEquals(listOf(4L), pinged.openPings.map { it.pid })
        assertEquals(11L, pinged.openPings.single().ageDays, "pinged on day +3, now day +14.5")
        assertEquals(listOf(4L), pinged.silentOnSplit)
    }

    @Test
    fun `tiers split the outlier lists, and movement is counted`() {
        assertEquals("junior", report.reviewers.first { it.person.email == GoldenViews.rSilent }.group)
        assertTrue(report.outliers("junior").map { it.person.email } == listOf(GoldenViews.rSilent))
        assertTrue(GoldenViews.rPinged in report.outliers("senior").map { it.person.email })
        assertEquals(emptyList<String>(), report.outliers("nominee").map { it.person.email }, "no outstanding feed was given")
        assertEquals(2, report.reviewers.first { it.person.email == GoldenViews.rSilent }.movements, "1→2 on pids 3 and 12")
    }

    @Test
    fun `outstanding reviews from the reviewing-progress report are the nominee's outlier reason`() {
        val out = OutstandingReview(GoldenViews.nLaggard, "Lee Laggard", "nominee", 2, "C", "not started", 10)
        val r = DiscussionReports.build(GoldenViews.input(listOf(out)), GoldenViews.phases, GoldenViews.primary)
        val lee = r.reviewers.first { it.person.email == GoldenViews.nLaggard }
        assertEquals(listOf(1, 1), listOf(lee.outstanding, lee.late))
        assertEquals(listOf(GoldenViews.nLaggard), r.outliers("nominee").map { it.person.email })
        assertTrue(lee.outlierReasons.single().contains("1 review(s) outstanding past the deadline"))
    }

    @Test
    fun `rating flags are counted, and a pattern across papers makes a coaching case`() {
        val r1 = report.reviewers.first { it.person.email == "r1@example.org" }
        assertEquals(3, r1.negativeFlags, "two short ratings on the pid 10 review, one on pid 13")
        assertEquals(2, r1.negativePapers)
        assertTrue(r1.coaching, "short flags on two different papers")
        val r3 = report.reviewers.first { it.person.email == "r3@example.org" }
        assertEquals(0, r3.negativeFlags, "r3 gave the rating; their own reviews drew none")
    }

    @Test
    fun `the person page lists every paper with score, last comment and open pings`() {
        val page = report.person(GoldenViews.rPinged)!!
        assertEquals(listOf(4L), page.papers.map { it.pid })
        val row = page.papers.single()
        assertEquals(4, row.merit)
        assertEquals(null, row.lastComment)
        assertTrue(row.split)
        assertEquals(1, row.openPings.size)
        val silent = report.person(GoldenViews.rSilent)!!
        assertEquals(listOf(3L, 4L, 12L), silent.papers.map { it.pid })
        assertEquals(listOf(2, 2, 2), silent.papers.map { it.merit })
    }

    // ---- the drawer

    @Test
    @Covers("golden:pid4")
    fun `paper 4's timeline holds the day +3 ping, with no reply yet`() {
        val t = report.timeline(4)
        val ping = t.single { it.kind == EventKind.MENTION }
        assertEquals(3L, ping.day)
        assertEquals("Avery Busy", ping.who)
        assertEquals("@mentions Pat Pinged: no reply yet (11 days)", ping.detail)
        assertEquals(t.sortedBy { it.at }, t)
        assertEquals(
            listOf(
                EventKind.REVIEW,
                EventKind.REVIEW,
                EventKind.REVIEW,
                EventKind.COMMENT,
                EventKind.COMMENT,
                EventKind.MENTION,
                EventKind.COMMENT,
                EventKind.COMMENT,
            ),
            t.map {
                it.kind
            },
        )
    }

    @Test
    @Covers("golden:pid3")
    fun `a score change appears in the timeline, marked approximate when it came from the backfill`() {
        val change = report.timeline(3).single { it.kind == EventKind.SCORE }
        assertEquals("review A merit 1 → 2".replace("review A", "review"), change.detail.replace("review A", "review"))
        assertEquals(6L, change.day)
        assertTrue(change.approx)
        assertTrue(report.timeline(4).none { it.kind == EventKind.SCORE }, "paper 4 never changes a score")
    }

    @Test
    fun `the response is on paper 11's timeline before discussion opens`() {
        val t = report.timeline(11)
        assertEquals(EventKind.RESPONSE, t.first { it.day < 0 && it.kind == EventKind.RESPONSE }.kind)
        assertTrue(t.first { it.kind == EventKind.RESPONSE }.day == -3L)
    }

    // ---- the overview

    @Test
    fun `the overview counts papers by stage and by score spread`() {
        val o = report.overview
        assertEquals(mapOf(PaperStage.AWAITING_REVIEWS to 0, PaperStage.BETWEEN to 0, PaperStage.IN_DISCUSSION to 12, PaperStage.DECIDED to 1), o.stages)
        // by the table's merits: spread 0 is pids 5, 6, 11; spread 1 is 1, 2, 7, 8, 9, 10, 13; spread 2 is 3, 4, 12
        assertEquals(mapOf(0 to 3, 1 to 7, 2 to 3), o.spread)
    }

    @Test
    fun `the burndown starts from the split papers at opening and ends at the deadline`() {
        val b = report.overview.burndown
        // at opening the splits are 3 (1/4/4), 4 (2/4/4), 12 (1/4/4); pid 8's 4/3/3 and pid 13's 3/3/4 are not splits
        assertEquals(3, b.first().withoutConsensus)
        assertEquals(3.0, b.first().target)
        assertEquals(0.0, b.last().target, 1e-9)
        assertEquals(GoldenViews.phases.decisionsDue, b.last().day, "the last point is the deadline itself")
        // after day +6 pid 3 is 2/4/4 and still split by range: nothing resolves, so the line stays at 3
        assertTrue(b.filter { it.withoutConsensus != null }.all { it.withoutConsensus == 3 })
        assertTrue(b.last { it.withoutConsensus != null }.day <= GoldenViews.primary)
        assertTrue(b.first { it.withoutConsensus == null }.day > GoldenViews.primary)
        assertEquals(3, report.overview.openNoConsensus)
        assertEquals(Duration.ofDays(1), Duration.between(b[0].day, b[1].day))
    }

    @Test
    fun `Discussion severity is the sum used by the list`() {
        assertEquals(report.papers.associate { it.pid to Discussion.severity(it.reasons) }, report.papers.associate { it.pid to it.severity })
    }
}
