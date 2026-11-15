package net.jonbell.pcs.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import net.jonbell.pcs.core.readings.Readings
import net.jonbell.pcs.core.rules.Accountability
import net.jonbell.pcs.core.rules.DeskReject
import net.jonbell.pcs.core.rules.ERCase
import net.jonbell.pcs.core.rules.EarlyReject
import net.jonbell.pcs.core.rules.Faults
import net.jonbell.pcs.core.rules.Member
import net.jonbell.pcs.core.rules.Nominations
import net.jonbell.pcs.core.rules.Nominee
import net.jonbell.pcs.core.rules.PaperFacts
import net.jonbell.pcs.core.rules.PaperNoms
import net.jonbell.pcs.core.rules.Pc
import net.jonbell.pcs.core.rules.ReqDisposition
import net.jonbell.pcs.core.rules.Request
import net.jonbell.pcs.core.rules.Score
import net.jonbell.pcs.core.rules.Share
import net.jonbell.pcs.core.rules.Tier
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import kotlin.math.sqrt
import kotlin.random.Random

/**
 * PLAN §A9, first report (M19): the residual-risk estimate for the random family T2, in the style of STADS (Böhme, TOSEM 2018),
 * calibrated against held-out specification mutants. It writes `build/residual-risk/residual-risk.md` and `.json`, which the assurance
 * report links. Method, in short:
 *
 * - Sampling units are the inputs of the Lean model's corpus generator (`model/export/oracle-*.jsonl`, 18,800 inputs over 13 rules),
 *   taken as the T2 generator. Each unit is run through `core` signed and under each of the ten specification mutants.
 * - A species is (rule, signed output, kill signature over the TUNED mutants). A unit that no mutant touches is a species by its output
 *   alone; one that a tuned mutant changes is a different species from one that none does. So a species is a behaviour class the
 *   mutant family can tell apart, and a rare class stays rare.
 * - The estimate is Good-Turing: the probability that the next unit of a rule is a species none of the previous n produced is f1 / n
 *   (f1 = species seen exactly once), with an upper bound f1 + 1.645 sqrt(f1 + 1) over n.
 * - Calibration, two ways. (1) Campaigns: n units drawn from a rule's units, the rest as the "next runs": the estimate against the realised
 *   share of the rest that is a new species. (2) Held-out mutants: the mutants are split into tuned and held-out sets (alternating, in the
 *   model's order, among those the T2 corpus can kill at all); a held-out mutant that survives a campaign has a per-unit detection rate
 *   p (measured on the whole corpus), and the bound should cover it: p <= upper bound.
 * - Limits: it covers only what the generator can produce; mutants that no unit kills are listed as generator-blind, not scored. It is
 *   no statement about an attacker who searches (only the proofs in `model/` hold against one). T3 (witness traces, not sampled) and
 *   T4 (not built) have no sampling generator yet, so they get no estimate.
 */
@Family("T2")
@Covers("rule:may-remove")
class ResidualRiskTest {
    private val rules =
        listOf(
            "mayRemove",
            "earlyReject",
            "eligible",
            "owes",
            "compliance",
            "pattern",
            "composition",
            "caseMayOpen",
            "caseListing",
            "mayDispose",
            "appointmentAuthority",
            "overCap",
        )

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

    private fun noms(p: JsonObject) = PaperNoms(p.l("paper"), p.arr("nominees").map { n -> Nominee(n.l("who"), n.l("share").toInt(), n.b("accepted", true)) })

