package net.jonbell.pcs.core.assignment

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import net.jonbell.pcs.core.LiveOracle
import net.jonbell.pcs.core.readings.Q13
import net.jonbell.pcs.core.readings.Q14
import net.jonbell.pcs.core.rules.Faults
import net.jonbell.pcs.core.rules.JuniorSeats
import net.jonbell.pcs.core.rules.Member
import net.jonbell.pcs.core.rules.Tier
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory

/**
 * PLAN M15's done-when: on the model's synthetic conference, `core`'s solve report matches the Lean report's composition and
 * shortfall counts. The oracle gives the conference (the reviewers with their caps, the papers, the pruned candidate edges) and the Lean
 * solver's outcome; `core` solves the same instance with its own network, cycle repair and assessment. Scaled down from the report's
 * 4,000 papers so the comparison runs in every build; the model's report is the full-size run.
 */
@Family("T2")
@Covers(
    "rule:composition",
    "rule:load",
    "rule:cycle-free",
    "prop:A1",
    "prop:A3",
    "prop:A4",
    "prop:V1",
    "q:Q13=one-junior",
    "q:Q14=nominee-not-senior",
    "prop:A5",
    "card:P6",
)
class PlanOracleTest {
    private fun tier(j: kotlinx.serialization.json.JsonElement): Tier? =
        (j as? JsonPrimitive)?.takeIf { it.isString }?.content?.let {
            if (it ==
                "senior"
            ) {
                Tier.SENIOR
            } else {
                Tier.JUNIOR
            }
        }

    private data class Variant(val name: String, val q13: Q13, val q14: Q14, val q18: String, val juniorSeats: JuniorSeats = JuniorSeats.FILL)

    private val variants =
        listOf(
            Variant("answered", Q13.ONE_OR_TWO_JUNIORS, Q14.TIER_DECIDES, "once"),
            Variant("one junior", Q13.ONE_JUNIOR, Q14.TIER_DECIDES, "once"),
            Variant("zero to two", Q13.ZERO_TO_TWO_JUNIORS, Q14.TIER_DECIDES, "once"),
            Variant("zero to two, nominee not senior", Q13.ZERO_TO_TWO_JUNIORS, Q14.NOMINEE_NOT_SENIOR, "once"),
            // the chair's choice of who takes the optional seats (PCS_JUNIOR_SEATS): each mode against the Lean solver, under both readings of Q14
            Variant("zero to two, junior seats when short", Q13.ZERO_TO_TWO_JUNIORS, Q14.TIER_DECIDES, "once", JuniorSeats.WHEN_SHORT),
            Variant("zero to two, junior seats reciprocal only", Q13.ZERO_TO_TWO_JUNIORS, Q14.TIER_DECIDES, "once", JuniorSeats.RECIPROCAL_ONLY),
            Variant("zero to two, nominee not senior, when short", Q13.ZERO_TO_TWO_JUNIORS, Q14.NOMINEE_NOT_SENIOR, "once", JuniorSeats.WHEN_SHORT),
            Variant("zero to two, nominee not senior, reciprocal only", Q13.ZERO_TO_TWO_JUNIORS, Q14.NOMINEE_NOT_SENIOR, "once", JuniorSeats.RECIPROCAL_ONLY),
            Variant("zero to two, nominee not senior, fill", Q13.ZERO_TO_TWO_JUNIORS, Q14.NOMINEE_NOT_SENIOR, "once", JuniorSeats.FILL),
            Variant("one or two juniors ignores the choice", Q13.ONE_OR_TWO_JUNIORS, Q14.TIER_DECIDES, "once", JuniorSeats.RECIPROCAL_ONLY),
            Variant("junior or nominee", Q13.ONE_JUNIOR_OR_NOMINEE, Q14.TIER_DECIDES, "once"),
            Variant("nominee not senior", Q13.ONE_OR_TWO_JUNIORS, Q14.NOMINEE_NOT_SENIOR, "once"),
            Variant("per paper", Q13.ONE_OR_TWO_JUNIORS, Q14.TIER_DECIDES, "per-paper"),
        )

