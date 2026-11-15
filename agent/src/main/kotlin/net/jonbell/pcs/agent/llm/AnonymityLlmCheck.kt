package net.jonbell.pcs.agent.llm

import kotlinx.serialization.json.JsonObject
import net.jonbell.pcs.agent.checks.Severity
import net.jonbell.pcs.agent.engines.Part
import net.jonbell.pcs.core.rules.Ground
import java.nio.file.Path

/**
 * The LLM half of `anonymity` (agent.md §3.2): phrasing that points to the authors. It never sees the
 * author list, never sees the bibliography, and never infers identity. Each item must quote the paper.
 */
class AnonymityLlmCheck(dir: Path, codeRoot: Path?) : ScreenLlmCheck(dir, codeRoot) {
    override fun units(view: PaperView, env: CheckEnv) =
        listOf(LlmUnit("body", listOf(Part.Text("paper body, hidden text removed, bibliography omitted", view.bodyText(MAX_CHARS)))))

    override fun interpret(unit: LlmUnit, out: JsonObject, view: PaperView) =
        Interpretation(
            out.arr("items").map { i ->
                Candidate(
                    i.s("kind"),
                    Ground.ANONYMITY,
                    Severity.MEDIUM,
                    listOf(Quote(i.s("quote"), i.page(), "phrase")),
                    mapOf("reason" to i.s("reason")),
                )
            },
        )

    override fun signature(unit: LlmUnit, out: JsonObject) = out.arr("items").map { sigOf(it.s("quote")) }.toSet()

    companion object {
        const val MAX_CHARS = 60_000
    }
}
