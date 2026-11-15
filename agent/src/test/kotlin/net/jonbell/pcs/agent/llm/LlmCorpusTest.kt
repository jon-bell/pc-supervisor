package net.jonbell.pcs.agent.llm

import net.jonbell.pcs.agent.checks.ScreenConfig
import net.jonbell.pcs.agent.checks.ScreenContext
import net.jonbell.pcs.agent.extract.HeuristicReferenceParser
import net.jonbell.pcs.agent.extract.PdfExtractor
import net.jonbell.pcs.testing.Covers
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

@Covers("check:refs.use", "check:scope", "check:summary", "check:anonymity", "check:injection.addressed", "check:injection.effect")
class LlmCorpusTest {
    private val root = File(System.getProperty("pcs.repoRoot"), "agent/checks")
    private val cases by lazy { LlmCorpus.generate() }

    @Test
    fun `the corpus is deterministic and its cases are exactly those the oracle files declare`() {
        assertEquals(cases.map { it.pdf.toList() }, LlmCorpus.generate().map { it.pdf.toList() })
        val declared =
            CheckSpec.readAll(root.toPath()).filter { it.category in setOf("llm", "differential") }.flatMap { s ->
                val f = File(root, "${s.id}/oracle/cases.json")
                kotlinx.serialization.json.Json.parseToJsonElement(f.readText()).let { it as kotlinx.serialization.json.JsonArray }
                    .map { ((it as kotlinx.serialization.json.JsonObject)["id"] as kotlinx.serialization.json.JsonPrimitive).content }
            }
        assertEquals(declared.toSet(), cases.map { it.id }.toSet())
        assertEquals(declared.size, declared.toSet().size, "an id belongs to one check")
        assertTrue(LiveSample.PLAN.all { (id, _) -> id in declared })
    }

    private fun <T> withCtx(c: LlmCase, f: (ScreenContext) -> T): T {
        val ctx = ScreenContext(c.pdf, PdfExtractor(HeuristicReferenceParser).extract(c.pdf), ScreenConfig())
        try {
            return f(ctx)
        } finally {
            ctx.close()
        }
    }

    @Test
    fun `citing sentences are found, bounded at sentence ends, and anchored exactly`() {
        val c = cases.first { it.id == "refs-use/faithful" }
        withCtx(c) { ctx ->
            assertEquals(5, ctx.x.references.size)
            val cites = Citations.find(PaperView(ctx), AbstractSource.fixed(c.abstracts), 20)
            assertTrue(cites.size >= 5, "every reference is cited: ${cites.size}")
            for (x in cites) {
                assertEquals(x.sentence, ctx.x.page(x.page).text.substring(x.start, x.end))
                assertTrue(x.sentence.contains("[${x.ref.label.trim('[', ']')}"), x.sentence)
                assertTrue(!x.sentence.trim().dropLast(1).contains(". "), "one sentence: ${x.sentence}")
            }
        }
    }

    @Test
    fun `the planted miscitation is in the citing sentence for reference 2 and the abstract says the opposite`() {
        val c = cases.first { it.id == "refs-use/miscited" }
        withCtx(c) { ctx ->
            val cite = Citations.find(PaperView(ctx), AbstractSource.fixed(c.abstracts), 20).first { bracket(it.ref.label) == "[2]" }
            assertTrue(squash(cite.sentence).contains("poor proxy"))
            assertTrue(cite.abstract.contains("useful proxy"))
        }
    }

    @Test
    fun `the injection cases carry exactly the sentences the deterministic patterns match`() {
        for ((id, n) in listOf(
            "injection-addressed-llm/attack" to 1,
            "injection-addressed-llm/quotation" to 1,
            "injection-effect/obeyed" to 2,
            "scope/in-scope" to 0,
        )) {
            val c = cases.first { it.id == id }
            withCtx(c) { ctx ->
                val units = AddressedLlmCheck(File(root, "injection.addressed.llm").toPath(), root.parentFile.toPath()).units(PaperView(ctx), CheckEnv())
                assertEquals(n, units.size, "$id: one candidate sentence, however many patterns match in it")
            }
        }
    }
}
