package net.jonbell.pcs.agent.extract

import org.w3c.dom.Element
import java.io.ByteArrayInputStream
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.time.Duration
import java.util.UUID
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilderFactory

/** Parses the bibliography. Every reference keeps its location in the page text, so it can be quoted. */
fun interface ReferenceParser {
    fun parse(x: Extraction, pdf: ByteArray): List<Reference>
}

private val DOI = Regex("""\b(10\.\d{4,9}/[^\s"<>]+)""")

internal fun cleanDoi(s: String) = s.trimEnd('.', ',', ';', ')', ']')

/**
 * The built-in parser: finds the bibliography heading, splits entries at `[n]` labels, and reads
 * the DOI, authors, title, and year by position. Good enough for the synthetic corpus and for
 * numbered styles; GROBID ([GrobidReferenceParser]) is the parser for real papers.
 */
object HeuristicReferenceParser : ReferenceParser {
    private val HEADING = Regex("""(?m)^\s*(?:\d+\.?\s+)?(References|REFERENCES|Bibliography|BIBLIOGRAPHY)\s*$""")
    private val LABEL = Regex("""(?m)^\s*\[(\d+)]\s+""")
    private val YEAR = Regex("""\b(19|20)\d{2}\b""")

    fun findHeading(x: Extraction): Pair<Int, Int>? =
        x.pages.firstNotNullOfOrNull { p -> HEADING.findAll(p.text).lastOrNull()?.let { p.page to it.range.last + 1 } }

    override fun parse(x: Extraction, pdf: ByteArray): List<Reference> {
        val (startPage, startOff) = x.referencesAt ?: return emptyList()
        val out = mutableListOf<Reference>()
        for (p in x.pages.filter { it.page >= startPage }) {
            val from = if (p.page == startPage) startOff else 0
            val labels = LABEL.findAll(p.text, from).toList()
            // Text before the first label of a later page finishes the entry that began on the page before.
            if (p.page > startPage && out.isNotEmpty()) {
                val head = p.text.substring(0, labels.firstOrNull()?.range?.first ?: p.text.length).trim()
                if (head.isNotEmpty()) {
                    val last = out.removeLast()
                    out +=
                        fields(
                            last.label,
                            last.raw + " " + head.replace(Regex("\\s+"), " "),
                            last.page,
                            last.start,
                            last.end,
                        ).copy(raw = last.raw, continuation = head.replace(Regex("\\s+"), " "))
                }
            }
            labels.forEachIndexed { i, m ->
                val end = labels.getOrNull(i + 1)?.range?.first ?: p.text.length
                val start = m.range.first + m.value.indexOf('[')
                val raw = p.text.substring(start, end).trimEnd()
                out += fields(m.groupValues[1], raw.replace(Regex("\\s+"), " "), p.page, start, start + raw.length)
            }
        }
        return out
    }

    /** `[n] Authors. Title. Venue, year. doi:…` */
    fun fields(label: String, flat: String, page: Int, start: Int, end: Int): Reference {
        val body = flat.substringAfter("] ")
        val doi = DOI.find(body)?.groupValues?.get(1)?.let(::cleanDoi)
        val parts = body.split(Regex("""\.\s+""")).map { it.trim() }
        val authors = parts.getOrNull(0)?.split(Regex(""",\s*|\s+and\s+"""))?.map { it.trim() }?.filter { it.isNotEmpty() }.orEmpty()
        val title = parts.getOrNull(1)?.takeIf { it.isNotBlank() && !it.startsWith("doi:") }
        val year = YEAR.findAll(body).lastOrNull()?.value?.toInt()
        return Reference(label, flat, page, start, end, doi, title, authors, year)
    }
}

/**
 * GROBID (agent.md §3.2 `refs.doi`), running as a local container. Only loopback URLs are
 * accepted: the PDF never leaves the machine. The transport is pluggable so tests use recorded
 * TEI responses and need no GROBID. Each parsed reference is located in the page text by its
 * title (or DOI); references that cannot be located are dropped, because they could not be quoted.
 */
class GrobidReferenceParser(private val transport: Transport) : ReferenceParser {
    fun interface Transport {
        /** POST the PDF to `/api/processReferences`; returns TEI XML. */
        fun processReferences(pdf: ByteArray): String
    }

