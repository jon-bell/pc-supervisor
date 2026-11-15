package net.jonbell.pcs.seed

import net.jonbell.pcs.seed.At.Companion.disc

/**
 * The golden scenario: the contract table in PLAN.md (M2), one paper per row, each built to
 * trigger exactly the rules its row lists. Day 0 is DISCUSSION_OPEN.
 */
object Golden {
    private fun e(local: String) = "$local@example.org"

    val acBusy = e("ac-busy")
    val acIdle = e("ac-idle")
    val acNormal = e("ac-normal")
    val rSilent = e("r-silent")
    val rPinged = e("r-pinged")
    val nLaggard = e("n-laggard")
    private val r = (1..6).map { e("r$it") }
    private val r1 = r[0]
    private val r2 = r[1]
    private val r3 = r[2]
    private val r4 = r[3]
    private val r5 = r[4]
    private val r6 = r[5]

    val pc =
        listOf(
            PcUser(acBusy, "Avery", "Busy"),
            PcUser(acIdle, "Ira", "Idle"),
            PcUser(acNormal, "Noor", "Normal"),
            PcUser(rSilent, "Sam", "Silent", tags = listOf("junior")),
            PcUser(rPinged, "Pat", "Pinged"),
            PcUser(nLaggard, "Lee", "Laggard", tags = listOf("nominee")),
        ) + r.mapIndexed { i, email -> PcUser(email, "Rev", "Number${i + 1}") }

    /** pid → (AC, reviewers with their merits). Expertise is 3 unless a row says otherwise. */
    private data class Row(val ac: String, val reviewers: List<Pair<String, Int>>, val expertise: List<Int> = listOf(3, 3, 4))

    private val rows =
        mapOf(
            1 to Row(acBusy, listOf(r1 to 3, r2 to 3, r3 to 4)),
            2 to Row(acNormal, listOf(r1 to 3, r2 to 4, nLaggard to 0)),
            3 to Row(acBusy, listOf(rSilent to 1, r3 to 4, r4 to 4)),
            4 to Row(acBusy, listOf(rSilent to 2, rPinged to 4, r5 to 4)),
            5 to Row(acIdle, listOf(r1 to 2, r4 to 2, r6 to 2)),
            6 to Row(acNormal, listOf(r2 to 4, r3 to 4, r5 to 4)),
            7 to Row(acIdle, listOf(r1 to 3, r5 to 3, r6 to 4)),
            8 to Row(acBusy, listOf(r2 to 4, r4 to 3, r6 to 3)),
            9 to Row(acBusy, listOf(r3 to 3, r4 to 3, r5 to 4), expertise = listOf(2, 1, 2)),
            10 to Row(acBusy, listOf(r1 to 3, r5 to 3, r6 to 4)),
            11 to Row(acNormal, listOf(r2 to 2, r3 to 2, r6 to 2)),
            12 to Row(acNormal, listOf(rSilent to 1, r4 to 4, r5 to 4)),
            13 to Row(acNormal, listOf(r1 to 3, r3 to 3, r6 to 4)),
        )

    val papers = rows.keys.map { Paper(it, "Synthetic Paper $it", listOf(e("author$it"))) }

    val assignments =
        rows.flatMap { (pid, row) ->
            listOf(Assign(pid, "metareview", row.ac)) + row.reviewers.map { Assign(pid, "primary", it.first) }
        }

    /** Reviews land before review-due (02-01): day -13, a few hours apart. */
    private fun reviews(): List<Event> =
        rows.flatMap { (pid, row) ->
            row.reviewers.mapIndexedNotNull { i, (who, merit) ->
                if (merit == 0) return@mapIndexedNotNull null // pid 2: the nominee's review is still empty
                val words = if (pid == 10 && who == r1) 35 else 250
                SubmitReview(pid, who, merit, row.expertise[i], words, disc(-13.0 + pid * 0.01 + i * 0.1))
            }
        }

    private fun c(pid: Int, who: String, day: Int, text: String = "Synthetic discussion comment.") = PostComment(pid, who, text, disc(day))

    private fun comments(): List<Event> =
        listOf(
            // 1: control; decision on day +10
            c(1, acBusy, 1),
            c(1, r1, 4),
            c(1, r2, 13),
            // 2: missing review; otherwise healthy
            c(2, acNormal, 1),
            c(2, r1, 4),
            c(2, r2, 13),
            // 3: R-silent never comments; the split moves on day +6
            c(3, acBusy, 1),
            c(3, r3, 4),
            c(3, r4, 13),
            // 4: the AC pings R-pinged on day +3; R-pinged and R-silent never comment
            c(4, acBusy, 1),
            c(4, acBusy, 3, "@$rPinged could you say what convinced you?"),
            c(4, r5, 4),
            c(4, r5, 13),
            // 5: no comments at all
            // 6: last comment on day +2
            c(6, acNormal, 1),
            c(6, r2, 2),
            // 7: the AC never comments
            c(7, r1, 4),
            c(7, r5, 6),
            c(7, r6, 13),
            // 8: the top scorer (r2, 4) never comments
            c(8, acBusy, 1),
            c(8, r4, 4),
            c(8, r6, 13),
            // 9: low expertise; otherwise healthy
            c(9, acBusy, 1),
            c(9, r3, 4),
            c(9, r5, 6),
            c(9, r4, 13),
            // 10: thin review by r1
            c(10, acBusy, 1),
            c(10, r5, 4),
            c(10, r6, 13),
            // 11: author response on 02-09 (day -3); reviewers never comment; the AC comments on days +1 and +12
            PostComment(11, e("author11"), "Synthetic author response.", disc(-3), response = true),
            c(11, acNormal, 1),
            c(11, acNormal, 12),
            // 12: R-silent never comments; the split moves on day +5
            c(12, acNormal, 1),
            c(12, r4, 4),
            c(12, r5, 13),
            // 13: one review flagged disrespectful; otherwise healthy
            c(13, acNormal, 1),
            c(13, r1, 4),
            c(13, r6, 13),
        )

    private fun other(): List<Event> =
        listOf(
            ChangeScore(3, rSilent, 2, disc(6)),
            ChangeScore(12, rSilent, 2, disc(5)),
            Rate(10, r1, r5, listOf("short"), disc(2)),
            Rate(10, r1, r6, listOf("short"), disc(2)),
            Rate(13, r3, acNormal, listOf("disrespectful"), disc(2)),
            Rate(13, r3, r1, listOf("short"), disc(2)),
            SetDecision(1, "accept", disc(10)),
        )

    val scenario = Scenario("golden", pc, papers, assignments, reviews() + comments() + other())
}