    /** The rule's output on a query, as a string, under the faults. */
    private fun eval(rule: String, q: JsonObject, f: Faults): String {
        val r: Readings by lazy { OracleJson.readings(q["reading"]!!.jsonObject) }
        return when (rule) {
            "mayRemove" -> DeskReject.mayRemove(f, r, OracleJson.referral(q["referral"]!!.jsonObject)).toString()
            "earlyReject" ->
                EarlyReject.mayEarlyReject(
                    f,
                    r.q15!!,
                    r.q16!!,
                    ERCase(
                        (q["scores"] as JsonArray).map {
                            Score.valueOf(it.jsonPrimitive.content.uppercase().replace('-', '_'))
                        },
                        q.b("bumped"),
                        q.b("windowClosed"),
                        q.b("acObjects"),
                    ),
                ).toString()
            "eligible" -> {
                val m = q["member"]!!.jsonObject
                Pc.eligible(
                    f,
                    Member(m.l("who"), m.tier("tier"), nominee = m.b("nominee"), accepted = m.b("accepted", true), consented = m.b("consented", true)),
                    PaperFacts(authors = q.ids("authors"), conflicts = q.ids("conflicts")),
                ).toString()
            }
            "owes" ->
                Nominations.owes(f, r.q18!!, r.q19!!, r.q19b!!, q.tier("tier") ?: Tier.JUNIOR, q.arr("papers").map { noms(it) }, q.l("u")).toString()
            "compliance" ->
                Nominations.compliance(
                    r.q8!!,
                    noms(q["paper"]!!.jsonObject),
                    q.ids("registered").toSet(),
                    OracleJson.venue(q["reading"]!!.jsonObject["venue"]).nomineesMax,
                ).key
            "pattern" ->
                Nominations.nominationPattern(
                    q.l("author"),
                    q.tier("tier"),
                    q.arr("noms").map {
                        it.l("who") to it.tier("tier")
                    },
                    OracleJson.venue(q["venue"]).patternMin,
                ).toString()
            "composition" ->
                Pc.compositionOk(r.q13!!, r.q14!!, q.arr("seats").map { s -> Member(s.l("who"), s.tier("tier"), nominee = s.b("nominee")) }).toString()
            "caseMayOpen" ->
                Accountability.caseMayOpen(
                    f,
                    r.q20!!,
                    q.b("missingReview"),
                    q.arr("requests").map { x ->
                        Request(
                            reviewer = x.l("reviewer"),
                            sentBy = (x["sentBy"] as? JsonPrimitive)?.longOrNull,
                            disp =
                                (x["disp"] as? JsonPrimitive)?.takeIf {
                                    it.isString
                                }?.content?.let { ReqDisposition.valueOf(it.uppercase().replace('-', '_')) },
                        )
                    },
                ).toString()
            "caseListing" -> {
                val shares = q.arr("shares").map { Share(it.l("paper"), it.l("owed").toInt(), it.l("done").toInt()) }
                buildJsonObject {
                    put("cases", Accountability.casesFor(shares))
                    put("papers", JsonArray(Accountability.unmetPapers(shares).map { JsonPrimitive(it) }))
                }.toString()
            }
            "mayDispose" -> {
                val x = q["request"]!!.jsonObject
                val req = Request(5, sentBy = 1, due = x.l("due"), remindedAt = (x["remindedAt"] as? JsonPrimitive)?.longOrNull, replied = x.b("replied"))
                val d = ReqDisposition.valueOf(q["disp"]!!.jsonPrimitive.content.uppercase().replace('-', '_'))
                Accountability.mayDispose(req, d, q.l("now"), OracleJson.venue(q["reading"]!!.jsonObject["venue"]).accGraceH).toString()
            }
            "appointmentAuthority" ->
                Nominations.decisionCounts(
                    (q["nominating"] as JsonArray).map { l -> (l as JsonArray).map { it.jsonPrimitive.long }.toSet() },
                    q.ids("acs").toSet(),
                    q.l("decider"),
                    q.b("isChair"),
                ).toString()
            "overCap" -> Nominations.papersOverCap(r.q17!!, q.l("papers").toInt()).toString()
            else -> error(rule)
        }
    }

    private class Unit(val rule: String, val signed: String, val killedBy: Set<Int>)

    private fun units(): Map<String, List<Unit>> =
        rules.associateWith { rule ->
            Files.readAllLines(Repo.path("model/export/oracle-$rule.jsonl")).map { line ->
                val q = Json.parseToJsonElement(line).jsonObject["query"]!!.jsonObject
                val signed = eval(rule, q, Faults.NONE)
                // the corpus names a mutant on some queries; the signed run is the reference whatever it says
                Unit(rule, signed, Faults.MUTANTS.indices.filter { i -> eval(rule, q, Faults.MUTANTS[i]) != signed }.toSet())
            }
        }

    private class Estimate(val n: Int, val f1: Int, val f2: Int, val species: Int) {
        val h: Double get() = f1.toDouble() / n
        val upper: Double get() = (f1 + 1.645 * sqrt(f1 + 1.0)) / n

        /** The rule of three: a fault that n independent units never hit has a per-unit detection rate of at most 3 / n, at 95%. */
        val unhit: Double get() = 3.0 / n

        /** What the report states as the residual risk: the larger of the novelty bound and the unhit-fault bound. */
        val risk: Double get() = maxOf(upper, unhit)

        /** Chao1: the expected number of species not yet seen. */
        val unseen: Double get() = if (f2 > 0) (n - 1.0) / n * f1 * f1 / (2.0 * f2) else (n - 1.0) / n * f1 * (f1 - 1) / 2.0
    }

    private fun estimate(sample: List<String>): Estimate {
        val c = sample.groupingBy { it }.eachCount()
        return Estimate(sample.size, c.values.count { it == 1 }, c.values.count { it == 2 }, c.size)
    }

