package net.jonbell.pcs.seed

/**
 * The `assignment` scenario (PLAN M15): papers 201 to 212, the PC and nominees that review them, and the files that go with
 * them (affinity scores, the appointments sheet, registrations, and a TPMS assignment with deliberate faults). HotCRP holds the
 * papers, authors, conflicts and the existing reviews; everything else is a CSV a test imports.
 *
 * What it holds, and what a plan on it must show (bands of 4 senior and 3 junior, Q13 one junior, Q14 tier decides):
 * - `asg-s7` is the best match for every paper (an overloaded senior) and already reviews #209 and #212: held to the band of 4;
 * - `asg-s1` wrote #201 and `asg-s2` wrote #202, and each is the best match for the other's paper (a reciprocal 2-cycle);
 * - `asg-s3`, `asg-s4`, `asg-s5` wrote #203, #204, #205, and each is the best match for the next one's (a 3-cycle);
 * - `asg-n3` is a nominee the AC has not accepted, with the best affinity of anyone on every paper but their own (#208): never assigned (V1);
 * - `asg-n1` (junior) and `asg-n2` (senior) are accepted nominees; each owes a share of what their papers named them for;
 * - #210 declares conflicts with all seven seniors: its senior seats can't be filled, and the conflict-engineering monitor reports it;
 * - the TPMS assignment gives #211 three juniors and others an author, a conflict, an unaccepted nominee, a cycle, and `asg-s7` nine papers.
 */
object AssignScenario {
    private fun e(local: String) = "$local@example.org"

    val ac = e("asg-ac")
    val seniors = (1..7).map { e("asg-s$it") }
    val juniors = (1..4).map { e("asg-j$it") }
    val nominees = (1..3).map { e("asg-n$it") }

    val pc =
        listOf(PcUser(ac, "Ada", "Chair")) +
            seniors.mapIndexed { i, m -> PcUser(m, "Senior", "S${i + 1}") } +
            juniors.mapIndexed { i, m -> PcUser(m, "Junior", "J${i + 1}") } +
            nominees.mapIndexed { i, m -> PcUser(m, "Nominee", "N${i + 1}") }

    private fun a(k: Int) = e("asg-a$k")

    val papers =
        listOf(
            Paper(201, "Synthetic Assignment 201", listOf(seniors[0], a(1))),
            Paper(202, "Synthetic Assignment 202", listOf(seniors[1], a(2))),
            Paper(203, "Synthetic Assignment 203", listOf(seniors[2], a(3))),
            Paper(204, "Synthetic Assignment 204", listOf(seniors[3], a(4))),
            Paper(205, "Synthetic Assignment 205", listOf(seniors[4], a(5))),
            Paper(206, "Synthetic Assignment 206", listOf(a(6), nominees[0])),
            Paper(207, "Synthetic Assignment 207", listOf(a(7), nominees[1])),
            Paper(208, "Synthetic Assignment 208", listOf(a(8), nominees[2])),
            Paper(209, "Synthetic Assignment 209", listOf(a(9))),
            Paper(210, "Synthetic Assignment 210", listOf(a(10))),
            Paper(211, "Synthetic Assignment 211", listOf(a(11))),
            Paper(212, "Synthetic Assignment 212", listOf(a(12))),
        )

    val pids = papers.map { it.pid }

    val assignments =
        papers.map { Assign(it.pid, "metareview", ac) } +
            listOf(Assign(209, "pcreview", seniors[6]), Assign(212, "pcreview", seniors[6])) +
            seniors.map { Assign(210, "conflict", it) }

    val scenario = Scenario("assignment", pc, papers, assignments, emptyList())

    /** The appointments sheet: juniors and nominees; the seniors are the original PC and have no row. */
    val appointmentsCsv: String =
        buildString {
            appendLine("email,origin,nominated_by,area,ac_email,decision,tier,consent,on_pc_at")
            juniors.forEach { appendLine("$it,invited,,testing,$ac,accept,junior,yes,") }
            appendLine("${nominees[0]},nominee,206,testing,$ac,accept,junior,yes,")
            appendLine("${nominees[1]},nominee,207,testing,$ac,accept,senior,yes,")
            appendLine("${nominees[2]},nominee,208,testing,,pending,junior,,")
        }

    val registrationsCsv: String = "email,registered\n" + nominees.joinToString("") { "$it,yes\n" }

    private fun mix(a: Int, b: Int): Double {
        var h = (a * 1_000_003L + b * 7919L + 17) * 6364136223846793005L + 1442695040888963407L
        h = h xor (h ushr 29)
        return ((h ushr 11) and 0xFFFF).toDouble() / 0xFFFF
    }

    /** Affinity: an unremarkable 0.35 to 0.75 for everyone, and the scenario's deliberate best matches. */
    val scoresCsv: String =
        buildString {
            appendLine("paper,email,score")
            val hot =
                mapOf(
                    seniors[0] to listOf(202),
                    seniors[1] to listOf(201),
                    seniors[2] to listOf(204),
                    seniors[3] to listOf(205),
                    seniors[4] to listOf(203),
                )
            for (p in pids) {
                for (m in seniors + juniors + nominees) {
                    val score =
                        when {
                            m == seniors[6] -> 0.99
                            m == nominees[2] -> 0.98
                            p in hot[m].orEmpty() -> 0.97
                            else -> 0.35 + 0.4 * mix(p, m.hashCode())
                        }
                    appendLine("$p,$m,${"%.2f".format(score)}")
                }
            }
        }

    /** TPMS's own assignment, with the faults TPMS makes: it has no notion of tiers, authors or declared conflicts. */
    val tpmsAssignmentCsv: String =
        buildString {
            appendLine("paper,email,round")

            fun row(p: Int, who: String) = appendLine("$p,$who,")
            listOf(0, 1, 2).forEach { row(211, juniors[it]) } // an all-junior panel
            row(201, seniors[0]) // an author
            row(210, seniors[0]) // a declared conflict
            row(207, nominees[2]) // not accepted
            row(202, seniors[0]) // with asg-s2 on #201: a 2-cycle
            row(201, seniors[1])
            row(204, seniors[2]) // with the next two: a 3-cycle
            row(205, seniors[3])
            row(203, seniors[4])
            (201..209).forEach { row(it, seniors[6]) } // nine papers for one senior
        }
}
