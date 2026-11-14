package pcs.seed

/**
 * The early-reject scenario (PLAN M17): ten papers with the window of concepts EarlyReject open from
 * 2030-02-02 00:00 to 2030-02-04 00:00 (EARLYREJECT_OPEN/CLOSE). Reviews land the day before it opens; some
 * reviewers then change a score inside the window and others don't. Merits are HotCRP's default form
 * (1 reject, 2 weak reject, 3 weak accept, 4 accept) and the readings Q15 = reject-or-weak, Q16 = bump-window.
 * Papers 201 to 210 sit beside golden's 1 to 13 and use their own people.
 */
object EarlyRejectScenario {
    private fun e(local: String) = "$local@example.org"

    val ac = e("er-ac")
    val reviewers = (1..4).map { e("er-r$it") }

    private fun open(days: Double) = At("EARLYREJECT_OPEN", days)

    val pc = listOf(PcUser(ac, "Alex", "Chair")) + reviewers.mapIndexed { i, r -> PcUser(r, "Early", "Reviewer${i + 1}") }

    /** pid -> the merits of its three initial reviews, by reviewers 1, 2, 3 (0 = still empty). */
    private val initial =
        mapOf(
            201 to listOf(1, 1, 2), // quiet and negative
            202 to listOf(1, 2, 2), // reviewer 2 raises the score inside the window
            203 to listOf(1, 1, 1), // reviewer 1 raises it late in the window
            204 to listOf(1, 1, 2), // reviewer 3 changes it only after the window closed
            205 to listOf(1, 2, 4), // a positive review: never a candidate
            206 to listOf(1, 1, 0), // the third review is still empty
            207 to listOf(2, 2, 2), // reviewer 2 comments inside the window, keeping the score
            208 to listOf(1, 1, 3), // reviewer 3 went from weak accept to weak reject before the window opened
            209 to listOf(1, 1, 1), // the AC objects
            210 to listOf(1, 1, 1), // already rejected before the window
        )

    val papers = initial.keys.map { Paper(it, "Early-reject paper $it", listOf(e("er-author$it"))) }

    val assignments =
        initial.flatMap { (pid, merits) ->
            listOf(Assign(pid, "metareview", ac)) + merits.indices.map { Assign(pid, "primary", reviewers[it]) }
        }

    private fun reviews(): List<Event> =
        initial.flatMap { (pid, merits) ->
            merits.mapIndexedNotNull { i, m ->
                if (m == 0) return@mapIndexedNotNull null
                // 208's third review starts at weak accept two days before the window; the others are in the day before it
                val at = if (pid == 208 && i == 2) open(-2.0) else open(-1.0 + (pid - 200) * 0.01 + i * 0.1)
                SubmitReview(pid, reviewers[i], m, 3, 250, at)
            }
        }

    private fun other(): List<Event> =
        listOf(
            ChangeScore(208, reviewers[2], 2, open(-0.5)),
            ChangeScore(202, reviewers[1], 3, open(0.5)),
            ChangeScore(203, reviewers[0], 2, open(1.9)),
            ChangeScore(204, reviewers[2], 4, open(2.5)),
            PostComment(207, reviewers[1], "Synthetic note: I re-read it and my score stands.", open(0.8)),
            AddTag(209, "pcs-er-object", open(-0.2)),
            SetDecision(210, "reject", open(-0.1)),
        )

    val scenario = Scenario("early-reject", pc, papers, assignments, reviews() + other())

    /** What the plan lists, by status, at hours after the window opens (the scenario's table, written down here and not computed). */
    enum class Expect { WAITING, BUMPED, OBJECTED, READY }

    /** Papers 205, 206 and 210 are never candidates. */
    fun expected(hoursAfterOpen: Int): Map<Long, Expect> {
        val closed = hoursAfterOpen >= 48

        fun quiet() = if (closed) Expect.READY else Expect.WAITING
        return mapOf(
            201L to quiet(),
            202L to if (hoursAfterOpen >= 12) Expect.BUMPED else Expect.WAITING, // changed at +12 h
            203L to if (hoursAfterOpen >= 46) Expect.BUMPED else Expect.WAITING, // changed at +45.6 h
            204L to quiet(), // changed at +60 h, after the close
            207L to quiet(),
            208L to quiet(), // the change before the window is in the snapshot
            209L to Expect.OBJECTED,
        )
    }
}
