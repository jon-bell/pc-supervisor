package net.jonbell.pcs.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.core.readings.Q1
import net.jonbell.pcs.core.readings.Q21
import net.jonbell.pcs.core.readings.Q4
import net.jonbell.pcs.core.readings.Q5
import net.jonbell.pcs.core.readings.Q7
import net.jonbell.pcs.core.readings.Q8
import net.jonbell.pcs.core.readings.QId
import net.jonbell.pcs.core.readings.Readings
import net.jonbell.pcs.core.rules.Accountability
import net.jonbell.pcs.core.rules.Change
import net.jonbell.pcs.core.rules.Compliance
import net.jonbell.pcs.core.rules.DeskReject
import net.jonbell.pcs.core.rules.ERCase
import net.jonbell.pcs.core.rules.EarlyReject
import net.jonbell.pcs.core.rules.Faults
import net.jonbell.pcs.core.rules.Ground
import net.jonbell.pcs.core.rules.Member
import net.jonbell.pcs.core.rules.Nominations
import net.jonbell.pcs.core.rules.Nominee
import net.jonbell.pcs.core.rules.Opinion
import net.jonbell.pcs.core.rules.PaperFacts
import net.jonbell.pcs.core.rules.PaperNoms
import net.jonbell.pcs.core.rules.Pc
import net.jonbell.pcs.core.rules.Referral
import net.jonbell.pcs.core.rules.ReqDisposition
import net.jonbell.pcs.core.rules.Request
import net.jonbell.pcs.core.rules.Score
import net.jonbell.pcs.core.rules.Share
import net.jonbell.pcs.core.rules.Stage
import net.jonbell.pcs.core.rules.Suggestion
import net.jonbell.pcs.core.rules.Tier
import net.jonbell.pcs.core.rules.Venue
import net.jonbell.pcs.core.rules.WritebackRule
import net.jonbell.pcs.testing.CoversLog
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import java.nio.file.Files

/**
 * T1 (PLAN §A5): every example card, under every combination of the readings it depends on,
 * against the outcome the Lean model gives (model/export/cards.json). A card whose rules are not
 * implemented yet is reported as aborted, not passed.
 */
class CardsTest {
    private fun yesNo(b: Boolean, y: String, n: String) = if (b) y else n

    private fun senior(who: Long, isAc: Boolean = false) = Opinion(who, isAc = isAc, tier = Tier.SENIOR)

    private fun junior(who: Long) = Opinion(who, tier = Tier.JUNIOR)

    private val everyone = listOf(senior(2, isAc = true), senior(3), junior(4))

    private fun refAt(g: Ground, st: Stage, ops: List<Opinion> = everyone) =
        Referral(ac = 1, ground = g, opinions = ops, stage = st, remedyOffered = true, remedyDue = 10, now = 20)

    private fun removable(r: Readings, ref: Referral) =
        yesNo(DeskReject.mayRemove(f, r, ref), "may be desk rejected", "stays in review")

