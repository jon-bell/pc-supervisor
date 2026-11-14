package pcs.agent

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import pcs.agent.extract.GrobidReferenceParser
import pcs.agent.extract.PdfExtractor
import pcs.testing.Covers

/** GROBID is pluggable: these tests use a recorded TEI response and a generated one, and never start GROBID. */
@Covers("check:refs.doi")
class GrobidTest {
    private fun recorded() = GrobidTest::class.java.getResourceAsStream("/grobid/two-refs.tei.xml")!!.readBytes().toString(Charsets.UTF_8)

    @Test
    fun `a recorded TEI response parses into references`() {
        val refs = GrobidReferenceParser.parseTei(recorded())
        assertEquals(2, refs.size)
        assertEquals("Lorem ipsum dolor sit amet", refs[0].title)
        assertEquals(listOf("Kaerun Zeltham", "Bio Mavosel"), refs[0].authors)
        assertEquals("10.9999/pcs.synth.00000001", refs[0].doi)
        assertEquals(2014, refs[0].year)
        assertEquals(2009, refs[1].year)
        assertEquals(null, refs[1].doi)
    }

    @Test
    fun `GROBID's references are located in the page text so they can be quoted`() {
        val g = TestCorpus.item("clean-02")
        val tei =
            "<TEI xmlns=\"http://www.tei-c.org/ns/1.0\"><listBibl>" +
                g.entry.truth.joinToString("") { w ->
                    "<biblStruct><analytic><title level=\"a\">${w.title}</title><idno type=\"DOI\">${w.doi}</idno></analytic><monogr><imprint><date when=\"${w.year}\"/></imprint></monogr></biblStruct>"
                } +
                "<biblStruct><analytic><title level=\"a\">A title that is nowhere in the paper</title></analytic></biblStruct></listBibl></TEI>"
        var posted = 0
        val parser =
            GrobidReferenceParser { pdf ->
                posted = pdf.size
                tei
            }
        val x = PdfExtractor(parser).extract(g.bytes)
        assertEquals(g.bytes.size, posted)
        assertEquals(g.entry.truth.map { it.doi }, x.references.map { it.doi })
        x.references.forEach { r -> assertEquals(r.raw.replace(Regex("\\s+"), " "), x.page(r.page).text.substring(r.start, r.end).replace(Regex("\\s+"), " ")) }
    }

    @Test
    fun `the HTTP transport refuses a GROBID that is not on this machine`() {
        assertThrows(IllegalArgumentException::class.java) { GrobidReferenceParser.http("http://grobid.example.org:8070") }
        GrobidReferenceParser.http("http://127.0.0.1:8070")
        GrobidReferenceParser.http("http://localhost:8070")
    }
}
