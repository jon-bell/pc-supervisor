package net.jonbell.pcs.agent.llm

import kotlinx.serialization.json.JsonObject
import net.jonbell.pcs.agent.engines.Part
import java.nio.file.Path

/**
 * `summary` (agent.md §3.2): a structured summary for triage. Every statement carries a quotation the
 * harness finds in the paper; a statement without one is left out. The schema has no field for a score
 * or a recommendation.
 */
class SummaryCheck(dir: Path, codeRoot: Path?) : ScreenLlmCheck(dir, codeRoot) {
    override val maxOutputTokens = 2500
    override val materialThreshold = 0.25

    override fun units(view: PaperView, env: CheckEnv): List<LlmUnit> {
        val parts = mutableListOf<Part>(Part.Text("paper body, hidden text removed, bibliography omitted", view.bodyText(AnonymityLlmCheck.MAX_CHARS)))
        val refs = view.referenceList()
        if (refs.isNotBlank()) parts += Part.Text("reference list", refs)
        return listOf(LlmUnit("summary", parts))
    }

    override fun interpret(unit: LlmUnit, out: JsonObject, view: PaperView): Interpretation {
        val items = mutableListOf<DraftItem>()

        fun add(section: String, key: String, prefix: (JsonObject) -> String = { "" }) {
            for (i in out.arr(key)) items += DraftItem(section, prefix(i) + i.s("text"), Quote(i.s("quote"), i.page(), "summary statement"))
        }
        add("Claimed contributions", "contributions")
        add("Evaluation", "evaluation")
        add("Relation to prior work", "prior_work")
        add("Closest cited work", "closest_cited_work") { "${it.s("ref")}: " }
        return Interpretation(summary = items)
    }

    override fun signature(unit: LlmUnit, out: JsonObject): Set<String> =
        listOf("contributions", "evaluation", "prior_work", "closest_cited_work").flatMap { k -> out.arr(k).map { sigOf(it.s("quote")) } }.toSet()
}
