package pcs.agent.llm

import kotlinx.serialization.json.JsonObject
import pcs.agent.checks.Severity
import pcs.agent.engines.Part
import pcs.core.rules.Ground
import java.nio.file.Path

/**
 * `scope` (agent.md §3.2): is the paper within the call's topics? Only an `out_of_scope` verdict is a
 * flag, and it carries the paper's own claims, anchored. Without a call for papers there is nothing to ask.
 */
class ScopeCheck(dir: Path, codeRoot: Path?) : ScreenLlmCheck(dir, codeRoot) {
    override fun units(view: PaperView, env: CheckEnv): List<LlmUnit> {
        val cfp = env.cfp?.takeIf { it.isNotBlank() } ?: return emptyList()
        return listOf(LlmUnit("opening", listOf(Part.Text("call for papers", cfp), Part.Text("opening of the paper", view.bodyText(OPENING_CHARS)))))
    }

    override fun interpret(unit: LlmUnit, out: JsonObject, view: PaperView): Interpretation {
        if (out.s("verdict") != "out_of_scope") return Interpretation()
        val topics = (out["matched_topics"] as? kotlinx.serialization.json.JsonArray)?.mapNotNull { it.str() }?.joinToString("; ").orEmpty()
        return Interpretation(
            listOf(
                Candidate(
                    "out-of-scope",
                    Ground.SCOPE,
                    Severity.MEDIUM,
                    out.arr("claims").map { Quote(it.s("quote"), it.page(), "the paper's claim") },
                    mapOf("reason" to out.s("reason"), "shown.topics the paper touches" to topics.ifEmpty { "none" }),
                ),
            ),
        )
    }

    override fun signature(unit: LlmUnit, out: JsonObject) = setOf(out.s("verdict"))

    companion object {
        const val OPENING_CHARS = 7_000
    }
}