    private fun ask(scale: JsonObject, v: Variant): JsonObject =
        LiveOracle.ask(
            buildJsonObject {
                put("q", "plan")
                put("scale", scale)
                put(
                    "reading",
                    buildJsonObject {
                        put("Q13", v.q13.key)
                        put("Q14", v.q14.key)
                        put("Q18", v.q18)
                        put("venue", buildJsonObject { put("juniorSeats", v.juniorSeats.key) })
                    },
                )
            },
        )

    private fun inputOf(a: JsonObject): PlanInput {
        val reviewers =
            a["reviewers"]!!.jsonArray.map { it.jsonObject }.map { r ->
                Reviewer(
                    Member(r["who"]!!.jsonPrimitive.long, tier(r["tier"]!!), nominee = r["nominee"]!!.jsonPrimitive.boolean),
                    cap = r["cap"]!!.jsonPrimitive.int,
                    owedSixths = r["owed"]!!.jsonPrimitive.int,
                )
            }
        val papers =
            a["papers"]!!.jsonArray.map { it.jsonObject }.map { p ->
                PlanPaper(p["pid"]!!.jsonPrimitive.long, p["authors"]!!.jsonArray.map { it.jsonPrimitive.long })
            }
        val cands = a["cands"]!!.jsonArray.map { it.jsonArray }.map { Candidate(it[0].jsonPrimitive.long, it[1].jsonPrimitive.long, it[2].jsonPrimitive.int) }
        return PlanInput(reviewers, papers, cands)
    }

    @TestFactory
    fun `core's solve report matches the Lean report on the synthetic conference`(): List<DynamicTest> {
        assumeTrue(LiveOracle.available, "the Lean oracle is not built")
        val scale =
            buildJsonObject {
                put("papers", 150)
                put("areas", 5)
                put("seniors", 45)
                put("juniors", 30)
            }
        return variants.map { v ->
            DynamicTest.dynamicTest(v.name) {
                val a = ask(scale, v)
                val want = a["outcome"]!!.jsonObject
                val input = inputOf(a)
                val cfg = PlanConfig(v.q13, v.q14, Faults.NONE, cycleMaxK = 2, repairRounds = 10, topK = 25, juniorSeats = v.juniorSeats)
                val got = Planner.solve(input, cfg)

                fun w(k: String) = want[k]!!.jsonPrimitive.int
                assertEquals(w("composed"), got.composed, "papers that meet their composition")
                assertEquals(w("seniorShort"), got.seniorShort, "senior seats unfilled")
                assertEquals(w("thirdShort"), got.thirdShort, "other seats unfilled")
                assertEquals(w("loadViolations"), got.bandViolations.size, "load-band violations")
                // which of several equal-cost optima a solver finds is not fixed, so the split of reviews between nominees and
                // PC members may move by a review or two; the counts above and the objective may not
                val nomineeReviews = input.reviewers.filter { it.member.nominee }.sumOf { got.loads[it.who] ?: 0 }
                assertTrue(
                    kotlin.math.abs(w("nomineeReviews") - nomineeReviews) <= 3,
                    "reviews by nominees: ${w("nomineeReviews")} in the model, $nomineeReviews here",
                )
                assertEquals(w("cyclesFirst") > 0, got.cyclesFirst > 0, "reciprocal cycles in the first solve")
                // the first solve, before any repair, is one min-cost max-flow on the same network: the same flow value and cost
                val first = Planner.solve(input, cfg.copy(repairRounds = 0))
                assertEquals(want["firstFilled"]!!.jsonPrimitive.int, first.edges.size, "flow value of the first solve")
                assertEquals(want["firstObjective"]!!.jsonPrimitive.long, first.objective, "cost of the first solve")
                // after repair the forbidden edges depend on which optimum the first solve found, so the objective may drift a little
                val drift = kotlin.math.abs(want["objective"]!!.jsonPrimitive.long - got.objective)
                assertTrue(drift * 50 <= want["objective"]!!.jsonPrimitive.long, "objective ${want["objective"]} in the model, ${got.objective} here")
            }
        }
    }
}
