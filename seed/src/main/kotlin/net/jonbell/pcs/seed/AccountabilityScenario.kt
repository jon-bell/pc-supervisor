package net.jonbell.pcs.seed

/**
 * The accountability scenario (PLAN M16): three papers, 301 to 303, reviewed by a senior, two juniors and a nominee, with reviews
 * in on the day before the review deadline (REVIEW_DUE). Some are thin (60 words) and some are not, and the nominee's review of
 * 303 is never submitted. No request has been sent: a test sends them through PC Supervisor's own drafts and Writeback at
 * instants it chooses, so the times a sync first sees each tag are the test's.
 *
 * Review ordinals follow the order the reviews were submitted: A the senior, B the first junior, C the third reviewer.
 */
object AccountabilityScenario {
    private fun e(local: String) = "$local@example.org"

    val ac = e("acc-ac")
    val senior = e("acc-s1")
    val junior1 = e("acc-j1")
    val junior2 = e("acc-j2")
    val nominee = e("acc-n1")

    val pc =
        listOf(
            PcUser(ac, "Alex", "Metareviewer"),
            PcUser(senior, "Sam", "Senior"),
            PcUser(junior1, "Jo", "Junior"),
            PcUser(junior2, "Jess", "Junior"),
            PcUser(nominee, "Nia", "Nominee"),
        )

    val papers = (301..303).map { Paper(it, "Accountability paper $it", listOf(e("acc-author$it"))) }

    private val reviewers =
        mapOf(
            301 to listOf(senior, junior1, nominee),
            302 to listOf(senior, junior1, junior2),
            303 to listOf(senior, junior2, nominee),
        )

    val assignments = reviewers.flatMap { (pid, rs) -> listOf(Assign(pid, "metareview", ac)) + rs.map { Assign(pid, "primary", it) } }

    /** pid to the words of each reviewer's review in order; 0 means never submitted. */
    val words =
        mapOf(
            301 to listOf(300, 60, 70),
            302 to listOf(300, 250, 50),
            303 to listOf(300, 260, 0),
        )

    private fun day(days: Double) = At("REVIEW_DUE", days)

    private val reviews =
        words.flatMap { (pid, ws) ->
            ws.mapIndexedNotNull { i, w ->
                if (w ==
                    0
                ) {
                    null
                } else {
                    SubmitReview(
                        pid,
                        reviewers.getValue(pid)[i],
                        merit =
                            if (w <
                                150
                            ) {
                                2
                            } else {
                                3
                            },
                        expertise = 3,
                        words = w,
                        at = day(-1.0 + (pid - 300) * 0.01 + i * 0.001),
                    )
                }
            }
        }

    val scenario = Scenario("accountability", pc, papers, assignments, reviews)
}
