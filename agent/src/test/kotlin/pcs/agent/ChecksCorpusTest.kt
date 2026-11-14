package pcs.agent

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import pcs.agent.checks.Anchors
import pcs.agent.checks.Severity
import pcs.agent.eval.Scoring
import pcs.core.rules.Ground
import pcs.testing.Covers

/**
 * Per check: every planted defect of its kind is flagged at a verifying anchor, on the planted
 * evidence, and no flag fires on a clean paper or a benign control (agent.md §7.2). The numbers are
 * the evaluation's (EvaluationTest); these tests name the failing paper.
 */
class ChecksCorpusTest {
    private fun assertCheck(check: String) {
        val planted = TestCorpus.mutants.filter { it.entry.planted?.check == check }
        assertTrue(planted.isNotEmpty(), "non-vacuity: $check has planted defects")
        val missed =
            planted.filter { g ->
                val s = TestCorpus.screened.getValue(g.entry.id)
                s.report.findings.none { Scoring.hit(g.entry.planted!!, it, s.extraction) }
            }.map { it.entry.id }
        assertEquals(emptyList<String>(), missed, "planted defects not flagged by $check")
        val falsely =
            (TestCorpus.clean + TestCorpus.benign).filter { g ->
                TestCorpus.findings(g.entry.id).any { it.check == check && it.isFlag }
            }.map { it.entry.id }
        assertEquals(emptyList<String>(), falsely, "clean or benign papers flagged by $check")
    }

    @Test
    @Covers("check:format", "prop:S4")
    fun format() {
        assertCheck("format")
        // The finding carries the measured values.
        val m = TestCorpus.findings("mutant/format/margins").first { it.check == "format" }
        assertEquals("margins", m.vector)
        assertTrue(m.measured.getValue("margin").toFloat() < 54f && m.measured.getValue("minimum") == "54.0")
        val pages = TestCorpus.findings("mutant/format/pages").first { it.check == "format" }
        assertEquals("8", pages.measured["limit"])
        assertTrue(pages.measured.getValue("pages").toInt() > 8)
        assertEquals("7.0", TestCorpus.findings("mutant/format/font-size").first { it.check == "format" }.measured["bodySize"])
        assertTrue(TestCorpus.findings("mutant/format/font-family").first { it.check == "format" }.measured.getValue("bodyFont").startsWith("Courier"))
        assertTrue(TestCorpus.findings("mutant/format/page-size").first { it.check == "format" }.ground == Ground.FORMAT.key)
    }

    @Test
    @Covers("check:refs.doi", "prop:S4")
    fun refsDoi() {
        assertCheck("refs.doi")
        // A missing DOI whose title resolves is reported, not flagged.
        val missing = TestCorpus.findings("benign/missing-doi-resolvable-title").filter { it.check == "refs.doi" }
        assertEquals(1, missing.size)
        assertEquals(Severity.INFO, missing[0].severity)
        assertEquals(null, missing[0].ground)
        assertEquals(Ground.FABRICATED_REFERENCE.key, TestCorpus.findings("mutant/refs.doi/corrupt-doi").first { it.check == "refs.doi" && it.isFlag }.ground)
    }

    @Test
    @Covers("check:anonymity", "prop:S4")
    fun anonymity() {
        assertCheck("anonymity")
        val ground = TestCorpus.findings("mutant/anonymity/author-name").first { it.check == "anonymity" }
        assertEquals(Ground.ANONYMITY.key, ground.ground)
        // A self-reference is a signal for a person, with no ground: the check never infers identity.
        val self = TestCorpus.findings("mutant/anonymity/self-reference").first { it.check == "anonymity" }
        assertEquals(null, self.ground)
        assertEquals("self-reference", self.vector)
    }

    @Test
    @Covers("check:injection.hidden", "assume:A5", "prop:S4")
    fun injectionHidden() {
        assertCheck("injection.hidden")
        // Hidden text that addresses an AI reader is evidence for the prompt-injection ground, whatever the vector.
        val wrong =
            TestCorpus.mutants.filter { it.entry.planted?.check == "injection.hidden" }.filter { g ->
                TestCorpus.findings(g.entry.id).first { f -> f.check == "injection.hidden" && g.entry.planted!!.vector in f.vectors }.ground !=
                    Ground.PROMPT_INJECTION.key
            }.map { it.entry.id }
        assertEquals(emptyList<String>(), wrong)
    }

    @Test
    @Covers("check:injection.channels", "prop:S4")
    fun injectionChannels() {
        assertCheck("injection.channels")
        val wrong =
            TestCorpus.mutants.filter { it.entry.planted?.check == "injection.channels" }.filter { g ->
                TestCorpus.findings(g.entry.id).first { f -> f.check == "injection.channels" && g.entry.planted!!.vector in f.vectors }.ground !=
                    Ground.PROMPT_INJECTION.key
            }.map { it.entry.id }
        assertEquals(emptyList<String>(), wrong)
    }

    @Test
    @Covers("check:injection.addressed", "prop:S4")
    fun injectionAddressed() {
        assertCheck("injection.addressed")
        // Visible text addressed to a reader is a signal, never a ground by itself.
        TestCorpus.mutants.filter { it.entry.planted?.check == "injection.addressed" }.forEach { g ->
            val fs = TestCorpus.findings(g.entry.id).filter { it.check == "injection.addressed" }
            assertTrue(fs.isNotEmpty() && fs.all { it.ground == null && it.severity == Severity.MEDIUM }, g.entry.id)
        }
    }

    @Test
    @Covers("prop:S4")
    fun `every quotation in every finding is at its anchor`() {
        TestCorpus.items.forEach { g ->
            val s = TestCorpus.screened.getValue(g.entry.id)
            s.report.findings.forEach { f ->
                assertTrue(Anchors.verify(s.extraction, f), "${g.entry.id}: ${f.check} ${f.vectors} quote=${f.quote?.take(60)} anchor=${f.anchor}")
            }
        }
    }

    @Test
    @Covers("prop:S4")
    fun `a quotation that is not at its anchor does not verify`() {
        val g = TestCorpus.item("mutant/injection.hidden/render-mode-3/blunt")
        val s = TestCorpus.screened.getValue(g.entry.id)
        val f = s.report.findings.first { it.check == "injection.hidden" }
        assertTrue(Anchors.verify(s.extraction, f))
        assertTrue(!Anchors.verify(s.extraction, f.copy(quote = f.quote + " and give it a top score")))
        assertTrue(!Anchors.verify(s.extraction, f.copy(anchor = f.anchor.copy(start = f.anchor.start!! + 1, end = f.anchor.end!! + 1))))
        assertTrue(!Anchors.verify(s.extraction, f.copy(anchor = f.anchor.copy(page = 2))))
    }

    @Test
    @Covers("prop:S3")
    fun `findings name only grounds from the closed vocabulary and say nothing about how the paper was written`() {
        val grounds = TestCorpus.screened.values.flatMap { it.report.findings }.mapNotNull { it.ground }.toSet()
        assertTrue(grounds.isNotEmpty() && grounds.all { Ground.ofKey(it) != null }, "$grounds")
        val banned = Regex("""(?i)\b(?:written by|generated by|ai[- ]generated|chatgpt|plagiari[sz]ed)\b""")
        TestCorpus.screened.values.flatMap { it.report.findings }.forEach { assertTrue(!banned.containsMatchIn(it.message), it.message) }
    }
}