    @Test
    fun `residual risk of T2, calibrated against held-out specification mutants`() {
        val all = units()
        val killable = Faults.MUTANTS.indices.filter { m -> all.values.any { us -> us.any { m in it.killedBy } } }
        val tuned = killable.filterIndexed { i, _ -> i % 2 == 0 }.toSet()
        val heldOut = killable.filterIndexed { i, _ -> i % 2 == 1 }.toSet()
        val blind = Faults.MUTANTS.indices.filter { it !in killable }

        fun species(u: Unit) = "${u.rule}|${u.signed}|${(u.killedBy intersect tuned).sorted()}"
        // a held-out mutant lives in one rule: the rule whose units it changes
        val ruleOf = heldOut.associateWith { m -> all.entries.first { (_, us) -> us.any { m in it.killedBy } }.key }
        val rate = heldOut.associateWith { m -> all.getValue(ruleOf.getValue(m)).count { m in it.killedBy }.toDouble() / all.getValue(ruleOf.getValue(m)).size }

        val md = StringBuilder()
        md.appendLine("# Residual risk of the random test family T2 (PLAN §A9, first report)")
        md.appendLine()
        md.appendLine(
            "Method: STADS-style. Units are the ${all.values.sumOf {
                it.size
            }} inputs of the Lean corpus generator (the T2 generator), each run through `core` signed and under each of the ten specification mutants. A species is (rule, signed output, kill signature over the tuned mutants). The estimate is Good-Turing: the chance that the next unit of a rule is a species none of the first n produced is f1 / n, with the upper bound (f1 + 1.645 sqrt(f1 + 1)) / n. Limits: it covers only what the generator produces; it says nothing about an attacker who searches; T3 (witness traces, not sampled) and T4 (not built) have no sampling generator and get no estimate.",
        )
        md.appendLine()
        md.appendLine(
            "Mutants the T2 corpus can kill: ${killable.joinToString {
                "#$it"
            }}. Tuned set: ${tuned.sorted().joinToString {
                "#$it"
            }}. Held out: ${heldOut.sorted().joinToString { "#$it" }}. Generator-blind (no unit kills them; T3/T5/T6 must): ${blind.joinToString { "#$it" }}.",
        )
        md.appendLine()
        md.appendLine("## The estimate for the current generator (all units of each rule)")
        md.appendLine()
        md.appendLine(
            "| Rule | Units n | Species | Seen once (f1) | Seen twice (f2) | P(next unit is new) | Upper bound | Chao1 unseen species | 3 / n | Stated residual risk |",
        )
        md.appendLine("|---|---|---|---|---|---|---|---|---|---|")
        val current = linkedMapOf<String, Estimate>()
        for ((rule, us) in all) {
            val e = estimate(us.map(::species))
            current[rule] = e
            md.appendLine(
                "| $rule | ${e.n} | ${e.species} | ${e.f1} | ${e.f2} | ${"%.4f".format(
                    e.h,
                )} | ${"%.4f".format(e.upper)} | ${"%.1f".format(e.unseen)} | ${"%.4f".format(e.unhit)} | ${"%.4f".format(e.risk)} |",
            )
        }
        val rng = Random(20301)

        md.appendLine()
        md.appendLine("## Calibration 1: does f1 / n predict the next unit's novelty?")
        md.appendLine()
        md.appendLine(
            "300 campaigns per (rule, n): n units drawn without replacement, the other units of the rule as the next runs. Realised = the share of the others whose species the campaign never produced.",
        )
        md.appendLine()
        md.appendLine("| n | Mean estimate | Mean realised | Mean estimate / realised | Campaigns where realised <= upper bound |")
        md.appendLine("|---|---|---|---|---|")
        val calib = linkedMapOf<Int, List<Double>>()
        for (n in listOf(100, 300, 1000)) {
            var sumH = 0.0
            var sumReal = 0.0
            var covered = 0
            var total = 0
            for ((_, us) in all) {
                if (us.size <= n + 200) continue
                val sp = us.map(::species)
                repeat(300) {
                    val idx = sp.indices.shuffled(rng)
                    val seen = idx.take(n).map { sp[it] }
                    val e = estimate(seen)
                    val have = seen.toSet()
                    val rest = idx.drop(n)
                    val real = rest.count { sp[it] !in have }.toDouble() / rest.size
                    sumH += e.h
                    sumReal += real
                    if (real <= e.upper) covered++
                    total++
                }
            }
            calib[n] = listOf(sumH / total, sumReal / total, covered.toDouble() / total)
            md.appendLine(
                "| $n | ${"%.4f".format(sumH / total)} | ${"%.4f".format(sumReal / total)} | ${"%.2f".format(sumH / sumReal)} | ${"%.1f".format(
                    100.0 * covered / total,
                )}% |",
            )
        }

        md.appendLine()
        md.appendLine("## Calibration 2: held-out mutants that survive a campaign")
        md.appendLine()
        md.appendLine(
            "For each held-out mutant, its rule's units are sampled in campaigns of n; where the mutant survives (no sampled unit kills it) its true per-unit detection rate p, from all the rule's units, is compared with the campaign's upper bound.",
        )
        md.appendLine()
        md.appendLine(
            "| Mutant | Rule | Detection rate p | n | Survived campaigns | p <= novelty upper bound | p <= reported risk (max with 3 / n) | False assurance (survived, p above the reported risk) |",
        )
        md.appendLine("|---|---|---|---|---|---|---|---|")
        var coveredAll = 0
        var coveredRisk = 0
        var rows = 0
        var survivedAll = 0
        for (m in heldOut.sorted()) {
            val us = all.getValue(ruleOf.getValue(m))
            val sp = us.map(::species)
            for (n in listOf(30, 100, 300)) {
                var survived = 0
                var covered = 0
                var coveredR = 0
                repeat(300) {
                    val idx = sp.indices.shuffled(rng).take(n)
                    if (idx.none { m in us[it].killedBy }) {
                        survived++
                        val e = estimate(idx.map { sp[it] })
                        if (rate.getValue(m) <= e.upper) covered++
                        if (rate.getValue(m) <= e.risk) coveredR++
                    }
                }
                coveredAll += covered
                coveredRisk += coveredR
                survivedAll += survived
                val rule = ruleOf.getValue(m)
                val p = "%.4f".format(rate.getValue(m))
                val c1 = if (survived == 0) "-" else "$covered of $survived"
                val c2 = if (survived == 0) "-" else "$coveredR of $survived"
                md.appendLine("| #$m | $rule | $p | $n | $survived of 300 | $c1 | $c2 | ${"%.1f".format(100.0 * (survived - coveredR) / 300)}% |")
                rows++
            }
        }
        val pct1 = if (survivedAll > 0) " (${"%.1f".format(100.0 * coveredAll / survivedAll)}%)" else ""
        val pct2 = if (survivedAll > 0) " (${"%.1f".format(100.0 * coveredRisk / survivedAll)}%)" else ""
        md.appendLine()
        md.appendLine("Survivors covered by the novelty upper bound: $coveredAll of $survivedAll$pct1.")
        md.appendLine()
        md.appendLine("Survivors covered by the reported risk: $coveredRisk of $survivedAll$pct2.")
        val falseAssurance = (survivedAll - coveredRisk).toDouble() / (300 * rows)
        md.appendLine()
        md.appendLine(
            "False-assurance rate over all ${300 * rows} campaigns (the mutant survived and its true rate is above the stated risk): ${"%.2f".format(
                100 * falseAssurance,
            )}%. The stated risk is calibrated when this stays under 5%.",
        )
        md.appendLine()
        md.appendLine(
            "Reading. Calibration 1: Good-Turing predicts how often the next unit is a new species (estimate over realised is about 1). " +
                "Calibration 2: among the campaigns where a held-out mutant survived, its true rate is often above the novelty bound, because the " +
                "species are only as fine as the tuned mutants make them (f1 is 0 where the species do not separate the held-out mutant's cells). " +
                "That is expected: a surviving fault is by selection one the sample under-represents. What matters is how often a campaign gives " +
                "false assurance, and with the 3 / n term (the bound for a fault that n units never hit) that rate is the figure above. " +
                "Residual risk here means the chance that the next run of a rule's generator hits a behaviour class that this run's species and " +
                "the unhit-fault bound do not account for. It is not a probability that the rule is right.",
        )
        val dir = Repo.path("core/build/residual-risk")
        Files.createDirectories(dir)
        Files.writeString(dir.resolve("residual-risk.md"), md.toString())
        Files.writeString(
            dir.resolve("residual-risk.json"),
            buildJsonObject {
                put("units", all.values.sumOf { it.size })
                put("tuned", JsonArray(tuned.sorted().map { JsonPrimitive(it) }))
                put("heldOut", JsonArray(heldOut.sorted().map { JsonPrimitive(it) }))
                put("blind", JsonArray(blind.map { JsonPrimitive(it) }))
                put(
                    "current",
                    JsonObject(
                        current.mapValues { (_, e) ->
                            buildJsonObject {
                                put("n", e.n)
                                put("f1", e.f1)
                                put("f2", e.f2)
                                put("p", e.h)
                                put("upper", e.upper)
                                put("risk", e.risk)
                            }
                        },
                    ),
                )
                put("survivorsCoveredByNovelty", coveredAll)
                put("survivorsCoveredByRisk", coveredRisk)
                put("survivors", survivedAll)
            }.toString(),
        )
        println(md)
        assertTrue(killable.size >= 4, "the corpus kills few mutants: $killable")
        assertTrue(heldOut.isNotEmpty())
        assertTrue(falseAssurance <= 0.05, "the stated residual risk is over-confident: $falseAssurance")
    }
}
