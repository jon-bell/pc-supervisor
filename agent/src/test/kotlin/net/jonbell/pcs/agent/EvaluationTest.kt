package net.jonbell.pcs.agent

import net.jonbell.pcs.agent.eval.Corpus
import net.jonbell.pcs.agent.eval.Scoring
import net.jonbell.pcs.testing.Covers
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

/** The measurement (agent.md §7.2): per-check mutation score and false-flag rate, plus the detectors-only and diff-only ablations. */
@Covers(
    "check:format",
    "check:refs.doi",
    "check:anonymity",
    "check:injection.hidden",
    "check:injection.channels",
    "check:injection.addressed",
    "prop:S4",
    "assume:A5",
)
class EvaluationTest {
    @Test
    fun `mutation score is 1 and the false-flag rate is 0 for every check, and no anchor fails to verify`() {
        val e = Scoring.evaluate(TestCorpus.items)
        System.getProperty("pcs.reportsDir")?.let { Scoring.write(e, File(it)) }
        println(Scoring.markdown(e))
        for (c in e.checks) {
            assertTrue(c.planted > 0, "non-vacuity: ${c.check}")
            assertEquals(emptyList<String>(), c.missed, "${c.check} missed")
            assertEquals(1.0, c.score, "${c.check} mutation score")
            assertEquals(emptyList<String>(), c.falseFlagIds, "${c.check} false flags")
            assertEquals(0.0, c.falseFlagRate)
            assertEquals(0, c.collateral, "${c.check} flags on another check's mutants")
        }
        assertEquals(emptyList<String>(), e.unverifiedAnchors)
        // Only the paper about prompt injection draws LOW signals.
        assertTrue(e.checks.first { it.check == "injection.addressed" }.lowSignals >= 4)
        assertEquals(0, e.checks.filter { it.check != "injection.addressed" }.sumOf { it.lowSignals })
        // The vector detectors alone find every planted hidden-text vector; the OCR diff alone finds those that change what is drawn.
        val diffVectors =
            setOf("render-mode-3", "fill-matches-background", "tiny-font", "clipped", "off-page", "covered", "optional-content-off", "tounicode-remap")
        for (v in e.vectors.filter { it.check == "injection.hidden" }) {
            assertEquals(v.planted, v.detectorsOnly, "detectors only: ${v.vector}")
            if (v.vector in diffVectors) assertEquals(v.planted, v.diffOnly, "OCR diff only: ${v.vector}")
        }
    }

    @Test
    fun `the corpus is a function of the seed`() {
        val a = Corpus.generate(seed = 5, cleanCount = 2)
        val b = Corpus.generate(seed = 5, cleanCount = 2)
        assertEquals(a.map { it.entry }, b.map { it.entry })
        assertTrue(a.zip(b).all { (x, y) -> x.bytes.contentEquals(y.bytes) })
        val c = Corpus.generate(seed = 6, cleanCount = 2)
        assertTrue(a.first().bytes.size != c.first().bytes.size || !a.first().bytes.contentEquals(c.first().bytes))
    }

    @Test
    fun `the corpus is synthetic and has every kind of paper`() {
        assertEquals(setOf("clean", "mutant", "benign"), TestCorpus.items.map { it.entry.kind }.toSet())
        assertEquals(4, TestCorpus.mutants.count { it.entry.planted?.vector == "unicode-tag" })
        assertEquals(6, TestCorpus.benign.size)
        // Invented domains only.
        TestCorpus.items.forEach { g -> assertTrue(g.entry.authors.domains.all { it.endsWith(".example.org") }) }
    }
}
