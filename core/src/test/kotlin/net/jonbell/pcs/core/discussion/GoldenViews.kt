package net.jonbell.pcs.core.discussion

import net.jonbell.pcs.core.rules.CommentView
import net.jonbell.pcs.core.rules.PaperView
import net.jonbell.pcs.core.rules.Phases
import net.jonbell.pcs.core.rules.ReviewView
import net.jonbell.pcs.core.rules.Version
import java.time.Duration
import java.time.Instant
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * The golden scenario's table (PLAN, golden scenario) as the rules' view, written out by hand from the table's rows: day 0 is
 * DISCUSSION_OPEN (2030-02-12 00:00 ET), reviews land on day -13, and each row's deviation is built the way the table states it.
 * The expected rule sets are the table's "Fires (exactly)" column, below, never the engine's output.
 */
object GoldenViews {
    private val et = ZoneId.of("America/New_York")

    private fun local(s: String): Instant = LocalDateTime.parse(s).atZone(et).toInstant()

    val phases = Phases(local("2030-02-01T23:59"), local("2030-02-12T00:00"), local("2030-03-03T23:59"))
    val primary: Instant = local("2030-02-26T12:00")
    val second: Instant = local("2030-03-01T12:00")

    fun day(d: Int): Instant = phases.discussionOpen.plus(Duration.ofDays(d.toLong()))

    private fun e(l: String) = "$l@example.org"

    val acBusy = e("ac-busy")
    val acIdle = e("ac-idle")
    val acNormal = e("ac-normal")
    val rSilent = e("r-silent")
    val rPinged = e("r-pinged")
    val nLaggard = e("n-laggard")
    private val r = (1..6).map { e("r$it") }

    val names =
        mapOf(
            acBusy to "Avery Busy",
            acIdle to "Ira Idle",
            acNormal to "Noor Normal",
            rSilent to "Sam Silent",
            rPinged to "Pat Pinged",
            nLaggard to "Lee Laggard",
        ) +
            r.mapIndexed { i, m -> m to "Rev Number${i + 1}" }

    fun group(email: String) =
        when (email) {
            rSilent -> "junior"
            nLaggard -> "nominee"
            else -> "senior"
        }

    private fun review(
        who: String,
        merit: Int,
        exp: Int = 3,
        words: Int = 250,
        ratings: List<String> = emptyList(),
        moves: Pair<Int, Int>? = null,
        complete: Boolean = true,
    ): ReviewView {
        val landed = day(-13)
        val versions =
            if (moves == null) {
                listOf(Version(landed, merit, exp))
            } else {
                listOf(Version(landed, moves.first, exp), Version(day(moves.second), merit, exp, approx = true))
            }
        return ReviewView(
            who,
            false,
            complete,
            if (complete) merit else null,
            if (complete) exp else null,
            words,
            ratings,
            if (moves !=
                null
            ) {
                day(moves.second)
            } else {
                landed
            },
            versions,
            completeAt = landed,
        )
    }

    private fun ac(who: String) = ReviewView(who, true, true, null, null, 0, emptyList(), day(-13), emptyList(), status = "complete")

    private fun c(who: String, d: Int, vararg mentions: String) = CommentView(who, day(d), false, who.startsWith("ac-"), mentions.toList(), words = 12)

    private fun paper(pid: Long, ac: String, reviews: List<ReviewView>, comments: List<CommentView>, decided: Boolean = false) =
        PaperView(pid, decided, listOf(ac(ac)) + reviews, comments, title = "Synthetic Paper $pid")

    val papers: List<PaperView> =
        listOf(
            paper(1, acBusy, listOf(review(r[0], 3, exp = 3), review(r[1], 3), review(r[2], 4)), listOf(c(acBusy, 1), c(r[0], 4), c(r[1], 13)), decided = true),
            paper(
                2,
                acNormal,
                listOf(review(r[0], 3), review(r[1], 4), review(nLaggard, 0, complete = false)),
                listOf(c(acNormal, 1), c(r[0], 4), c(r[1], 13)),
            ),
            paper(
                3,
                acBusy,
                listOf(review(rSilent, 2, moves = 1 to 6), review(r[2], 4), review(r[3], 4)),
                listOf(c(acBusy, 1), c(r[2], 4), c(r[3], 13)),
            ),
            paper(
                4,
                acBusy,
                listOf(review(rSilent, 2), review(rPinged, 4), review(r[4], 4)),
                listOf(c(acBusy, 1), c(acBusy, 3, rPinged), c(r[4], 4), c(r[4], 13)),
            ),
            paper(5, acIdle, listOf(review(r[0], 2), review(r[3], 2), review(r[5], 2)), emptyList()),
            paper(6, acNormal, listOf(review(r[1], 4), review(r[2], 4), review(r[4], 4)), listOf(c(acNormal, 1), c(r[1], 2))),
            paper(7, acIdle, listOf(review(r[0], 3), review(r[4], 3), review(r[5], 4)), listOf(c(r[0], 4), c(r[4], 6), c(r[5], 13))),
            paper(8, acBusy, listOf(review(r[1], 4), review(r[3], 3), review(r[5], 3)), listOf(c(acBusy, 1), c(r[3], 4), c(r[5], 13))),
            paper(
                9,
                acBusy,
                listOf(review(r[2], 3, exp = 2), review(r[3], 3, exp = 1), review(r[4], 4, exp = 2)),
                listOf(c(acBusy, 1), c(r[2], 4), c(r[4], 6), c(r[3], 13)),
            ),
            paper(
                10,
                acBusy,
                listOf(review(r[0], 3, words = 35, ratings = listOf("short", "short")), review(r[4], 3), review(r[5], 4)),
                listOf(c(acBusy, 1), c(r[4], 4), c(r[5], 13)),
            ),
            paper(
                11,
                acNormal,
                listOf(review(r[1], 2), review(r[2], 2), review(r[5], 2)),
                listOf(CommentView("author11@example.org", day(-3), true, false, emptyList(), words = 40), c(acNormal, 1), c(acNormal, 12)),
            ),
            paper(12, acNormal, listOf(review(rSilent, 2, moves = 1 to 5), review(r[3], 4), review(r[4], 4)), listOf(c(acNormal, 1), c(r[3], 4), c(r[4], 13))),
            paper(
                13,
                acNormal,
                listOf(review(r[0], 3, ratings = listOf("short")), review(r[2], 3, ratings = listOf("disrespectful")), review(r[5], 4)),
                listOf(c(acNormal, 1), c(r[0], 4), c(r[5], 13)),
            ),
        )

    /** The table's "Fires (exactly)" column at the primary instant. */
    val expected: Map<Long, Set<String>> =
        mapOf(
            1L to setOf(),
            2L to setOf("MISSING_REVIEWS"),
            3L to setOf("SPLIT"),
            4L to setOf("SPLIT", "UNRESOLVED_SPLIT"),
            5L to setOf("SILENT_DISCUSSION", "AC_ABSENT", "GONE_QUIET"),
            6L to setOf("GONE_QUIET"),
            7L to setOf("AC_ABSENT"),
            8L to setOf("CHAMPION_MISSING"),
            9L to setOf("LOW_EXPERTISE"),
            10L to setOf("THIN_REVIEWS"),
            11L to setOf("RESPONSE_UNADDRESSED"),
            12L to setOf("SPLIT"),
            13L to setOf("REVIEW_FLAGGED"),
        )

    fun input(outstanding: List<net.jonbell.pcs.core.accountability.OutstandingReview> = emptyList()) = DiscussionInput(papers, names, ::group, outstanding)
}
