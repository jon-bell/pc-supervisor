package pcs.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import pcs.core.readings.Q20
import pcs.core.rules.AccAct
import pcs.core.rules.AccFlow
import pcs.core.rules.AccSt
import pcs.core.rules.Accountability
import pcs.core.rules.Faults
import pcs.core.rules.ReqDisposition
import pcs.core.rules.Request
import pcs.core.rules.Suggestion
import pcs.testing.Covers
import pcs.testing.Family
import java.nio.file.Files

/**
 * T3 at the level of `core`: every effective transition of the model's accountability subsystem (model/export/transitions-acc.json,
 * under both readings of Q20), and every refusal, against `AccFlow`'s guards behind the policy's grants. Each model property is
 * then evaluated on every transition `core` takes. The end-to-end half is `RunnerTest`'s accountability traces.
 */
@Family("T3")
class AccountabilityTransitionsTest {
    private val dispCodes =
        mapOf(
            1 to ReqDisposition.REVISED,
            2 to ReqDisposition.EXPLAINED,
            3 to ReqDisposition.DECLINED,
            4 to ReqDisposition.NO_REPLY,
            5 to ReqDisposition.DISPUTED,
        )

    private fun state(v: List<Int>): AccSt =
        AccSt(
            criteria = v[0] == 1,
            suggested = v[1] == 1,
            dismissed = v[2] == 1,
            coached = v[3] == 1,
            req =
                if (v[4] == 1) {
                    Request(
                        7,
                        sentBy = v[5].toLong().takeIf { it != 0L },
                        due = v[6].toLong(),
                        remindedAt = v[7].toLong().takeIf { it >= 0 },
                        replied =
                            v[8] == 1,
                        disp = dispCodes[v[9]],
                    )
                } else {
                    null
                },
            now = v[10].toLong(),
            caseOpen = v[11] == 1,
            upheld = v[12] == 1,
        )

    private fun act(o: JsonObject): AccAct {
        val a = o["action"]!!.jsonObject
        val key = a["key"]!!.jsonPrimitive.content
        return when (key) {
            "set-criteria" -> AccAct.SetCriteria
            "suggest" -> AccAct.Suggest
            "dismiss" -> AccAct.Dismiss
            "coach" -> AccAct.Coach
            "send" -> AccAct.Send
            "remind" -> AccAct.Remind
            "reply" -> AccAct.Reply
            "tick" -> AccAct.Tick
            "open-case" -> AccAct.OpenCase
            "uphold" -> AccAct.Uphold
            "dispose" ->
                AccAct.Dispose(
                    when (val d = a["params"]!!.jsonObject["disposition"]!!.jsonPrimitive.content) {
                        "revised" -> ReqDisposition.REVISED
                        "explained" -> ReqDisposition.EXPLAINED
                        "declined" -> ReqDisposition.DECLINED
                        "no-reply" -> ReqDisposition.NO_REPLY
                        else -> error("unknown disposition $d")
                    },
                )
            else -> error("unknown action $key")
        }
    }

    private fun perm(a: AccAct): String? =
        when (a) {
            AccAct.SetCriteria -> "set-criteria"
            AccAct.Suggest, AccAct.Dismiss -> "suggest-request"
            AccAct.Coach -> "coach"
            AccAct.Send, AccAct.Remind, is AccAct.Dispose -> "send-request"
            AccAct.Reply -> "write-hotcrp"
            AccAct.Tick -> null
            AccAct.OpenCase, AccAct.Uphold -> "open-case"
        }

