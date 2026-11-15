package net.jonbell.pcs.agent

import net.jonbell.pcs.agent.extract.PdfExtractor
import net.jonbell.pcs.testing.Covers
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

@Covers("assume:A5", "prop:S4")
class ExtractionTest {
    private val clean = TestCorpus.item("clean-01")
    private val x = PdfExtractor().extract(clean.bytes)

    @Test
    fun `the text layer of a clean paper is what a reader sees, page by page`() {
        assertEquals(clean.entry.visible.size, x.pages.size)
        x.pages.forEachIndexed { i, p ->
            assertEquals(clean.entry.visible[i].split(Regex("\\s+")), p.text.trim().split(Regex("\\s+")), "page ${i + 1}")
        }
    }

    @Test
    fun `a span of page text has a region on the page`() {
        val p = x.page(1)
        val start = p.text.indexOf("Abstract")
        val r = p.regionOf(start, start + "Abstract".length)!!
        assertTrue(r.x0 >= 71f && r.x1 <= p.width && r.y1 <= p.height && r.width > 20f)
    }

    @Test
    fun `layout facts give pages, size, margins, fonts and sizes`() {
        val l = x.layout
        assertEquals(clean.entry.pages, l.pageCount)
        assertEquals(612f, l.pages[0].width)
        assertEquals(792f, l.pages[0].height)
        assertEquals("Times-Roman", l.bodyFont)
        assertEquals(10f, l.bodySize)
        assertTrue(l.pages.all { (it.marginLeft ?: 100f) >= 71f && (it.marginRight ?: 100f) >= 71f }, "margins are the template's 72 pt")
        assertTrue(l.fonts.any { it.font == "Times-Bold" })
    }

    @Test
    fun `the bibliography is parsed with DOIs, titles, years, and locations in the text`() {
        assertEquals(8, x.references.size)
        x.references.forEachIndexed { i, r ->
            val truth = clean.entry.truth[i]
            assertEquals(truth.doi, r.doi)
            assertEquals(truth.title, r.title)
            assertEquals(truth.year, r.year)
            assertEquals(r.raw.replace(Regex("\\s+"), " "), x.page(r.page).text.substring(r.start, r.end).replace(Regex("\\s+"), " "))
        }
    }

    @Test
    fun `a plain paper has no channels outside its pages`() {
        assertEquals(emptyList<Any>(), x.channels)
        assertFalse(x.pages.any { it.glyphs.any { g -> g.renderMode == 3 || g.clipped || g.covered || g.hiddenLayer || g.remapped } })
        assertNull(x.channel("xmp"))
    }

    @Test
    fun `extraction is deterministic`() {
        val again = PdfExtractor().extract(clean.bytes)
        assertEquals(x.sha256, again.sha256)
        assertEquals(x.pages.map { it.text }, again.pages.map { it.text })
        assertEquals(x.layout, again.layout)
        assertEquals(x.references, again.references)
    }
}
