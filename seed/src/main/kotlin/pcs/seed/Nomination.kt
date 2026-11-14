package pcs.seed

/**
 * The `nomination` scenario (PLAN M7): papers numbered from 101 (clear of `golden`), their authors, and
 * the appointments sheet and registration list that go with them. HotCRP holds papers and authors only;
 * nominations live in the sheet (spec §10.3), so the scenario exports the CSVs a test imports.
 *
 * What it holds, and what a report on it must say:
 * - paper 104 names no nominee;
 * - `nom-nina` is nominated by papers 101, 102 and 103;
 * - paper 105 names two nominees and the AC declined one (`nom-fay`);
 * - paper 106's only nominee, `nom-hana`, is still pending and never registered with the matching system;
 * - `nom-prolific` (on the PC, no sheet row, so senior) is on papers 107 to 117: over a cap of 9 by two, and
 *   nominates a junior on every one (a Q9 pattern);
 * - the student on paper 108 hasn't consented, the one on 109 was declined, the one on 117 was "accepted" by
 *   someone who is not an AC (never acted on), and the one on 112 never registered.
 */
object Nomination {
    private fun e(local: String) = "$local@example.org"

    val ac = e("nom-ac")
    val outsider = e("nom-outsider")
    val prolific = e("nom-prolific")

    /** PC members the scenario adds. */
    val pc = listOf(PcUser(ac, "Alma", "Chair"), PcUser(prolific, "Pia", "Prolific"))

    private fun student(k: Int) = e("nom-stu$k")

    /** pid of the paper whose nominee is student k (1..11). */
    fun studentPaper(k: Int) = 106 + k

    val papers =
        listOf(
            Paper(101, "Synthetic Nominations 101", listOf(e("nom-alice"), e("nom-nina"))),
            Paper(102, "Synthetic Nominations 102", listOf(e("nom-alice"), e("nom-nina"))),
            Paper(103, "Synthetic Nominations 103", listOf(e("nom-alice"), e("nom-nina"), e("nom-omar"))),
            Paper(104, "Synthetic Nominations 104", listOf(e("nom-bram"), e("nom-cleo"))),
            Paper(105, "Synthetic Nominations 105", listOf(e("nom-dana"), e("nom-eli"), e("nom-fay"))),
            Paper(106, "Synthetic Nominations 106", listOf(e("nom-gus"), e("nom-hana"))),
        ) + (1..11).map { k -> Paper(studentPaper(k), "Synthetic Nominations ${studentPaper(k)}", listOf(prolific, student(k))) }

    /** The AC of every nomination paper is [ac]. */
    val assignments = papers.map { Assign(it.pid, "metareview", ac) }

    val scenario = Scenario("nomination", pc, papers, assignments, emptyList())

    /** The appointments sheet (spec §10.3 columns). */
    val appointmentsCsv: String =
        buildString {
            appendLine("email,origin,nominated_by,area,ac_email,decision,tier,consent,on_pc_at")
            appendLine("${e("nom-nina")},nominee,101;102;103,testing,$ac,accept,junior,yes,")
            appendLine("${e("nom-eli")},nominee,105,testing,$ac,accept,junior,yes,")
            appendLine("${e("nom-fay")},nominee,105,testing,$ac,decline,,,")
            appendLine("${e("nom-hana")},nominee,106,testing,$ac,pending,,,")
            for (k in 1..11) {
                val (decision, consent, by) =
                    when (k) {
                        2 -> Triple("accept", "", ac)
                        3 -> Triple("decline", "", ac)
                        11 -> Triple("accept", "yes", outsider)
                        else -> Triple("accept", "yes", ac)
                    }
                appendLine("${student(k)},nominee,${studentPaper(k)},testing,$by,$decision,junior,$consent,")
            }
        }

    /** Who registered with the matching system: everyone nominated except `nom-hana` and the student on paper 112. */
    val registrationsCsv: String =
        buildString {
            appendLine("email,registered")
            listOf(e("nom-nina"), e("nom-eli"), e("nom-fay")).forEach { appendLine("$it,yes") }
            for (k in 1..11) if (k != 6) appendLine("${student(k)},yes")
            appendLine("${e("nom-hana")},no")
        }
}
