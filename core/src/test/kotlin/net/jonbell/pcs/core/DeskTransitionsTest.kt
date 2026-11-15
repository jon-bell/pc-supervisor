package net.jonbell.pcs.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import net.jonbell.pcs.core.readings.Q1
import net.jonbell.pcs.core.readings.Q2
import net.jonbell.pcs.core.readings.QId
import net.jonbell.pcs.core.readings.Readings
import net.jonbell.pcs.core.rules.DeskAct
import net.jonbell.pcs.core.rules.DeskFlow
import net.jonbell.pcs.core.rules.DeskReject
import net.jonbell.pcs.core.rules.DeskSt
import net.jonbell.pcs.core.rules.Faults
import net.jonbell.pcs.core.rules.Ground
import net.jonbell.pcs.core.rules.Opinion
import net.jonbell.pcs.core.rules.Referral
import net.jonbell.pcs.core.rules.Stage
import net.jonbell.pcs.core.rules.Tier
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files

/**
 * T3 at the level of `core`: every effective transition of the model's desk-reject subsystem (model/export/transitions-desk.json, under
 * both readings of Q1) is a transition of `DeskFlow` behind the policy's grants, every other (state, role, action) is refused, and the
 * properties S1, S2, S8, S9 and S10 are evaluated on every transition `core` takes. The end-to-end half is `RunnerTest`'s desk traces.
 */
@Family("T3")
class DeskTransitionsTest {
    private val persons = mapOf(2L to Opinion(2, isAc = true, tier = Tier.SENIOR), 3L to Opinion(3, tier = Tier.SENIOR), 4L to Opinion(4, tier = Tier.JUNIOR))

    /** `cured=false|disposition="in-review"|ground=null|now=0|opinions=[]|...` */
    private fun parse(obs: String): DeskSt {
        val kv = obs.split('|').associate { it.substringBefore('=') to it.substringAfter('=') }

        fun str(k: String) = kv.getValue(k).trim('"')
        val ground = str("ground").takeIf { it != "null" }?.let { Ground.ofKey(it)!! }
        val opinions = Json.parseToJsonElement(kv.getValue("opinions")).jsonArray.map { persons.getValue(it.jsonPrimitive.content.toLong()) }
        val due = str("remedy-due").takeIf { it != "null" }?.toLong()
        val disp = str("disposition")
        return DeskSt(
            ref =
                Referral(
                    ac = 1,
                    ground = ground ?: Ground.FORMAT,
                    opinions = opinions,
                    stage = Stage.ofKey(str("stage"))!!,
                    remedyOffered = due != null,
                    remedyDue = due ?: 0,
                    cured = str("cured") == "true",
                    warned = str("warned") == "true",
                    now = str("now").toLong(),
                ),
            referred = str("referred") == "true",
            removed = if (disp.startsWith("removed:")) Ground.ofKey(disp.removePrefix("removed:")) else null,
        )
    }

    private fun act(key: String, params: Map<String, String>): DeskAct =
        when (key) {
            "refer" -> DeskAct.Refer(Ground.ofKey(params.getValue("ground"))!!)
            "opinion" -> DeskAct.Opine(persons.getValue(params.getValue("who").toLong()))
            "offer-remedy" -> DeskAct.OfferRemedy
            "warn" -> DeskAct.Warn
            "cure" -> DeskAct.Cure
            "tick" -> DeskAct.Tick
            "advance" -> DeskAct.Advance
            "remove" -> DeskAct.Remove
            else -> error("unknown desk action $key")
        }

    private fun perm(key: String): String? =
        when (key) {
            "refer" -> "triage"
            "opinion" -> "second-opinion"
            "offer-remedy", "warn" -> "apply-writeback"
            "cure" -> "write-hotcrp"
            "remove" -> "remove"
            else -> null
        }

    private fun moveKey(role: String?, key: String, params: Map<String, String>) =
        "${role ?: "env"}|$key|" + params.toSortedMap().entries.joinToString(",") { "${it.key}=${it.value}" }

    private fun readingOf(tag: String): Readings {
        val traces = Json.parseToJsonElement(Files.readString(Repo.path("model/export/traces-desk.json"))).jsonArray.map { it.jsonObject }
        val r = traces.first { it["id"]!!.jsonPrimitive.content.startsWith("desk/$tag/") }["reading"]!!.jsonObject
        return r.entries.fold(Readings()) { acc, (q, v) -> acc.with(QId.ofCode(q)!!, v.jsonPrimitive.content)!! }.base()
    }

    private fun granted(): Set<Pair<String, String>> {
        val p = Json.parseToJsonElement(Files.readString(Repo.path("model/export/policy.json"))).jsonObject
        return p["byQ4"]!!.jsonArray[0].jsonObject["cells"]!!.jsonArray.map { it.jsonObject }
            .filter { it["cell"]!!.jsonObject["kind"]!!.jsonPrimitive.content == "granted" }
            .map { it["role"]!!.jsonPrimitive.content to it["perm"]!!.jsonPrimitive.content }.toSet()
    }

    private val roles = listOf("process-chair", "pc-chair", "ac", "junior-pc-chair", "pc-member", "nominee", "author", "pcs", "agent")

