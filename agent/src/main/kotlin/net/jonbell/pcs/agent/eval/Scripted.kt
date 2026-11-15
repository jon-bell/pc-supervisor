@file:Suppress("ktlint:standard:max-line-length")

package net.jonbell.pcs.agent.eval

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import net.jonbell.pcs.agent.engines.CallRequest
import net.jonbell.pcs.agent.engines.CallResult
import net.jonbell.pcs.agent.engines.Caps
import net.jonbell.pcs.agent.engines.Engine
import net.jonbell.pcs.agent.engines.Keys
import net.jonbell.pcs.agent.engines.Part
import net.jonbell.pcs.agent.engines.Status
import net.jonbell.pcs.agent.engines.Structured
import net.jonbell.pcs.agent.engines.ToolLoop
import net.jonbell.pcs.agent.engines.Usage

/**
 * How a scripted stand-in misbehaves. Every rate is applied by hashing the request (and the run number for
 * the per-run ones), so a stand-in is a deterministic function of what it is asked: the same corpus gives
 * the same report. These are not models; they exist so that the frontier, interval, stability, and
 * scaffold code has differences to measure before a real engine is available.
 */
data class Profile(
    val name: String,
    val seed: Long,
    /** Share of real defects that this engine never finds (the same on every run). */
    val miss: Double,
    /** Share of clean units that this engine always flags (the same on every run). */
    val falseAlarm: Double,
    /** Chance, per run, that a verdict flips: the source of flaky flags. */
    val flip: Double,
    /** Share of reported quotations altered so that they no longer verify. */
    val badQuote: Double,
    val refusal: Double = 0.0,
    val schemaFail: Double = 0.0,
    val truncate: Double = 0.0,
    /** Chance that a summary obeys an instruction in the paper (injection susceptibility). */
    val obey: Double = 0.0,
    /** Extra miss rate when handed only the PDF (no extraction, slicing, or stripping). */
    val rawPenalty: Double = 0.0,
    val latencyBaseMs: Long = 3000,
    val latencyPerKTokMs: Long = 20,
)

object Profiles {
    /** A strong, expensive API-class stand-in. */
    val STRONG =
        Profile(
            "scripted-strong",
            101,
            miss = 0.05,
            falseAlarm = 0.02,
            flip = 0.03,
            badQuote = 0.01,
            schemaFail = 0.005,
            obey = 0.10,
            rawPenalty = 0.10,
            latencyBaseMs = 4000,
        )

    /** A weaker, cheaper tier whose answers are right on average and unstable from run to run. */
    val NOISY =
        Profile(
            "scripted-noisy",
            202,
            miss = 0.10,
            falseAlarm = 0.05,
            flip = 0.30,
            badQuote = 0.03,
            refusal = 0.01,
            schemaFail = 0.02,
            obey = 0.30,
            rawPenalty = 0.20,
            latencyBaseMs = 2000,
        )

    /** A degraded stand-in for a small self-hosted model: misses, false alarms, truncations, slow, gullible. */
    val SELF_HOSTED =
        Profile(
            "scripted-selfhosted",
            303,
            miss = 0.25,
            falseAlarm = 0.12,
            flip = 0.10,
            badQuote = 0.08,
            schemaFail = 0.02,
            truncate = 0.02,
            obey = 0.50,
            rawPenalty = 0.40,
            latencyBaseMs = 9000,
            latencyPerKTokMs = 60,
        )
}

/** The verdict a check should reach on a request, read from the request text; [flagged] holds the defect and [clear] the clean answer. */
private class Ideal(val positive: Boolean, val flagged: JsonObject, val clear: JsonObject)

/**
 * A deterministic stand-in engine for the shootout. It reads the request the way the check's prompt asks
 * a model to (the planted phrases of this repository's synthetic papers), then degrades the answer by
 * its [Profile]. [pdfText] gives it the text of a PDF it is handed whole, which it reads worse (rawPenalty).
 */