    @Test
    @Covers("prop:AR1", "prop:AR2", "prop:AR4", "prop:AR5", "prop:AR6", "prop:V4")
    fun `every transition of the model is a transition of core, and every property holds on each`() {
        val doc = Json.parseToJsonElement(Files.readString(Repo.path("model/export/transitions-acc.json"))).jsonObject
        val failures = mutableMapOf<String, MutableList<String>>()

        fun fail(prop: String, msg: String) {
            failures.getOrPut(prop) { mutableListOf() }.let { if (it.size < 3) it += msg }
        }
        var steps = 0
        var refusals = 0
        for (reading in doc["readings"]!!.jsonArray.map { it.jsonObject }) {
            val grace = reading["graceH"]!!.jsonPrimitive.content.toLong()
            val q20 = if (reading["q20"]!!.jsonPrimitive.content == "yes") Q20.YES else Q20.NO
            val table = reading["table"]!!.jsonObject
            val states = table["states"]!!.jsonArray.map { s -> state((s as JsonArray).map { it.jsonPrimitive.content.toInt() }) }
            val moves = table["moves"]!!.jsonArray.map { it.jsonObject }
            val roles = moves.map { it["role"]!!.let { r -> if (r is kotlinx.serialization.json.JsonNull) null else r.jsonPrimitive.content } }
            val acts = moves.map(::act)
            val granted = table["granted"]!!.jsonArray.map { it.jsonArray[0].jsonPrimitive.content to it.jsonArray[1].jsonPrimitive.content }.toSet()
            val model = table["transitions"]!!.jsonArray.map { t -> t.jsonArray.map { it.jsonPrimitive.content.toInt() } }
            val effective = model.groupBy { it[0] }.mapValues { (_, ts) -> ts.associate { it[1] to it[2] } }
            val sendRoles = granted.filter { it.second == "send-request" }.map { it.first }.toSet()
            for ((i, s) in states.withIndex()) {
                // AR4, on every state: suggestions (dismissed or not) never change the engagement record
                val withSug = Accountability.engagement(Faults.NONE, listOfNotNull(s.req), listOf(Suggestion(7, dismissed = s.dismissed)), 7)
                if (withSug != Accountability.engagement(Faults.NONE, listOfNotNull(s.req), emptyList(), 7)) fail("prop:AR4", "state $i")
                for (mi in moves.indices) {
                    val role = roles[mi]
                    val a = acts[mi]
                    val p = perm(a)
                    val allowed = p == null || (role != null && (role to p) in granted)
                    val got = if (allowed) AccFlow.rule(Faults.NONE, q20, s, role, a, grace) else null
                    val want = effective[i]?.get(mi)?.let { states[it] }
                    steps++
                    if (want == null) refusals++
                    if (got != want) {
                        fail("prop:AR1", "$q20 state $i ${role ?: "env"} $a: core ${got != null}, model ${want != null}")
                        continue
                    }
                    if (got == null) continue
                    // AR1: a request is sent only once the PC chairs have set the criteria list
                    if (s.req == null && got.req != null && !s.criteria) fail("prop:AR1", "sent without criteria in state $i")
                    // AR2: a request exists, and a disposition is recorded, only by a role holding the send cell
                    if ((s.req == null && got.req != null) ||
                        s.req?.disp != got.req?.disp
                    ) {
                        if (role !in sendRoles) {
                            fail("prop:AR2", "$role changed a request in state $i")
                        }
                    }
                    // AR5: "no reply" only after a reminder and the due date plus the grace period
                    if (got.req?.disp == ReqDisposition.NO_REPLY && s.req?.disp == null) {
                        val q = s.req!!
                        if (q.remindedAt == null || s.now <= q.due + grace) fail("prop:AR5", "no reply in state $i")
                    }
                    // AR6 (under Q20 = yes): a quality case follows a request disposed declined or no reply
                    if (q20 == Q20.YES && !s.caseOpen && got.caseOpen && s.req?.disp?.notEngaged != true) fail("prop:AR6", "case in state $i")
                    // V4: only the PCS or the process chair opens a case, only a PC chair upholds it, and only an open one
                    if (!s.caseOpen && got.caseOpen && role !in setOf("pcs", "process-chair")) fail("prop:V4", "$role opened a case")
                    if (!s.upheld && got.upheld && (role != "pc-chair" || !s.caseOpen)) fail("prop:V4", "$role upheld in state $i")
                }
            }
        }
        assertTrue(steps > 1_000_000 && refusals > 0, "$steps steps checked")
        assertEquals(emptyMap<String, List<String>>(), failures)
    }
}
