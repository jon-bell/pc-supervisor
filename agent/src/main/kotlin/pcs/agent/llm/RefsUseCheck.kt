package pcs.agent.llm

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import pcs.agent.checks.Severity
import pcs.agent.engines.Part
import pcs.agent.extract.Reference
import pcs.core.rules.Ground
import java.nio.file.Path

/** One in-text citation: the sentence that cites a reference, located in the paper, and the abstract of the cited work. */
class Citation(val id: String, val ref: Reference, val page: Int, val start: Int, val end: Int, val sentence: String, val abstract: String)

/**
 * `refs.use`, abstract variant (agent.md §3.2): for each citation, the citing sentence plus the cited
 * work's abstract; is the work cited for something it does not say? One flag per citation, never a
 * paper-level verdict, with both quotations. A reference without an abstract is not checked.
 */
class RefsUseCheck(dir: Path, codeRoot: Path?) : ScreenLlmCheck(dir, codeRoot) {
    override fun units(view: PaperView, env: CheckEnv): List<LlmUnit> {
        val cites = Citations.find(view, env.abstracts, MAX_CITATIONS)
        if (cites.isEmpty()) return emptyList()
        val records =
            cites.map { c ->
                buildJsonObject {
                    put("id", c.id)
                    put("ref", bracket(c.ref.label))
                    put("citing_sentence", squash(c.sentence))
                    put("abstract", squash(c.abstract))
                }
            }
        return listOf(LlmUnit("citations", listOf(Part.References("in-text citations with the cited work's abstract", records)), cites))
    }

    @Suppress("UNCHECKED_CAST")
    override fun interpret(unit: LlmUnit, out: JsonObject, view: PaperView): Interpretation {
        val cites = (unit.context as List<Citation>).associateBy { it.id }
        val cands =
            out.arr("results").filter { it.s("verdict") == "not_supported" }.mapNotNull { r ->
                val c = cites[r.s("id")] ?: return@mapNotNull null
                Candidate(
                    "citation-not-supported-by-abstract",
                    Ground.MISUSED_CITATION,
                    Severity.MEDIUM,
                    listOf(Quote(r.s("abstract_quote"), null, "abstract of ${bracket(c.ref.label)}", QuoteSource.Abstract(bracket(c.ref.label), c.abstract))),
                    mapOf("reason" to r.s("reason"), "shown.reference" to squash(c.ref.raw).take(160)),
                    listOf(FlagAnchor(FlagAnchor.SOURCE_PAGE, c.start, c.end, c.sentence, page = c.page, label = "citing sentence")),
                )
            }
        return Interpretation(cands)
    }

    @Suppress("UNCHECKED_CAST")
    override fun signature(unit: LlmUnit, out: JsonObject): Set<String> {
        val cites = (unit.context as List<Citation>).associateBy { it.id }
        return out.arr("results").filter { it.s("verdict") == "not_supported" }.mapNotNull { r ->
            cites[r.s("id")]?.let { "${bracket(it.ref.label)}|${sigOf(it.sentence)}" }
        }.toSet()
    }

    companion object {
        const val MAX_CITATIONS = 12
    }
}

/** Finds the sentences that cite a numbered reference. */
object Citations {
    private val group = Regex("""\[(\d+(?:\s*[-–,]\s*\d+)*)]""")

    private fun numbers(g: String): Set<Int> {
        val out = mutableSetOf<Int>()
        for (part in g.split(',')) {
            val ends = part.split('-', '–').map { it.trim().toIntOrNull() }
            if (ends.size == 2 &&
                ends[0] != null &&
                ends[1] != null &&
                ends[1]!! - ends[0]!! in 0..50
            ) {
                out += ends[0]!!..ends[1]!!
            } else {
                ends.firstOrNull()?.let { out += it }
            }
        }
        return out
    }

    /** The start of the sentence containing [at]: after the last sentence-ending full stop before it. */
    internal fun sentenceStart(text: String, at: Int, floor: Int): Int {
        var i = at - 1
        while (i > floor) {
            if (text[i] in ".!?" && i + 1 < text.length && text[i + 1].isWhitespace() && !abbreviation(text, i)) {
                var j = i + 1
                while (j < at && text[j].isWhitespace()) j++
                return j
            }
            i--
        }
        return floor
    }

    internal fun sentenceEnd(text: String, from: Int, limit: Int): Int {
        var i = from
        while (i < limit) {
            if (text[i] in ".!?" && (i + 1 >= text.length || text[i + 1].isWhitespace()) && !abbreviation(text, i)) return i + 1
            i++
        }
        return limit
    }

    private fun abbreviation(text: String, dot: Int): Boolean {
        val before = text.substring(maxOf(0, dot - 5), dot + 1)
        return before.endsWith("et al.") ||
            before.endsWith("e.g.") ||
            before.endsWith("i.e.") ||
            before.endsWith("Fig.") ||
            before.endsWith("Eq.") ||
            before.endsWith("Sec.")
    }

    fun find(view: PaperView, abstracts: AbstractSource, max: Int): List<Citation> {
        val refs = view.x.references.mapNotNull { r -> Regex("""\d+""").find(r.label)?.value?.toIntOrNull()?.let { it to r } }.toMap()
        val out = mutableListOf<Citation>()
        for (p in view.x.pages) {
            val limit = view.bodyLimit(p.page)
            if (limit == 0) continue
            val text = p.text
            for (m in group.findAll(text.substring(0, limit))) {
                if (view.inHidden(p.page, m.range.first, m.range.last + 1)) continue
                val s = sentenceStart(text, m.range.first, 0)
                val e = sentenceEnd(text, m.range.last + 1, limit)
                if (view.inHidden(p.page, s, e)) continue
                for (n in numbers(m.groupValues[1])) {
                    val ref = refs[n] ?: continue
                    val abs = abstracts.abstractFor(ref) ?: continue
                    if (out.any { it.ref === ref && it.page == p.page && it.start == s }) continue
                    out += Citation("c${out.size + 1}", ref, p.page, s, e, text.substring(s, e), abs)
                    if (out.size >= max) return out
                }
            }
        }
        return out
    }
}
