package pcs.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assumptions
import org.junit.jupiter.api.DynamicTest
import org.junit.jupiter.api.TestFactory
import pcs.core.readings.Q1
import pcs.core.readings.Q5
import pcs.core.readings.QId
import pcs.core.readings.Readings
import pcs.core.rules.DeskReject
import pcs.core.rules.Faults
import pcs.core.rules.Ground
import pcs.core.rules.Opinion
import pcs.core.rules.Referral
import pcs.core.rules.Stage
import pcs.core.rules.Tier
import pcs.testing.CoversLog
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
        yesNo(DeskReject.mayRemove(Faults.NONE, r, ref), "may be desk rejected", "stays in review")

    /** Card id → its outcome under a reading, rendered as the model renders it. */
    private val implemented: Map<String, (Readings) -> String> = mapOf(
        "X1" to { r ->
            val g = refAt(Ground.NOMINATION_NONCOMPLIANCE, Stage.SCREENING).copy(warned = false)
            "before any warning: ${removable(r, g)}; after a warning that is ignored: ${removable(r, g.copy(warned = true))}"
        },
        "E3" to { r ->
            val ref = refAt(Ground.ANONYMITY, Stage.SCREENING).copy(remedyOffered = false)
            "${yesNo(DeskReject.acMayKeep(r.q1 ?: Q1.entries.first(), Ground.ANONYMITY), "the AC may keep it", "the AC may not keep it")}; if referred, ${removable(r, ref)}"
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
    )

    @TestFactory
    fun cards(): List<DynamicTest> {
        val cards = Json.parseToJsonElement(Files.readString(Repo.path("model/export/cards.json"))).jsonArray
        return cards.flatMap { c ->
            val id = c.jsonObject["id"]!!.jsonPrimitive.content
            c.jsonObject["cases"]!!.jsonArray.map { case ->
                val reading = case.jsonObject["reading"]!!.jsonObject
                val expected = case.jsonObject["outcome"]!!.jsonPrimitive.content
                val label = reading.entries.joinToString(", ") { "${it.key}=${it.value.jsonPrimitive.content}" }
                DynamicTest.dynamicTest("card $id [$label]") {
                    val eval = implemented[id]
                    if (eval == null) {
                        CoversLog.record("card:$id [$label]", "card:$id", "not-implemented", "T1")
                        Assumptions.abort<Unit>("card $id: not implemented yet")
                    }
                    val r = readingOf(reading)
                    val outcome = try {
                        eval!!(r)
                    } catch (e: Throwable) {
                        CoversLog.record("card:$id [$label]", "card:$id", "fail", "T1"); throw e
                    }
                    val pass = outcome == expected
                    CoversLog.record("card:$id [$label]", "card:$id", if (pass) "pass" else "fail", "T1")
                    reading.forEach { (q, v) -> CoversLog.record("card:$id [$label]", "q:$q=${v.jsonPrimitive.content}", if (pass) "pass" else "fail", "T1") }
                    assertEquals(expected, outcome, "card $id under $label")
                }
            }
        }
    }

    /** The model evaluates cards at `{}` with the card's readings set: unset questions take their first reading. */
    private fun readingOf(o: JsonObject): Readings =
        o.entries.fold(Readings()) { r, (q, v) -> r.with(QId.ofCode(q)!!, v.jsonPrimitive.content)!! }.base()
}
