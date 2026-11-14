package pcs.agent.eval

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import pcs.agent.checks.Anchors
import pcs.agent.checks.Finding
import pcs.agent.checks.FormatPolicy
import pcs.agent.checks.ReferenceResolver
import pcs.agent.checks.ScreenConfig
import pcs.agent.checks.Screening
import pcs.agent.extract.Extraction
import java.io.File

@Serializable
data class CheckScore(
    val check: String,
    val planted: Int,
    val found: Int,
    val missed: List<String>,
    /** Clean and benign papers on which this check made a flag (a ground, or MEDIUM and above). */
    val falseFlags: Int,
    val falseFlagIds: List<String>,
    val cleanAndBenign: Int,
    /** LOW signals on clean and benign papers: allowed only on the paper-about-injection control, and never a ground. */
    val lowSignals: Int,
    /** Flags this check raised on mutants of other checks. */
    val collateral: Int,
) {
    val score: Double get() = if (planted == 0) 0.0 else found.toDouble() / planted
    val falseFlagRate: Double get() = if (cleanAndBenign == 0) 0.0 else falseFlags.toDouble() / cleanAndBenign
}

@Serializable
data class VectorScore(val check: String, val vector: String, val planted: Int, val found: Int, val detectorsOnly: Int?, val diffOnly: Int?)

@Serializable
data class Evaluation(val corpusSize: Int, val checks: List<CheckScore>, val vectors: List<VectorScore>, val unverifiedAnchors: List<String>)

object Scoring {
    private val pretty = Json { prettyPrint = true }

    fun config(e: Entry, vectors: Boolean = true, ocr: Boolean = true) =
        ScreenConfig(
            format = FormatPolicy.SYNTHETIC,
            authors = e.authors,
            resolver = ReferenceResolver.Mock(e.truth),
            ocr = if (ocr) ManifestOcr(e.visible) else null,
            hiddenVectors = vectors,
        )

    private fun norm(s: String) = java.text.Normalizer.normalize(s, java.text.Normalizer.Form.NFKC).lowercase().filter { it.isLetterOrDigit() }

    /** The finding is the planted defect: right check, right vector, a verified anchor, on the planted evidence. */
    fun hit(p: Planted, f: Finding, x: Extraction, vector: String = p.vector): Boolean {
        if (f.check != p.check || vector !in f.vectors || !f.isFlag) return false
        if (!Anchors.verify(x, f)) return false
        if (p.page != null && f.anchor.page != null && f.anchor.page != p.page && f.anchor.channel == null) return false
        if (p.channel != null && f.anchor.channel?.startsWith(p.channel) != true) return false
        if (p.key.isEmpty()) return true
        val nk = norm(p.key)
        val nq = norm((f.quote ?: "") + (f.detail ?: ""))
        return nk in nq || (nq.length >= 10 && nq in nk)
    }

    fun evaluate(items: List<Generated>): Evaluation {
        val unverified = mutableListOf<String>()

        class Run(val g: Generated, val findings: List<Finding>, val x: Extraction)
        val runs =
            items.map { g ->
                val s = Screening.screen(g.bytes, config(g.entry))
                s.report.findings.filter { it.quote != null && !Anchors.verify(s.extraction, it) }.forEach {
                    unverified +=
                        "${g.entry.id}: ${it.check} ${it.vectors}"
                }
                Run(g, s.report.findings, s.extraction)
            }
        val checks =
            Oracle.checks.map { c ->
                val mut = runs.filter { it.g.entry.planted?.check == c }
                val found = mut.filter { r -> r.findings.any { hit(r.g.entry.planted!!, it, r.x) } }
                val neg = runs.filter { it.g.entry.planted == null }
                val ff = neg.filter { r -> r.findings.any { it.check == c && it.isFlag } }
                val low = neg.sumOf { r -> r.findings.count { it.check == c && !it.isFlag && it.severity == pcs.agent.checks.Severity.LOW } }
                val coll =
                    runs.filter { it.g.entry.planted != null && it.g.entry.planted.check != c }.sumOf { r ->
                        r.findings.count {
                            it.check == c &&
                                it.isFlag
                        }
                    }
                CheckScore(c, mut.size, found.size, (mut - found.toSet()).map { it.g.entry.id }, ff.size, ff.map { it.g.entry.id }, neg.size, low, coll)
            }
        val vectors =
            Oracle.checks.flatMap { c ->
                Oracle.operators(c).filterNot { it.control }.map { it.vector }.distinct().map { v ->
                    val mut = runs.filter { it.g.entry.planted?.let { p -> p.check == c && p.vector == v } == true }
                    val found = mut.count { r -> r.findings.any { hit(r.g.entry.planted!!, it, r.x) } }

                    fun ablate(vec: Boolean, ocr: Boolean) =
                        mut.count { r ->
                            val s = Screening.screen(r.g.bytes, config(r.g.entry, vec, ocr))
                            s.report.findings.any { hit(r.g.entry.planted!!, it, s.extraction, if (vec) v else "ocr-diff") }
                        }
                    val hidden = c == "injection.hidden"
                    VectorScore(c, v, mut.size, found, if (hidden) ablate(true, false) else null, if (hidden) ablate(false, true) else null)
                }
            }
        return Evaluation(items.size, checks, vectors, unverified)
    }

    fun markdown(e: Evaluation): String =
        buildString {
            appendLine("# Screening: planted-defect recall and false flags (synthetic corpus, ${e.corpusSize} papers)")
            appendLine()
            appendLine(
                "| Check | Planted | Found | Mutation score | False flags (clean + benign) | False-flag rate | LOW signals | Collateral flags on other checks' mutants |",
            )
            appendLine("|---|---|---|---|---|---|---|---|")
            e.checks.forEach { c ->
                appendLine(
                    "| `${c.check}` | ${c.planted} | ${c.found} | ${"%.3f".format(
                        c.score,
                    )} | ${c.falseFlags} / ${c.cleanAndBenign} | ${"%.3f".format(c.falseFlagRate)} | ${c.lowSignals} | ${c.collateral} |",
                )
            }
            appendLine()
            appendLine("| Check | Vector | Planted | Found | Detectors only | OCR diff only |")
            appendLine("|---|---|---|---|---|---|")
            e.vectors.forEach { v ->
                appendLine("| `${v.check}` | `${v.vector}` | ${v.planted} | ${v.found} | ${v.detectorsOnly ?: "-"} | ${v.diffOnly ?: "-"} |")
            }
            appendLine()
            appendLine("Unverified anchors (prop:S4): ${if (e.unverifiedAnchors.isEmpty()) "none" else e.unverifiedAnchors.joinToString()}")
        }

    fun write(e: Evaluation, dir: File) {
        dir.mkdirs()
        File(dir, "mutation-score.md").writeText(markdown(e))
        File(dir, "mutation-score.json").writeText(pretty.encodeToString(e))
    }
}

fun main(args: Array<String>) {
    val e = Scoring.evaluate(Corpus.generate())
    println(Scoring.markdown(e))
    args.firstOrNull()?.let { Scoring.write(e, File(it)) }
}