    /** Card id → its outcome under a reading, rendered as the model renders it. */
    private val implemented: Map<String, (Readings) -> String> =
        mapOf(
            "X1" to { r ->
                val g = refAt(Ground.NOMINATION_NONCOMPLIANCE, Stage.SCREENING).copy(warned = false)
                if (Nominations.compliance(r.q8!!, PaperNoms(1, emptyList()), emptySet()) == Compliance.OK) {
                    "compliant"
                } else {
                    "before any warning: ${removable(r, g)}; after a warning that is ignored: ${removable(r, g.copy(warned = true))}"
                }
            },
            "X3" to { _ ->
                val noms = (0L until 6L).map { (20 + it) to Tier.JUNIOR as Tier? }
                "${yesNo(
                    Nominations.nominationPattern(1, Tier.SENIOR, noms, venue.patternMin),
                    "shown to the PC chairs as a pattern",
                    "nothing to show",
                )}; ${Nominations.PATTERN_CONSEQUENCE}"
            },
            "X3b" to { _ ->
                val noms = (0 until 3).map { 20L to Tier.JUNIOR as Tier? }
                "${yesNo(
                    Nominations.nominationPattern(1, Tier.SENIOR, noms, venue.patternMin),
                    "shown to the PC chairs as a pattern: every nomination counts, repeats included",
                    "nothing to show",
                )}; ${Nominations.PATTERN_CONSEQUENCE}"
            },
            "X11" to { r ->
                val pn = PaperNoms(1, (0L until 4L).map { Nominee(7 + it) })
                when (val c = Nominations.compliance(r.q8!!, pn, setOf(7L, 8L, 9L, 10L), venue.nomineesMax)) {
                    Compliance.OK -> "compliant"
                    Compliance.TOO_MANY_NOMINEES -> "too many nominees: reported, and Q10's consequence applies"
                    else -> c.key
                }
            },
            "X12" to { _ ->
                val acsOfPaper = listOf(setOf(1L, 2L))
                val acs = setOf(1L, 2L, 3L)

                fun counts(decider: Long, chair: Boolean) =
                    yesNo(
                        Nominations.decisionCounts(acsOfPaper, acs, decider, chair),
                        "the decision counts",
                        "never acted on",
                    )
                "${counts(9, true)}; a PC member who is neither the paper's AC nor a chair: ${counts(9, false)}; an AC of another paper: ${counts(3, false)}"
            },
            "E3" to { r ->
                val ref = refAt(Ground.ANONYMITY, Stage.SCREENING).copy(remedyOffered = false)
                "${yesNo(
                    DeskReject.acMayKeep(r.q1 ?: Q1.entries.first(), Ground.ANONYMITY),
                    "the AC may keep it",
                    "the AC may not keep it",
                )}; if referred, ${removable(r, ref)}"
            },
            "E4" to { r -> removable(r, refAt(Ground.ANONYMITY, Stage.IN_REVIEW)) },
            "E4b" to { r -> removable(r, refAt(Ground.ANONYMITY, Stage.RELEASED)) },
            "E4c" to { r -> removable(r, refAt(Ground.SCOPE, Stage.IN_REVIEW)) },
            "E6" to { r -> removable(r, refAt(Ground.FABRICATED_REFERENCE, Stage.SCREENING)) },
            "E7" to { r -> removable(r, refAt(Ground.FORMAT, Stage.SCREENING, listOf(senior(2)))) },
            "E7b" to { r -> removable(r, refAt(Ground.FORMAT, Stage.SCREENING, listOf(Opinion(3, isAc = true)))) },
            "E7c" to { r -> removable(r, refAt(Ground.FORMAT, Stage.SCREENING, listOf(senior(2), senior(3), junior(4)))) },
            "E7d" to { r -> removable(r, refAt(Ground.FORMAT, Stage.SCREENING, emptyList())) },
            "E8" to { r ->
                val ref = refAt(Ground.FORMAT, Stage.SCREENING, listOf(senior(2).copy(agrees = false)))
                "${removable(r, ref)}; the second-opinion member ${yesNo(r.q5 == Q5.YES, "reviews it", "does not review it")}"
            },
            "E9" to { r -> removable(r, refAt(Ground.FORMAT, Stage.SCREENING, listOf(senior(1, isAc = true)))) },
            "E11" to { r -> removable(r, refAt(Ground.FORMAT, Stage.SCREENING, emptyList()).copy(askedAt = 0, now = 80)) },
            // nominations
            "X2" to { r ->
                val ns = (0L until 9L).map { PaperNoms(it, listOf(Nominee(7))) }
                "the nominee ${showOwes(r, Nominations.owes(f, r.q18!!, r.q19!!, r.q19b!!, Tier.JUNIOR, ns, 7))} reviews"
            },
            "X4" to { r ->
                yesNo(
                    Pc.fillsSenior(r.q14!!, Member(7, Tier.SENIOR, nominee = true)),
                    "fills a senior slot",
                    "fills only the third slot; the paper still needs two other seniors",
                )
            },
            "X5" to { _ -> yesNo(Pc.eligible(f, Member(7, Tier.JUNIOR, nominee = true, accepted = false), PaperFacts()), "assignable", "never assigned") },
            "X6" to
                { r ->
                    "a case ${yesNo(
                        Accountability.caseMayOpen(f, r.q20!!, true, emptyList()),
                        "opens",
                        "does not open",
                    )}; ${Accountability.consequence(r.q11!!)}"
                },
            "X7" to { r ->
                val n = Nominations.papersOverCap(r.q17!!, 11)
                if (n > 0) "$n papers over the cap, reported to the PC chairs" else "nothing to report"
            },
            "X8" to { r ->
                if (tooMany(r, 2)) {
                    "not allowed: at most ${if (r.q8 == Q8.ONE) 1 else venue.nomineesMax} nominee(s) per paper"
                } else {
                    when (val ss = Nominations.paperShares(f, r.q19!!, r.q19b!!, PaperNoms(1, listOf(Nominee(7, share = 4), Nominee(8, share = 2))))) {
                        null -> "pooled: the two together owe 3 reviews"
                        else -> ss.joinToString(", ") { Nominations.showSixths(it.second) } + " reviews"
                    }
                }
            },
            "X9" to { r ->
                if (tooMany(r, 2)) {
                    "not allowed: at most ${if (r.q8 == Q8.ONE) 1 else venue.nomineesMax} nominee(s) per paper"
                } else {
                    val pn = PaperNoms(1, listOf(Nominee(7, share = 3), Nominee(8, share = 3, accepted = false)))
                    val mine =
                        when (val ss = Nominations.paperShares(f, r.q19!!, r.q19b!!, pn)) {
                            null -> "the remaining nominee is pooled with the paper's obligation"
                            else -> "the remaining nominee owes ${Nominations.showSixths(ss.filter { it.first == 7L }.sumOf { it.second })}"
                        }
                    val moved = yesNo(Nominations.movedToUnnamed(f, r.q19b, pn), "; the declined share moves to an unnamed reviewer", "")
                    "$mine; the paper is short by ${Nominations.showSixths(Nominations.paperShortfall(f, r.q19, r.q19b, pn))}$moved"
                }
            },
            "X10" to { r ->
                val shares = (0L until 4L).map { Share(10 + it, owed = 1, done = 0) }
                "${yesNo(
                    Accountability.casesFor(shares) == 1,
                    "one case",
                    "no case",
                )} listing the ${Accountability.unmetPapers(shares).size} papers; ${Accountability.consequence(r.q11!!)}"
            },
            // assignment
            "P1" to { r -> comp(r, listOf(Member(1, Tier.SENIOR), Member(2, Tier.SENIOR), Member(3, Tier.JUNIOR), Member(4, Tier.JUNIOR))) },
            "P2" to { r -> comp(r, listOf(Member(1, Tier.SENIOR), Member(2, Tier.SENIOR), Member(3, Tier.JUNIOR, nominee = true))) },
            "P3" to { r -> comp(r, listOf(Member(1, Tier.SENIOR), Member(2, Tier.SENIOR))) },
            "P4" to { _ ->
                val authorOf = { x: Long ->
                    if (x == 1L) {
                        listOf(10L)
                    } else if (x == 2L) {
                        listOf(20L)
                    } else {
                        emptyList()
                    }
                }
                "${Pc.twoCycles(f, listOf(10L to 2L, 20L to 1L), authorOf)} reciprocal 2-cycle(s) found and broken"
            },
            "P5" to { _ -> yesNo(WritebackRule.mayApply(f, Change(dryRunOk = false, confirmed = true)), "applied", "refused") },
            // early reject
            "R1" to { r ->
                er(r, ERCase(listOf(Score.REJECT, Score.REJECT, Score.REJECT), bumped = true, windowClosed = true), "continues to author response")
            },
            "R2" to { r -> er(r, ERCase(listOf(Score.REJECT, Score.REJECT, Score.REJECT)), "waits for the window to close") },
            "R3" to { r -> er(r, ERCase(listOf(Score.REJECT, Score.REJECT, Score.WEAK_REJECT), windowClosed = true), "continues to author response") },
            "R4" to { r -> er(r, ERCase(listOf(Score.REJECT, Score.WEAK_REJECT, Score.BORDERLINE), windowClosed = true), "continues to author response") },
            // accountability requests
            "C1" to { _ -> eng(Accountability.engagement(f, listOf(Request(5, sentBy = 1, replied = true, disp = ReqDisposition.REVISED)), emptyList(), 5)) },
            "C2" to { _ -> eng(Accountability.engagement(f, listOf(Request(5, sentBy = 1, replied = true, disp = ReqDisposition.EXPLAINED)), emptyList(), 5)) },
            "C3" to { _ ->
                val q = Request(5, sentBy = 1, remindedAt = 50)
                val g = venue.accGraceH
                val end = q.due + g
                val before = end - 6
                "no-reply may be recorded at hour $before: ${Accountability.mayDispose(
                    q,
                    ReqDisposition.NO_REPLY,
                    before,
                    g,
                )}; at hour ${end + 1}: ${Accountability.mayDispose(q, ReqDisposition.NO_REPLY, end + 1, g)}"
            },
            "C4" to { _ -> eng(Accountability.engagement(f, emptyList(), listOf(Suggestion(5, dismissed = true)), 5)) },
            "C5" to { _ ->
                val e = eng(Accountability.engagement(f, listOf(Request(5, sentBy = 1, replied = true, disp = ReqDisposition.DISPUTED)), emptyList(), 5))
                "a junior's request goes to ${Accountability.escalationTarget(
                    Tier.JUNIOR,
                )}, anyone else's to ${Accountability.escalationTarget(Tier.SENIOR)}; $e"
            },
            "C6" to { r -> yesNo(Accountability.caseMayOpen(f, r.q20!!, false, emptyList()), "a quality case may open", "no case; send a request first") },
            "C8" to { r ->
                yesNo(
                    Accountability.caseMayOpen(f, r.q20!!, false, listOf(Request(5, sentBy = null, disp = ReqDisposition.NO_REPLY))),
                    "a quality case may open",
                    "no case; send a request first",
                )
            },
            "C7" to { r -> if (r.q21 == Q21.THIS_CONFERENCE) "engagement records deleted" else "a summary goes to the next chairs" },
            // screening record (Q4)
            "S12" to { r ->
                when (r.q4!!) {
                    Q4.NEVER -> "they never see the screening record"
                    Q4.AFTER_OWN_REVIEW -> "they now see the screening record and are asked for feedback on the triage"
                    Q4.ALWAYS -> "they saw the screening record from assignment"
                }
            },
            "S12b" to { r -> if (r.q4 == Q4.ALWAYS) "the screening record is shown" else "the screening record is hidden" },
        )

    /** The venue parameters the evaluators run under: the card case's, or the defaults. */
    private var venue = Venue()

    private fun tooMany(r: Readings, n: Int): Boolean =
        Nominations.compliance(r.q8!!, PaperNoms(1, (0L until n).map { Nominee(7 + it) }), (0L until n).map { 7 + it }.toSet(), venue.nomineesMax) ==
            Compliance.TOO_MANY_NOMINEES

    /** The fault switch the evaluators run under: none for the signed model, one mutant in the mutation test. */
    private var f = Faults.NONE

    private fun showOwes(r: Readings, o: Int?): String =
        when (o) {
            null -> "pooled with the paper's other nominees"
            else -> (if (r.q7 == Q7.UP_TO_MAX) "may be assigned up to " else "is expected to do ") + Nominations.showSixths(o)
        }

    private fun comp(r: Readings, seats: List<Member>) = yesNo(Pc.compositionOk(r.q13!!, r.q14!!, seats), "meets composition", "fails composition")

    private fun er(r: Readings, c: ERCase, no: String) = yesNo(EarlyReject.mayEarlyReject(f, r.q15!!, r.q16!!, c), "early rejected", no)

    private fun eng(p: Pair<Int, Int>) = "engaged ${p.first}, not engaged ${p.second}"

    @TestFactory
    fun cards(): List<DynamicTest> {
        val cards = Json.parseToJsonElement(Files.readString(Repo.path("model/export/cards.json"))).jsonArray
        return cards.flatMap { c ->
            val id = c.jsonObject["id"]!!.jsonPrimitive.content
            c.jsonObject["cases"]!!.jsonArray.map { case ->
                val reading = case.jsonObject["reading"]!!.jsonObject
                val expected = case.jsonObject["outcome"]!!.jsonPrimitive.content
                val label =
                    reading.entries.joinToString(", ") { "${it.key}=${it.value.jsonPrimitive.content}" } +
                        (case.jsonObject["venue"]?.let { ", venue=$it" } ?: "")
                DynamicTest.dynamicTest("card $id [$label]") {
                    val eval = implemented[id]
                    if (eval == null) {
                        CoversLog.record("card:$id [$label]", "card:$id", "not-implemented", "T1")
                        Assumptions.abort<Unit>("card $id: not implemented yet")
                    }
                    val r = readingOf(reading)
                    venue = OracleJson.venue(case.jsonObject["venue"])
                    val outcome =
                        try {
                            eval!!(r)
                        } catch (e: Throwable) {
                            CoversLog.record("card:$id [$label]", "card:$id", "fail", "T1")
                            throw e
                        } finally {
                            venue = Venue()
                        }
                    val pass = outcome == expected
                    CoversLog.record("card:$id [$label]", "card:$id", if (pass) "pass" else "fail", "T1")
                    reading.forEach { (q, v) -> CoversLog.record("card:$id [$label]", "q:$q=${v.jsonPrimitive.content}", if (pass) "pass" else "fail", "T1") }
                    assertEquals(expected, outcome, "card $id under $label")
                }
            }
        }
    }

    /**
     * Specification mutants (PLAN §A8): under each of `core`'s fault switches, every card gives the
     * outcome the model gives under the same mutant, so the switches are the model's mutants.
     */
    @TestFactory
    fun mutants(): List<DynamicTest> {
        val cards = Json.parseToJsonElement(Files.readString(Repo.path("model/export/cards.json"))).jsonArray
        return Faults.MUTANTS.mapIndexed { i, fault ->
            DynamicTest.dynamicTest("mutant $i matches the model's") {
                val bad = mutableListOf<String>()
                var differs = 0
                for (c in cards) {
                    val id = c.jsonObject["id"]!!.jsonPrimitive.content
                    for (case in c.jsonObject["cases"]!!.jsonArray) {
                        val o = case.jsonObject
                        val want = o["underMutant"]!!.jsonArray[i].jsonPrimitive.content
                        if (want != o["outcome"]!!.jsonPrimitive.content) differs++
                        f = fault
                        venue = OracleJson.venue(o["venue"])
                        val got =
                            try {
                                implemented.getValue(id)(readingOf(o["reading"]!!.jsonObject))
                            } finally {
                                f = Faults.NONE
                                venue = Venue()
                            }
                        if (got != want) bad += "card $id ${o["reading"]}: got '$got', model '$want'"
                    }
                }
                CoversLog.record("mutant $i", "mutant:$i", if (bad.isEmpty()) "pass" else "fail", "T1")
                assertEquals(
                    emptyList<String>(),
                    bad.take(3),
                    "${bad.size} card cases differ from the model under mutant $i ($differs cases where the model's mutant changes an outcome)",
                )
            }
        }
    }

    /** The model evaluates cards at `{}` with the card's readings set: unset questions take their first reading. */
    private fun readingOf(o: JsonObject): Readings =
        o.entries.fold(Readings()) { r, (q, v) -> r.with(QId.ofCode(q)!!, v.jsonPrimitive.content)!! }.base()
}
