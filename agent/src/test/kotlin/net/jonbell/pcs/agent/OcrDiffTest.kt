package net.jonbell.pcs.agent

import net.jonbell.pcs.agent.checks.HiddenDetector
import net.jonbell.pcs.agent.checks.ScreenConfig
import net.jonbell.pcs.agent.checks.ScreenContext
import net.jonbell.pcs.agent.checks.Screening
import net.jonbell.pcs.agent.extract.DockerOcr
import net.jonbell.pcs.agent.extract.PdfExtractor
import net.jonbell.pcs.agent.extract.ScriptedOcr
import net.jonbell.pcs.testing.Covers
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test

@Covers("check:injection.hidden", "assume:A5")
class OcrDiffTest {
    private val g = TestCorpus.item("clean-01")
    private val x = PdfExtractor().extract(g.bytes)

    private fun diff(ocr: String): List<String> {
        val ctx = ScreenContext(g.bytes, x, ScreenConfig())
        try {
            val p = x.page(1)
            return HiddenDetector.ocrDiff(ctx, p, ScriptedOcr(mapOf(1 to ocr))).map { p.text.substring(it.start, it.end) }
        } finally {
            ctx.close()
        }
    }

    @Test
    fun `identical text gives no diff`() {
        assertEquals(emptyList<String>(), diff(x.page(1).text))
    }

    @Test
    fun `a run of words missing from the OCR is a finding, anchored in the text layer`() {
        val words = x.page(1).text.split(Regex("\\s+"))
        val dropped = words.subList(40, 47)
        val ocr = (words.take(40) + words.drop(47)).joinToString(" ")
        val found = diff(ocr)
        assertEquals(1, found.size)
        assertEquals(dropped, found[0].split(Regex("\\s+")))
    }

    @Test
    fun `OCR noise (one misread letter, one dropped word) is tolerated`() {
        val words = x.page(1).text.split(Regex("\\s+")).toMutableList()
        words[10] = words[10].replace('e', 'c')
        words.removeAt(30)
        words[50] = words[50] + "x"
        assertEquals(emptyList<String>(), diff(words.joinToString(" ")))
    }

    @Test
    fun `OCR only is used when asked for, and a paper's visible text diffs clean with the generator's oracle`() {
        val s = Screening.screen(g.bytes, net.jonbell.pcs.agent.eval.Scoring.config(g.entry))
        assertEquals(emptyList<Any>(), s.report.findings.filter { it.check == "injection.hidden" })
    }

    /** Opt-in: needs the container built from agent/ocr/Dockerfile (`docker build -t pcs-ocr:latest agent/ocr`) and PCS_TEST_OCR_DOCKER=1. Never part of `check`. */
    @Test
    fun `real OCR in a local container agrees with the text layer on a clean page and exposes white text`() {
        assumeTrue(System.getenv("PCS_TEST_OCR_DOCKER") == "1", "PCS_TEST_OCR_DOCKER=1 to run")
        val image = System.getenv("PCS_AGENT_OCR_IMAGE") ?: "pcs-ocr:latest"
        assumeTrue(DockerOcr.available(image), "image $image not built")
        val ocr = DockerOcr(image)
        val cfg = ScreenConfig(ocr = ocr, hiddenVectors = false)
        val clean = Screening.run(g.bytes, cfg).findings.filter { it.check == "injection.hidden" }
        assertEquals(emptyList<Any>(), clean, "no hidden text on a clean page")
        val m = TestCorpus.item("mutant/injection.hidden/fill-matches-background/blunt")
        val fs = Screening.run(m.bytes, cfg).findings.filter { it.check == "injection.hidden" }
        assertTrue(fs.any { "ocr-diff" in it.vectors && it.quote!!.contains("previous instructions") }, "$fs")
    }
}