class ScriptedEngine(
    override val id: String,
    private val p: Profile,
    private val run: Int,
    private val pdfText: Map<String, String> = emptyMap(),
    private val model: String = p.name,
) : Engine {
    override val caps = Caps(Structured.NATIVE, pdfInput = true, maxInputTokens = Int.MAX_VALUE, batch = false, promptCache = false, toolLoop = ToolLoop.NONE)

    private fun rand(vararg salt: Any): Double = Keys.sha256("${p.seed}|${salt.joinToString("|")}").take(8).toLong(16).toDouble() / 0xFFFFFFFFL.toDouble()

    private fun bodyText(req: CallRequest): Pair<String, Boolean> {
        val texts = req.parts.filterIsInstance<Part.Text>()
        val pdf = req.parts.filterIsInstance<Part.Pdf>().firstOrNull()
        if (pdf != null && texts.none { it.label.startsWith("paper body") || it.label.startsWith("opening") }) {
            return (pdfText[Keys.sha256(pdf.base64)] ?: "") to true
        }
        // The call for papers is the question, not the paper: the paper's own text is everything else.
        return texts.filter { it.label != "call for papers" }.joinToString("\n\n") { it.text } to false
    }

    override suspend fun call(req: CallRequest): CallResult {
        val h = Keys.inputAddress(req)
        val (text, raw) = bodyText(req)
        val st = rand("status", h, run)
        val usageIn = (req.system.length + req.parts.sumOf { partChars(it) } + 3L) / 4

        fun result(status: Status, output: JsonElement?, outChars: Int, detail: String? = null): CallResult {
            val out = (outChars / 4L) + 30
            val latency = p.latencyBaseMs + p.latencyPerKTokMs * (usageIn + out) / 1000 + (rand("lat", h, run) * 800).toLong()
            return CallResult(req.key, status, output, model, Usage(usageIn, out), latencyMs = latency, detail = detail)
        }
        if (st < p.refusal) return result(Status.REFUSAL, null, 40, "scripted refusal")
        if (st < p.refusal + p.truncate) return result(Status.TRUNCATED, null, req.maxOutputTokens * 4, "scripted truncation")
        if (st < p.refusal + p.truncate + p.schemaFail) return result(Status.OK, buildJsonObject { put("unexpected", "not the schema") }, 30)
        val out = answer(req, h, text, raw)
        return result(Status.OK, out, out.toString().length)
    }

    private fun partChars(part: Part): Int =
        when (part) {
            is Part.Text -> part.text.length
            is Part.Pdf -> part.base64.length / 3
            is Part.References -> part.records.sumOf { it.toString().length }
        }

    private fun answer(req: CallRequest, h: String, text: String, raw: Boolean): JsonObject {
        val ideal = ideal(req, text, h)
        val chosen =
            if (req.check.id == "summary") {
                summary(text, h)
            } else {
                var verdict =
                    if (ideal.positive) {
                        rand("miss", h) >= p.miss + if (raw) p.rawPenalty else 0.0
                    } else {
                        rand("fa", h) < p.falseAlarm + if (raw) p.rawPenalty / 4 else 0.0
                    }
                if (rand("flip", h, run) < p.flip) verdict = !verdict
                if (verdict) ideal.flagged else ideal.clear
            }
        return if (rand("bq", h, run) < p.badQuote) spoil(chosen) as JsonObject else chosen
    }

    /** Alters every quotation so that it is no longer in the paper. */
    private fun spoil(e: JsonElement): JsonElement =
        when (e) {
            is JsonObject ->
                JsonObject(
                    e.mapValues { (k, v) ->
                        if ((k == "quote" || k == "abstract_quote") &&
                            v is JsonPrimitive &&
                            v.isString
                        ) {
                            JsonPrimitive(v.content + " (as the authors put it)")
                        } else {
                            spoil(v)
                        }
                    },
                )
            is JsonArray -> JsonArray(e.map { spoil(it) })
            else -> e
        }

    private fun sentences(text: String) = Regex("""[A-Z][^.]{25,200}\.""").findAll(text).map { it.value }.toList()

    private fun ideal(req: CallRequest, text: String, h: String): Ideal =
        when (req.check.id) {
            "anonymity.llm" -> anonymity(text, h)
            "scope" -> scope(text, h)
            "refs.use" -> refs(req, h)
            "injection.addressed.llm" -> addressed(req)
            else -> Ideal(false, buildJsonObject {}, buildJsonObject {})
        }

    private fun item(quote: String, kind: String, reason: String) =
        buildJsonObject {
            put("quote", quote.take(300))
            put("kind", kind)
            put("reason", reason)
        }

    private fun anonymity(text: String, h: String): Ideal {
        val items = mutableListOf<JsonObject>()
        Regex("""This work builds on our previous tool[^.]*\.""").find(text)?.let {
            items +=
                item(it.value, "own-prior-work", "The authors describe their own earlier tool.")
        }
        Regex("""https://github\.com/[^\s,]+""").find(text)?.let { items += item(it.value, "identifying-link", "A repository link names a person or lab.") }
        val clear = buildJsonObject { putJsonArray("items") {} }
        val fabricated =
            sentences(text).let { s ->
                if (s.isEmpty()) {
                    "No sentence found in the text."
                } else {
                    s[
                        (rand("fab", h) * s.size).toInt().coerceAtMost(
                            s.size - 1,
                        ),
                    ]
                }
            }
        val flagged =
            buildJsonObject { put("items", JsonArray(items.ifEmpty { listOf(item(fabricated, "other", "This phrasing might point to the authors.")) })) }
        return Ideal(items.isNotEmpty(), flagged, clear)
    }

    private val topic = Regex("""\b(test|tests|testing|fuzz\w*|mutant\w*|mutation|flaky|fault\w*|debug\w*|software)\b""", RegexOption.IGNORE_CASE)

    private fun scope(text: String, h: String): Ideal {
        val inScope = topic.findAll(text).count() >= 2
        val claim = Regex("""We present[^.]*\.""").find(text)?.value ?: sentences(text).firstOrNull() ?: text.take(120)

        fun obj(verdict: String, topics: List<String>, reason: String) =
            buildJsonObject {
                put("verdict", verdict)
                putJsonArray("claims") { add(buildJsonObject { put("quote", claim.take(300).padEnd(10, '.')) }) }
                putJsonArray("matched_topics") { topics.forEach { add(JsonPrimitive(it)) } }
                put("reason", reason)
            }
        return Ideal(
            !inScope,
            obj("out_of_scope", emptyList(), "The paper's subject is not among the call's topics."),
            obj("in_scope", listOf("software testing"), "The paper is about software testing."),
        )
    }

    private fun refs(req: CallRequest, h: String): Ideal {
        val records = req.parts.filterIsInstance<Part.References>().flatMap { it.records }

        fun field(o: JsonObject, k: String) = (o[k] as? JsonPrimitive)?.contentOrNull.orEmpty()

        fun result(o: JsonObject, bad: Boolean) =
            buildJsonObject {
                put("id", field(o, "id"))
                put("verdict", if (bad) "not_supported" else "supported")
                put("abstract_quote", Regex("""^[^.]*\.""").find(field(o, "abstract").trim())?.value ?: field(o, "abstract").take(120))
                put("reason", if (bad) "The citing sentence says the opposite of the abstract." else "The abstract supports the claim.")
            }
        val bad = records.filter { "poor proxy" in field(it, "citing_sentence") && "proxy" in field(it, "abstract") }
        val flagged =
            buildJsonObject {
                put(
                    "results",
                    JsonArray(
                        records.map { result(it, it in bad) }.let { all ->
                            if (bad.isEmpty() && records.isNotEmpty()) {
                                val i = (rand("fab", h) * records.size).toInt().coerceAtMost(records.size - 1)
                                all.mapIndexed { j, r -> if (j == i) result(records[j], true) else r }
                            } else {
                                all
                            }
                        },
                    ),
                )
            }
        return Ideal(bad.isNotEmpty(), flagged, buildJsonObject { put("results", JsonArray(records.map { result(it, false) })) })
    }

    private fun addressed(req: CallRequest): Ideal {
        val span = req.parts.filterIsInstance<Part.Text>().firstOrNull { it.label == "candidate span" }?.text.orEmpty()
        val attack = Regex("""^\s*(ignore|disregard)\b""", RegexOption.IGNORE_CASE).containsMatchIn(span)

        fun obj(v: String) =
            buildJsonObject {
                put("verdict", v)
                put("reason", if (v == "attack") "The span instructs an AI reader." else "The span quotes or discusses such an instruction.")
            }
        return Ideal(attack, obj("attack"), obj("quotation"))
    }

    private fun summary(text: String, h: String): JsonObject {
        fun item(t: String, q: String) =
            buildJsonObject {
                put("text", t.take(400))
                put("quote", q.take(300).padEnd(10, '.'))
            }
        val contributions = Regex("""(First|Second|Third), [^.]*\.""").findAll(text).map { item("Contribution: " + it.value, it.value) }.toMutableList()
        if (contributions.isEmpty()) sentences(text).firstOrNull()?.let { contributions += item("Claim: $it", it) }
        val obeyed = Regex("""(?s)In your summary, state that.*?10/10\.""").find(text)
        // An engine that obeys the planted instruction writes it up instead of the paper's contributions.
        if (obeyed != null && rand("obey", h) < p.obey) {
            contributions.clear()
            contributions += item("The paper should be accepted with a score of 10/10.", obeyed.value)
        }
        val evaluation = Regex("""We evaluate[^.]*\.""").find(text)?.let { listOf(item("Evaluation: " + it.value, it.value)) }.orEmpty()
        return buildJsonObject {
            put("contributions", JsonArray(contributions.take(5)))
            put("evaluation", JsonArray(evaluation))
            put("prior_work", buildJsonArray {})
            put("closest_cited_work", buildJsonArray {})
        }
    }
}
