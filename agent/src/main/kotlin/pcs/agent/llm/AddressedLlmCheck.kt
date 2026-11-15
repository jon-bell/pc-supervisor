package pcs.agent.llm

import kotlinx.serialization.json.JsonObject
import pcs.agent.checks.InjectionAddressedCheck
import pcs.agent.checks.Severity
import pcs.agent.engines.Part
import java.nio.file.Path

/**
 * The classifier half of `injection.addressed` (agent.md §3.2): each visible span the pattern list found
 * is shown to the model alone, with a short excerpt, no tools, and a schema-bound answer. The verdict
 * is a signal for a person and never a ground (a visible match is never a ground by itself). Hidden and
 * channel text that addresses an AI reader already carries the ground from the deterministic checks.
 */
class AddressedLlmCheck(dir: Path, codeRoot: Path?) : ScreenLlmCheck(dir, codeRoot) {
    override val readsPaper = false
    override val aboutInstructions = true
    override val maxOutputTokens = 600

    /** One unit per sentence that holds a match: the sentence is the candidate span, with a short excerpt around it. */
    override fun units(view: PaperView, env: CheckEnv): List<LlmUnit> {
        val seen = mutableSetOf<Triple<Int, Int, Int>>()
        val out = mutableListOf<LlmUnit>()
        for (f in InjectionAddressedCheck.run(view.ctx)) {
            val page = f.anchor.page ?: continue
            val s0 = f.anchor.start ?: continue
            val e0 = f.anchor.end ?: continue
            val text = view.x.page(page).text
            val s = Citations.sentenceStart(text, s0, 0)
            val e = Citations.sentenceEnd(text, e0, text.length)
            if (!seen.add(Triple(page, s, e))) continue
            val from = maxOf(0, s - CONTEXT)
            val to = minOf(text.length, e + CONTEXT)
            out +=
                LlmUnit(
                    "span@p$page:$s",
                    listOf(Part.Text("candidate span", squash(text.substring(s, e))), Part.Text("excerpt around the span", squash(text.substring(from, to)))),
                    Triple(page, s, e),
                )
            if (out.size >= MAX_SPANS) break
        }
        return out
    }

    @Suppress("UNCHECKED_CAST")
    override fun interpret(unit: LlmUnit, out: JsonObject, view: PaperView): Interpretation {
        val (page, s, e) = unit.context as Triple<Int, Int, Int>
        val verdict = out.s("verdict")
        if (verdict == "quotation") return Interpretation()
        val anchor = FlagAnchor(FlagAnchor.SOURCE_PAGE, s, e, view.x.page(page).text.substring(s, e), page = page, label = "span")
        return Interpretation(
            listOf(
                Candidate(
                    if (verdict == "attack") "addressed-to-ai" else "addressed-to-ai-unclear",
                    null,
                    if (verdict == "attack") Severity.HIGH else Severity.LOW,
                    emptyList(),
                    mapOf("reason" to out.s("reason"), "shown.verdict" to verdict),
                    listOf(anchor),
                ),
            ),
        )
    }

    override fun signature(unit: LlmUnit, out: JsonObject) = setOf(out.s("verdict"))

    companion object {
        const val MAX_SPANS = 10
        const val CONTEXT = 300
    }
}
