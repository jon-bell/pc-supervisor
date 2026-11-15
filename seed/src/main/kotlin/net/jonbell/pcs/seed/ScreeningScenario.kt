package net.jonbell.pcs.seed

import java.time.ZoneId

/**
 * The screening scenario (PLAN M13): papers 401-416 are the triage cases, 451-475 give five ACs five papers each so the per-AC band
 * (spec §10.4 B, prop:M1) has something to compare. The AC's screening metareview is in the `screen` round; her Triage value is 1 keep,
 * then 2.. one per ground in the model's order. Readings it is written for: Q1 fix-window, Q2 ac-plus-senior, Q3 any-until-release,
 * Q6 grounds, Q10 warn-then-reject, Q4 after-own-review.
 */
object ScreeningScenario {
    private fun e(local: String) = "$local@example.org"

    val ac1 = e("sc-ac1")
    val ac2 = e("sc-ac2")
    val m1Acs = (1..5).map { e("sc-m$it") }
    val senior1 = e("sc-senior1")
    val senior2 = e("sc-senior2")
    val junior1 = e("sc-junior1")

    /** The hour (since the epoch) at which 406's and 407's fix window closes. */
    val dueHours: Long = Driver.CI_PHASES.getValue("REVIEW_DUE").atZone(ZoneId.of("America/New_York")).toEpochSecond() / 3600

    private val groundSymbol =
        mapOf(
            "format" to 2,
            "scope" to 3,
            "anonymity" to 4,
            "fabricated-reference" to 5,
            "misused-citation" to 6,
            "prompt-injection" to 9,
            "nomination" to 8,
        )

    private val review = At("REVIEW_DUE", -5.0)

    /** pid -> (AC, Triage symbol or null, the second opinion's giver or null) */
    private data class Case(val pid: Int, val ac: String, val triage: Int?, val giver: String?, val asked: String? = null, val note: String? = null)

    private val cases =
        listOf(
            Case(401, ac1, groundSymbol["format"], senior1),
            Case(402, ac1, groundSymbol["scope"], null),
            Case(403, ac1, groundSymbol["scope"], null, asked = senior2),
            Case(404, ac1, groundSymbol["format"], junior1),
            Case(405, ac1, groundSymbol["anonymity"], senior1),
            Case(406, ac1, groundSymbol["anonymity"], senior1),
            Case(407, ac1, groundSymbol["anonymity"], senior1),
            Case(408, ac1, 1, null),
            Case(409, ac2, groundSymbol["nomination"], senior1),
            Case(410, ac2, groundSymbol["nomination"], senior1),
            Case(411, ac2, groundSymbol["prompt-injection"], senior1),
            Case(412, ac2, null, null),
            Case(413, ac2, groundSymbol["format"], senior1),
            Case(414, ac2, groundSymbol["format"], null, note = "My own note to the PC, not a second opinion."),
            Case(415, ac2, groundSymbol["fabricated-reference"], senior1),
            Case(416, ac2, groundSymbol["misused-citation"], senior1),
        )

    /** The ground each case paper's findings (and the AC's referral) name. */
    val groundOf: Map<Int, String> =
        mapOf(
            401 to "format",
            402 to "scope",
            403 to "scope",
            404 to "format",
            405 to "anonymity",
            406 to "anonymity",
            407 to "anonymity",
            408 to "format",
            409 to "nomination-noncompliance",
            410 to "nomination-noncompliance",
            411 to "prompt-injection",
            412 to "format",
            413 to "format",
            414 to "format",
            415 to "fabricated-reference",
            416 to "misused-citation",
        )

    private val m1Papers = m1Acs.flatMapIndexed { k, ac -> (0 until 5).map { Triple(451 + k * 5 + it, ac, k == 4 || (k % 2 == 1 && it == 0)) } }

    val pc =
        (listOf(ac1, ac2) + m1Acs).mapIndexed { i, a -> PcUser(a, "Screen", "Chair${i + 1}") } +
            listOf(PcUser(senior1, "Sam", "Senior"), PcUser(senior2, "Sue", "Senior"), PcUser(junior1, "Joe", "Junior", tags = listOf("junior")))

