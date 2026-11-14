package pcs.agent

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import pcs.agent.checks.AnonymityCheck
import pcs.agent.checks.ScreenConfig
import pcs.agent.checks.ScreenContext
import pcs.agent.checks.Screening
import pcs.agent.checks.Severity
import pcs.agent.eval.CleanPapers
import pcs.agent.eval.Hooks
import pcs.agent.eval.PaperRenderer
import pcs.agent.eval.Scoring
import pcs.agent.extract.PdfExtractor
import pcs.testing.Covers

class BenignControlsTest {
    @Test
    @Covers("check:injection.addressed", "check:injection.hidden")
    fun `a paper about prompt injection that quotes payloads gets low signals and never a ground`() {
        val fs = TestCorpus.findings("benign/paper-about-prompt-injection")
        val addressed = fs.filter { it.check == "injection.addressed" }
        assertTrue(addressed.size >= 4, "the quoted payloads are noticed: ${addressed.size}")
        assertTrue(addressed.all { it.severity == Severity.LOW && it.ground == null && !it.isFlag })
        assertTrue(fs.none { it.ground != null || it.isFlag }, "no ground and no flag anywhere in the paper")
        // The same text planted by an attacker (not in a paper about LLMs) is a MEDIUM signal, still with no ground.
        val attack = TestCorpus.findings("mutant/injection.addressed/visible/blunt").filter { it.check == "injection.addressed" }
        assertTrue(attack.all { it.severity == Severity.MEDIUM && it.ground == null && it.isFlag })
    }

    @Test
    @Covers("check:injection.hidden")
    fun `legitimately tiny text and white text inside a figure are not hidden text`() {
        for (id in listOf("benign/tiny-figure-labels", "benign/white-text-in-figure")) {
            assertEquals(emptyList<Any>(), TestCorpus.findings(id).filter { it.check == "injection.hidden" }, id)
            val x = TestCorpus.screened.getValue(id).extraction
            assertTrue(x.page(1).text.contains("axis a") || x.page(1).text.contains("legend white on dark blue"), id)
        }
        // The labels really are small (and the legend really is white): the controls would fire a naive detector.
        val tiny = TestCorpus.screened.getValue("benign/tiny-figure-labels").extraction.page(1).glyphs
        assertTrue(tiny.any { it.size < 7f } && tiny.none { it.size < 2f })
        val white = TestCorpus.screened.getValue("benign/white-text-in-figure").extraction.page(1).glyphs
        assertTrue(white.any { it.fillRgb == 0xFFFFFF })
    }

    @Test
    @Covers("check:injection.channels", "check:anonymity")
    fun `metadata written by the typesetting tool and link annotations are not findings`() {
        val x = TestCorpus.screened.getValue("benign/tool-written-metadata").extraction
        assertTrue(x.channel("info:Producer") != null && x.channel("info:Title") != null && x.channel("xmp") != null, "the metadata is there")
        assertEquals(emptyList<Any>(), TestCorpus.findings("benign/tool-written-metadata").filter { it.isFlag })
        assertEquals(emptyList<Any>(), TestCorpus.findings("benign/link-annotations").filter { it.check.startsWith("injection") })
        assertTrue(TestCorpus.screened.getValue("benign/link-annotations").extraction.channels.isEmpty())
    }

    @Test
    @Covers("check:anonymity")
    fun `an author's name in the reference list is a citation, not a leak`() {
        val spec = CleanPapers.make(77)
        val cited = spec.copy(refs = spec.refs.mapIndexed { i, r -> if (i == 0) r.copy(authors = listOf(spec.authors[0].name)) else r })
        val bytes = PaperRenderer.render(cited, Hooks()).bytes
        val x = PdfExtractor().extract(bytes)
        val cfg = ScreenConfig(authors = pcs.agent.checks.AuthorInfo(spec.authors.map { it.name }))
        val ctx = ScreenContext(bytes, x, cfg)
        try {
            assertTrue(x.pages.any { it.text.contains(spec.authors[0].name) }, "the name is in the document")
            assertEquals(emptyList<Any>(), AnonymityCheck.run(ctx))
        } finally {
            ctx.close()
        }
    }

    @Test
    @Covers("check:refs.doi")
    fun `without a resolver nothing is guessed`() {
        val g = TestCorpus.item("clean-03")
        val fs = Screening.run(g.bytes, ScreenConfig()).findings.filter { it.check == "refs.doi" }
        assertEquals(8, fs.size)
        assertTrue(fs.all { it.severity == Severity.INFO && it.ground == null && "unverified" in it.vectors })
        // With the mock, the same paper is clean.
        assertEquals(emptyList<Any>(), Screening.run(g.bytes, Scoring.config(g.entry)).findings.filter { it.check == "refs.doi" })
    }
}