    /** Every (role, action) pair the model can try: acts with a permission are tried by every role, the others by the environment. */
    private fun moves(): List<Triple<String?, String, Map<String, String>>> {
        val acts =
            Ground.entries.map { "refer" to mapOf("ground" to it.key) } +
                persons.values.map {
                    "opinion" to
                        mapOf("who" to "${it.who}", "isAc" to "${it.isAc}", "tier" to (if (it.tier == Tier.SENIOR) "senior" else "junior"))
                } +
                listOf("offer-remedy", "warn", "cure", "tick", "advance", "remove").map { it to emptyMap() }
        return acts.flatMap { (k, p) -> if (perm(k) == null) listOf(Triple(null, k, p)) else roles.map { Triple(it, k, p) } }
    }

    @Test
    @Covers("prop:S1", "prop:S2", "prop:S8", "prop:S9", "prop:S10", "rule:may-remove")
    fun `every transition of the model is a transition of core, every other move is refused, and the properties hold on each`() {
        val doc = Json.parseToJsonElement(Files.readString(Repo.path("model/export/transitions-desk.json"))).jsonObject
        val grants = granted()
        val failures = mutableMapOf<String, MutableList<String>>()

        fun fail(prop: String, msg: String) {
            failures.getOrPut(prop) { mutableListOf() }.let { if (it.size < 3) it += msg }
        }
        val windows = mutableSetOf<Long>()
        var steps = 0
        var refusals = 0
        var removals = 0
        for (reading in doc["readings"]!!.jsonArray.map { it.jsonObject }) {
            val r = readingOf(reading["reading"]!!.jsonPrimitive.content)
            val window = reading["remedyWindowH"]!!.jsonPrimitive.long
            windows += window
            val states = reading["states"]!!.jsonArray.map { parse(it.jsonPrimitive.content) }
            val effective =
                reading["transitions"]!!.jsonArray.map { it.jsonArray }.groupBy { it[0].jsonPrimitive.content.toInt() }
                    .mapValues { (_, ts) -> ts.associate { it[1].jsonPrimitive.content to it[2].jsonPrimitive.content.toInt() } }
            val all = moves()
            for ((i, s) in states.withIndex()) {
                for ((role, key, params) in all) {
                    val p = perm(key)
                    val allowed = p == null || (role!! to p) in grants
                    val a = act(key, params)
                    val got = if (allowed) DeskFlow.rule(Faults.NONE, r, s, role, a, window) else null
                    val want = effective[i]?.get(moveKey(role, key, params))?.let { states[it] }
                    steps++
                    if (want == null) refusals++
                    if (got != want) {
                        fail("prop:S1", "${reading["reading"]} state $i ${role ?: "env"} $key $params: core ${got != null}, model ${want != null}")
                        continue
                    }
                    if (got == null || got.removed == null || s.removed != null) continue
                    removals++
                    // S1: no single person removes a paper: a chair acts on an AC's referral and another person's agreement (Q2 permitting)
                    val others = s.ref.opinions.filter { it.who != s.ref.ac && !it.conflicted && it.agrees }
                    if (role != "pc-chair" || !s.referred || (r.q2 != Q2.AC_ALONE && others.isEmpty())) fail("prop:S1", "removal by $role in state $i")
                    // S2: a removal names the ground the AC referred on, and that ground is one the readings admit
                    if (got.removed != s.ref.ground ||
                        !DeskReject.groundAdmissible(r.q6!!, r.q10!!, s.ref)
                    ) {
                        fail("prop:S2", "removal on ${got.removed} in state $i")
                    }
                    // S8: silence keeps: no removal without an opinion (Q2 permitting), whatever time has passed
                    if (r.q2 != Q2.AC_ALONE && s.ref.opinions.isEmpty()) fail("prop:S8", "removal with no opinion in state $i")
                    // S9: only a ground and stage Q3 allows
                    if (!DeskReject.stageAllowed(r.q3!!, s.ref.ground, s.ref.stage)) fail("prop:S9", "removal at ${s.ref.stage} in state $i")
                    // S10: a remedy is honored: an anonymity removal under the fix window needs the window offered, over, and not cured
                    if (s.ref.ground == Ground.ANONYMITY &&
                        r.q1 == Q1.FIX_WINDOW &&
                        !(s.ref.remedyOffered && s.ref.now > s.ref.remedyDue && !s.ref.cured)
                    ) {
                        fail("prop:S10", "removal inside the fix window in state $i")
                    }
                }
                // S8 on the state itself: tick and advance never remove
                for (k in listOf("tick", "advance")) {
                    DeskFlow.rule(Faults.NONE, r, s, null, act(k, emptyMap()), window)?.let {
                        if (it.removed !=
                            s.removed
                        ) {
                            fail("prop:S8", "$k removed in state $i")
                        }
                    }
                }
            }
        }
        assertTrue(windows.size >= 3 && 72L in windows, "the table is exported under several fix-window lengths: $windows")
        assertTrue(steps > 50_000 && refusals > 0 && removals > 0, "$steps steps checked, $removals removals")
        assertEquals(emptyMap<String, List<String>>(), failures)
    }
}