    val papers = (cases.map { it.pid } + m1Papers.map { it.first }).map { Paper(it, "Screening paper $it", listOf(e("sc-author$it"))) }

    val assignments =
        cases.flatMap { c ->
            listOfNotNull(
                Assign(c.pid, "metareview", c.ac, "screen"),
                c.giver?.let {
                    Assign(c.pid, "pcreview", it, "screen")
                },
                c.asked?.let { Assign(c.pid, "pcreview", it, "screen") },
            )
        } + m1Papers.map { Assign(it.first, "metareview", it.second, "screen") }

    private val events: List<Event> =
        cases.flatMap { c ->
            listOfNotNull(
                c.triage?.let { ScreenReview(c.pid, c.ac, it, c.note, review) },
                c.giver?.let { ScreenReview(c.pid, it, null, "Synthetic second opinion: I agree.", review) },
            )
        } + m1Papers.filter { it.third }.map { ScreenReview(it.first, it.second, groundSymbol["format"], null, review) } +
            listOf(
                AddTag(406, "pcs-remedy-due#$dueHours", review),
                AddTag(407, "pcs-remedy-due#$dueHours", review),
                EditPaper(407, e("sc-author407"), "Fixed: the violation was corrected in a new version.", At("REVIEW_DUE", -1.0)),
                AddTag(410, "pcs-warned", review),
                SetDecision(413, "reject", review),
            )

    private const val GROUND_VALUES = "Keep, format, scope, anonymity, fabricated-reference, misused-citation, no-contribution, nomination-noncompliance, prompt-injection"

    private val settings =
        run {
            val values =
                GROUND_VALUES.split(", ").mapIndexed {
                    i,
                    n,
                    ->
                    """{"name":"${if (i == 0) "Keep" else "Refer: $n"}","symbol":${i + 1}}"""
                }.joinToString(",")
            """{"tag_hidden":"pcs-*","review":[{"name":"screen"}],"review_visibility_pc":"after_review",""" +
                """"rf":[{"id":"s90","name":"Triage","type":"radio","required":false,"visibility":"admin","condition":"round:screen","values":[$values]},""" +
                """{"id":"s01","condition":"round:unnamed"},{"id":"s02","condition":"round:unnamed"}],""" +
                """"submission_open":true,"submission_registration":"2099-01-01","submission_done":"2099-01-02"}"""
        }

    val scenario = Scenario("screening", pc, papers, assignments, events, settings)

    /** What the plan says of each case paper under the readings above, at the screening stage, written down here and not computed. */
    enum class Expect { READY, NEEDS_SECOND_OPINION, OPINION_PENDING, NEEDS_REMEDY, REMEDY_OPEN, CURED, KEPT, NEEDS_WARNING, UNTRIAGED, REMOVED }

    /** [hoursFromDue]: the clock relative to 406's and 407's window closing. */
    fun expected(hoursFromDue: Int): Map<Long, Expect> =
        mapOf(
            401L to Expect.READY,
            402L to Expect.NEEDS_SECOND_OPINION, // S8: nobody has agreed, the paper stays in review
            403L to Expect.OPINION_PENDING, // S8: asked, not answered
            404L to Expect.NEEDS_SECOND_OPINION, // a junior is not a senior (Q2)
            405L to Expect.NEEDS_REMEDY, // Q1: the window is offered first
            406L to if (hoursFromDue > 0) Expect.READY else Expect.REMEDY_OPEN,
            407L to Expect.CURED, // the author fixed it inside the window: it stays at every time
            408L to Expect.KEPT,
            409L to Expect.NEEDS_WARNING, // Q10: warn first
            410L to Expect.READY,
            411L to Expect.READY, // prompt-injection is a ground
            412L to Expect.UNTRIAGED, // findings never remove a paper
            413L to Expect.REMOVED,
            414L to Expect.NEEDS_SECOND_OPINION, // the AC's own note is not a second opinion
            415L to Expect.READY,
            416L to Expect.READY,
        )
}
