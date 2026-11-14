package pcs.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import pcs.core.readings.Readings
import pcs.core.rules.Accountability
import pcs.core.rules.ERCase
import pcs.core.rules.EarlyReject
import pcs.core.rules.Faults
import pcs.core.rules.Member
import pcs.core.rules.Nominations
import pcs.core.rules.Nominee
import pcs.core.rules.PaperFacts
import pcs.core.rules.PaperNoms
import pcs.core.rules.Pc
import pcs.core.rules.ReqDisposition
import pcs.core.rules.Request
import pcs.core.rules.Score
import pcs.core.rules.Tier
import pcs.testing.Covers
import pcs.testing.Family
import java.nio.file.Files

/** T2 (PLAN §A5) for the rules beyond may-remove: each Kotlin rule against the Lean model's corpus, mutants included. */
@Family("T2")
class RulesDifferentialTest {
    private fun corpus(rule: String): List<Pair<JsonObject, JsonElement>> =
        Files.readAllLines(Repo.path("model/export/oracle-$rule.jsonl")).map { line ->
            val o = Json.parseToJsonElement(line).jsonObject
            o["query"]!!.jsonObject to o["answer"]!!.jsonObject["result"]!!
        }

    private fun JsonObject.b(k: String, d: Boolean = false) = (this[k] as? JsonPrimitive)?.booleanOrNull ?: d

    private fun JsonObject.l(k: String) = (this[k] as? JsonPrimitive)?.longOrNull ?: 0L

    private fun JsonObject.ids(k: String) = (this[k] as? JsonArray).orEmpty().map { it.jsonPrimitive.long }

    private fun JsonObject.arr(k: String) = (this[k] as? JsonArray).orEmpty().map { it.jsonObject }

    private fun JsonObject.tier(k: String) =
        when ((this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content) {
            "senior" -> Tier.SENIOR
            "junior" -> Tier.JUNIOR
            else -> null
        }

    private fun readings(q: JsonObject): Readings = OracleJson.readings(q["reading"]!!.jsonObject)

    private fun faults(q: JsonObject): Faults = OracleJson.faults(q["mutant"])

    private fun <T> check(rule: String, expected: (JsonElement) -> T, got: (JsonObject) -> T) {
        val cases = corpus(rule)
        assertTrue(cases.size >= 1000)
        val bad = cases.filter { (q, a) -> got(q) != expected(a) }.map { it.first.toString() }
        assertEquals(emptyList<String>(), bad.take(3), "${bad.size} of ${cases.size} $rule cases disagree with the model")
    }

    @Test
    @Covers("rule:composition")
    fun composition() =
        check("composition", { it.jsonPrimitive.booleanOrNull }) { q ->
            val r = readings(q)
            Pc.compositionOk(r.q13!!, r.q14!!, q.arr("seats").map { s -> Member(s.l("who"), s.tier("tier"), nominee = s.b("nominee")) })
        }

    @Test
    @Covers("rule:owes")
    fun owes() =
        check("owes", { if (it is JsonNull) null else it.jsonPrimitive.intOrNull }) { q ->
            val r = readings(q)
            val papers =
                q.arr("papers").map { p ->
                    PaperNoms(p.l("paper"), p.arr("nominees").map { n -> Nominee(n.l("who"), n.l("share").toInt(), n.b("accepted", true)) })
                }
            Nominations.owes(faults(q), r.q18!!, r.q19!!, r.q19b!!, q.tier("tier") ?: Tier.JUNIOR, papers, q.l("u"))
        }

    @Test
    @Covers("rule:eligible")
    fun eligible() =
        check("eligible", { it.jsonPrimitive.booleanOrNull }) { q ->
            val m = q["member"]!!.jsonObject
            val pf = PaperFacts(authors = q.ids("authors"), conflicts = q.ids("conflicts"))
            Pc.eligible(
                faults(q),
                Member(m.l("who"), m.tier("tier"), nominee = m.b("nominee"), accepted = m.b("accepted", true), consented = m.b("consented", true)),
                pf,
            )
        }

    @Test
    @Covers("rule:compliance")
    fun compliance() =
        check("compliance", { it.jsonPrimitive.content }) { q ->
            val p = q["paper"]!!.jsonObject
            val pn = PaperNoms(p.l("paper"), p.arr("nominees").map { n -> Nominee(n.l("who"), n.l("share").toInt(), n.b("accepted", true)) })
            Nominations.compliance(readings(q).q8!!, pn, q.ids("registered").toSet()).key
        }

    @Test
    @Covers("rule:compliance", "prop:V3")
    fun `nomination pattern (a signal, Q9)`() =
        check("pattern", { it.jsonPrimitive.booleanOrNull }) { q ->
            Nominations.nominationPattern(q.l("author"), q.tier("tier"), q.arr("noms").map { it.l("who") to it.tier("tier") })
        }

    @Test
    @Covers("q:Q17=9")
    fun `papers over the cap (Q17)`() =
        check("overCap", { it.jsonPrimitive.intOrNull }) { q ->
            Nominations.papersOverCap(readings(q).q17!!, q.l("papers").toInt())
        }

    @Test
    @Covers("rule:may-remove")
    fun `early reject (the early-reject half of may-remove)`() =
        check("earlyReject", { it.jsonPrimitive.booleanOrNull }) { q ->
            val r = readings(q)
            val scores = (q["scores"] as JsonArray).map { Score.valueOf(it.jsonPrimitive.content.uppercase().replace('-', '_')) }
            EarlyReject.mayEarlyReject(faults(q), r.q15!!, r.q16!!, ERCase(scores, q.b("bumped"), q.b("windowClosed"), q.b("acObjects")))
        }

    @Test
    @Covers("prop:AR6")
    fun `case may open (AR6)`() =
        check("caseMayOpen", { it.jsonPrimitive.booleanOrNull }) { q ->
            val reqs =
                q.arr("requests").map { x ->
                    Request(
                        reviewer = x.l("reviewer"),
                        sentBy = (x["sentBy"] as? JsonPrimitive)?.longOrNull,
                        disp = (x["disp"] as? JsonPrimitive)?.takeIf { it.isString }?.content?.let { ReqDisposition.valueOf(it.uppercase().replace('-', '_')) },
                    )
                }
            Accountability.caseMayOpen(faults(q), readings(q).q20!!, q.b("missingReview"), reqs)
        }
}
