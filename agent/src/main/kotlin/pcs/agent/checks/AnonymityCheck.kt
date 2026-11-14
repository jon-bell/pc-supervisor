package pcs.agent.checks

import kotlinx.serialization.Serializable
import pcs.agent.extract.NormalizedText
import pcs.core.rules.Ground

/** The authors of the paper under screening, as the system of record gives them (never inferred). */
@Serializable
data class AuthorInfo(
    val names: List<String> = emptyList(),
    val affiliations: List<String> = emptyList(),
    /** Domains, e.g. `lab.example.org`, and repository owners or handles, e.g. `tavi-morund`. */
    val domains: List<String> = emptyList(),
    val handles: List<String> = emptyList(),
)

/**
 * `anonymity`, the deterministic half (agent.md §3.2): author names, affiliations, URLs, repository
 * owners and acknowledgments in the paper and the PDF metadata, against the author list. The
 * bibliography is skipped for names: citing someone is not revealing who wrote the paper. It never
 * infers identity: it matches what the list says.
 */
object AnonymityCheck : Check {
    override val id = "anonymity"

    private val selfRevealing =
        Regex(
            """\b(?:in|as shown in|see) our (?:previous|prior|earlier) (?:work|paper|publication|study)\b|\bour (?:previous|prior|earlier|own) (?:work|tool|system|paper|framework)\b[^.\n]{0,40}\[\d+]|\bwe (?:previously|have previously) (?:proposed|developed|presented|published|released)\b""",
            RegexOption.IGNORE_CASE,
        )

    override fun run(ctx: ScreenContext): List<Finding> {
        val a = ctx.config.authors
        val out = mutableListOf<Finding>()
        val needles = needles(a)
        val refsAt = ctx.x.referencesAt

        for (p in ctx.x.pages) {
            val limit =
                if (refsAt != null && p.page == refsAt.first) {
                    refsAt.second
                } else if (refsAt != null && p.page > refsAt.first) {
                    0
                } else {
                    p.text.length
                }
            val scanText = p.text.substring(0, limit)
            out +=
                scan(scanText, needles) { s, e, kind, key ->
                    ctx.finding(
                        id,
                        Ground.ANONYMITY,
                        Severity.HIGH,
                        listOf(kind.replace(' ', '-')),
                        "The paper contains $kind \"$key\" from the author list",
                        p.text.substring(s, e),
                        Anchor(p.page, null, s, e, p.regionOf(s, e)),
                    )
                }
            for (m in selfRevealing.findAll(scanText)) {
                out +=
                    ctx.finding(
                        id,
                        null,
                        Severity.MEDIUM,
                        listOf("self-reference"),
                        "Phrasing that points to the authors' own earlier work (a person decides whether it reveals them)",
                        m.value,
                        Anchor(p.page, null, m.range.first, m.range.last + 1, p.regionOf(m.range.first, m.range.last + 1)),
                    )
            }
        }
        // Acknowledgments in a submission under review.
        for (p in ctx.x.pages) {
            val m = Regex("""(?m)^\s*(?:\d+\.?\s+)?(Acknowledge?ments?|ACKNOWLEDGE?MENTS?)\s*$""").find(p.text) ?: continue
            val bodyStart = m.range.last + 1
            val body =
                p.text.substring(bodyStart).lineSequence().takeWhile {
                    !Regex("""^\s*(?:\d+\.?\s+)?[A-Z][A-Za-z ]{2,30}$""").matches(it) || it.isBlank()
                }.joinToString("\n")
            if (body.trim().split(Regex("\\s+")).size >= 8) {
                val s = bodyStart + p.text.substring(bodyStart).indexOf(body.trim().take(40))
                val e = bodyStart + p.text.substring(bodyStart).indexOf(body.trim().take(40)) + body.trim().length
                out +=
                    ctx.finding(
                        id,
                        Ground.ANONYMITY,
                        Severity.HIGH,
                        listOf("acknowledgments"),
                        "The submission has an acknowledgments section",
                        p.text.substring(s, e.coerceAtMost(p.text.length)),
                        Anchor(p.page, null, s, e.coerceAtMost(p.text.length), p.regionOf(s, e.coerceAtMost(p.text.length))),
                    )
            }
        }
        // Metadata and other channels that carry an author.
        for (c in ctx.x.channels.filter { it.key.startsWith("info:") || it.key == "xmp" || it.key.startsWith("embedded:") }) {
            out +=
                scan(c.text, needles) { s, e, kind, key ->
                    ctx.finding(
                        id,
                        Ground.ANONYMITY,
                        Severity.HIGH,
                        listOf("metadata-" + kind.replace(' ', '-')),
                        "${c.key} contains $kind \"$key\" from the author list",
                        c.text.substring(s, e),
                        Anchor(c.page, c.key, s, e),
                    )
                }
            if (c.key == "info:Author" && c.text.isNotBlank() && needles.none { c.text.contains(it.text, ignoreCase = true) }) {
                // Any author field in a submission is worth a look, but it is not an identity match.
                out +=
                    ctx.finding(
                        id,
                        null,
                        Severity.MEDIUM,
                        listOf("metadata-author"),
                        "The PDF's Author field is set",
                        c.text,
                        Anchor(c.page, c.key, 0, c.text.length),
                    )
            }
        }
        return out
    }

    private data class Needle(val text: String, val kind: String)

    private fun needles(a: AuthorInfo): List<Needle> {
        val out = mutableListOf<Needle>()
        for (n in a.names) {
            val parts = n.trim().split(Regex("\\s+"))
            out += Needle(n.trim(), "author name")
            if (parts.size >= 2) {
                out += Needle("${parts.first().first()}. ${parts.last()}", "author name")
                out += Needle("${parts.last()}, ${parts.first().first()}.", "author name")
                out += Needle(parts.last(), "author name")
            }
        }
        a.affiliations.forEach { out += Needle(it, "affiliation") }
        a.domains.forEach { out += Needle(it, "author domain") }
        a.handles.forEach { out += Needle(it, "repository owner") }
        return out.filter { it.text.length >= 4 }.distinctBy { it.text.lowercase() }
    }

    /** Matches of any needle in `text`, case-insensitive on normalized text, with word boundaries for names. */
    private fun scan(text: String, needles: List<Needle>, make: (Int, Int, String, String) -> Finding): List<Finding> {
        if (text.isBlank() || needles.isEmpty()) return emptyList()
        val n = NormalizedText(text)
        val out = mutableListOf<Finding>()
        val taken = mutableListOf<IntRange>()
        for (nd in needles.sortedByDescending { it.text.length }) {
            val pat = NormalizedText(nd.text).text
            if (pat.isBlank()) continue
            val re = Regex("(?<![\\p{L}\\p{N}])" + Regex.escape(pat) + "(?![\\p{L}\\p{N}])")
            for (m in re.findAll(n.text)) {
                val r = n.originalRange(m.range.first, m.range.last + 1)
                if (taken.any { it.first <= r.last && r.first <= it.last }) continue
                taken += r
                out += make(r.first, r.last + 1, nd.kind, nd.text)
            }
        }
        return out
    }
}