    override fun parse(x: Extraction, pdf: ByteArray): List<Reference> {
        val tei = transport.processReferences(pdf)
        return parseTei(tei).mapNotNull { r -> locate(x, r) }
    }

    data class TeiRef(val title: String?, val authors: List<String>, val year: Int?, val doi: String?)

    companion object {
        fun http(baseUrl: String, timeout: Duration = Duration.ofSeconds(60)): Transport {
            val uri = URI(baseUrl.trimEnd('/'))
            require(uri.host in setOf("127.0.0.1", "localhost", "::1", "[::1]")) {
                "GROBID must run locally (got host ${uri.host}); the PDF never leaves the machine"
            }
            val client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(5)).build()
            return Transport { pdf ->
                val boundary = "pcs-" + UUID.nameUUIDFromBytes(pdf).toString()
                val head = "--$boundary\r\nContent-Disposition: form-data; name=\"input\"; filename=\"paper.pdf\"\r\nContent-Type: application/pdf\r\n\r\n"
                val tail = "\r\n--$boundary\r\nContent-Disposition: form-data; name=\"consolidateCitations\"\r\n\r\n0\r\n--$boundary--\r\n"
                val body = head.toByteArray() + pdf + tail.toByteArray()
                val req =
                    HttpRequest.newBuilder(URI("$uri/api/processReferences"))
                        .timeout(timeout)
                        .header("Content-Type", "multipart/form-data; boundary=$boundary")
                        .header("Accept", "application/xml")
                        .POST(HttpRequest.BodyPublishers.ofByteArray(body))
                        .build()
                val res = client.send(req, HttpResponse.BodyHandlers.ofString())
                check(res.statusCode() == 200) { "GROBID returned HTTP ${res.statusCode()}" }
                res.body()
            }
        }

        fun parseTei(tei: String): List<TeiRef> {
            val f = DocumentBuilderFactory.newInstance()
            f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
            f.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true)
            f.isNamespaceAware = true
            val dom = f.newDocumentBuilder().parse(ByteArrayInputStream(tei.toByteArray()))
            val bibs = dom.getElementsByTagNameNS("*", "biblStruct")
            return (0 until bibs.length).map { i ->
                val b = bibs.item(i) as Element

                fun all(tag: String) = b.getElementsByTagNameNS("*", tag).let { nl -> (0 until nl.length).map { nl.item(it) as Element } }
                val title = all("title").firstOrNull { it.getAttribute("level") == "a" }?.textContent?.trim() ?: all("title").firstOrNull()?.textContent?.trim()
                val authors =
                    all("persName").map { p ->
                        val fore =
                            p.getElementsByTagNameNS("*", "forename").let { nl ->
                                (0 until nl.length).joinToString(" ") { nl.item(it).textContent.trim() }
                            }
                        val sur = p.getElementsByTagNameNS("*", "surname").item(0)?.textContent?.trim().orEmpty()
                        listOf(fore, sur).filter { it.isNotBlank() }.joinToString(" ")
                    }
                val year = all("date").firstNotNullOfOrNull { it.getAttribute("when").take(4).toIntOrNull() }
                val doi = all("idno").firstOrNull { it.getAttribute("type").equals("DOI", ignoreCase = true) }?.textContent?.trim()?.let(::cleanDoi)
                TeiRef(title?.takeIf { it.isNotBlank() }, authors, year, doi)
            }
        }

        private fun squash(s: String) = s.lowercase().filter { it.isLetterOrDigit() }

        /** Finds the entry in the page text whose span contains the TEI title (or DOI). */
        fun locate(x: Extraction, r: TeiRef): Reference? {
            val heuristic = HeuristicReferenceParser.parse(x, ByteArray(0))
            val key = r.doi?.let(::squash) ?: r.title?.let(::squash) ?: return null
            val hit = heuristic.firstOrNull { squash(it.raw + it.continuation).contains(key) } ?: return null
            return hit.copy(doi = r.doi ?: hit.doi, title = r.title ?: hit.title, authors = r.authors.ifEmpty { hit.authors }, year = r.year ?: hit.year)
        }
    }
}
