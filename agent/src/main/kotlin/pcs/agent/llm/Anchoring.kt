package pcs.agent.llm

import kotlinx.serialization.Serializable
import pcs.agent.checks.ScreenContext
import pcs.agent.extract.Extraction
import pcs.agent.extract.Invisible
import java.text.Normalizer

/**
 * Where a flag's evidence is (agent.md §6): a span of a page's text, of a channel's text, or of a
 * reference's abstract in the record the check was given. [quote] is the text found at the anchor,
 * never the model's own wording.
 */
@Serializable
data class FlagAnchor(
    val source: String,
    val start: Int,
    val end: Int,
    val quote: String,
    val page: Int? = null,
    val channel: String? = null,
    /** For [SOURCE_ABSTRACT]: the reference's label, e.g. `[3]`. */
    val ref: String? = null,
    /** What the quotation is for: `claim`, `citing sentence`, `abstract`... */
    val label: String = "",
) {
    companion object {
        const val SOURCE_PAGE = "page"
        const val SOURCE_CHANNEL = "channel"
        const val SOURCE_ABSTRACT = "reference-abstract"
    }
}

/** A range of page text taken out of what a model reads. */
data class Span(val page: Int, val start: Int, val end: Int)

/**
 * The text of the paper a model is allowed to read: the page texts with hidden spans and invisible
 * characters removed (agent.md §5.2), and optionally more spans cut out (the suspect spans of the
 * `injection.effect` rerun). [stripHidden] is false only for the synthetic-only probe that measures
 * what the stripping step is worth.
 */
class PaperView(val ctx: ScreenContext, val stripHidden: Boolean = true, private val extra: List<Span> = emptyList()) {
    val x: Extraction get() = ctx.x

    fun without(spans: List<Span>) = PaperView(ctx, stripHidden, extra + spans)

    private fun removed(page: Int): List<Span> =
        (
            (if (stripHidden) ctx.hidden.spans.filter { it.channel == null && it.page == page }.map { Span(page, it.start, it.end) } else emptyList()) +
                extra.filter { it.page == page }
        )
            .sortedBy { it.start }

    private fun cut(page: Int, limit: Int): String {
        val text = x.page(page).text
        val sb = StringBuilder()
        var at = 0
        for (s in removed(page)) {
            if (s.start >= limit) break
            if (s.start > at) sb.append(text, at, s.start)
            at = maxOf(at, s.end)
        }
        if (at < limit) sb.append(text, at, limit)
        return stripInvisible(sb.toString())
    }

    /** The length of page [page]'s body: the whole page, or the part before the bibliography. 0 for a bibliography-only page. */
    fun bodyLimit(page: Int): Int {
        val at = x.referencesAt ?: return x.page(page).text.length
        return when {
            page < at.first -> x.page(page).text.length
            page == at.first -> at.second
            else -> 0
        }
    }

    /** The body, page by page, with page markers. Removed spans are cut out; the bibliography is not included. */
    fun bodyText(maxChars: Int = Int.MAX_VALUE): String {
        val sb = StringBuilder()
        for (p in x.pages) {
            val limit = bodyLimit(p.page)
            if (limit == 0) continue
            sb.append("[page ${p.page}]\n").append(cut(p.page, limit)).append("\n\n")
            if (sb.length >= maxChars) break
        }
        return sb.toString().take(maxChars).trimEnd()
    }

    /** The bibliography entries as the extractor parsed them, one per line, for a check that may name a cited work. */
    fun referenceList(): String = x.references.joinToString("\n") { it.raw.replace(Regex("\\s+"), " ") }

    /** Whether a range of page text is one a model of this view never saw. */
    fun inHidden(page: Int, start: Int, end: Int) = removed(page).any { start < it.end && it.start < end }

    private fun stripInvisible(s: String): String {
        val sb = StringBuilder()
        var i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            if (!Invisible.isInvisible(cp)) sb.appendCodePoint(cp)
            i += Character.charCount(cp)
        }
        return sb.toString()
    }
}

/**
 * Locates a quotation in text, tolerating differences of whitespace, ligatures (NFKC), soft hyphens,
 * and curly quotes, and reports the span of the original text (agent.md §6, prop:S4).
 */
object Anchoring {
    private class Folded(val text: String, val origin: IntArray)

    private fun fold(s: String): Folded {
        val sb = StringBuilder()
        val map = ArrayList<Int>()
        var i = 0
        while (i < s.length) {
            val cp = s.codePointAt(i)
            val n = Character.charCount(cp)
            if (cp != 0xAD && !Invisible.isInvisible(cp)) {
                for (c in Normalizer.normalize(String(Character.toChars(cp)), Normalizer.Form.NFKC)) {
                    val d =
                        when (c) {
                            '‘', '’' -> '\''
                            '“', '”' -> '"'
                            '‐', '‑', '‒', '–', '−' -> '-'
                            else -> c
                        }
                    if (d.isWhitespace()) {
                        if (sb.isNotEmpty() && sb.last() != ' ') {
                            sb.append(' ')
                            map += i
                        }
                    } else {
                        sb.append(d)
                        map += i
                    }
                }
            }
            i += n
        }
        return Folded(sb.toString(), map.toIntArray())
    }

    /** The shortest quotation we accept as evidence: shorter strings match by accident. */
    const val MIN_QUOTE = 10

    /** The span of [text] that [quote] stands for, or null. When there are several matches, the first one not overlapping [exclude]. */
    fun find(text: String, quote: String, exclude: (Int, Int) -> Boolean = { _, _ -> false }): IntRange? {
        val q = fold(quote).text.trim()
        if (q.length < MIN_QUOTE) return null
        val f = fold(text)
        var from = 0
        while (true) {
            val at = f.text.indexOf(q, from)
            if (at < 0) return null
            val s = f.origin[at]
            val last = f.origin[at + q.length - 1]
            val e = last + Character.charCount(text.codePointAt(last))
            if (!exclude(s, e)) return s until e
            from = at + 1
        }
    }

    /** Locates [quote] in the text of a page, trying [hint] first. A match inside a hidden span is no match: a model never saw it. */
    fun locatePage(view: PaperView, quote: String, hint: Int?, label: String = ""): FlagAnchor? {
        val pages = view.x.pages.map { it.page }
        val order = (listOfNotNull(hint?.takeIf { it in pages }) + pages).distinct()
        for (p in order) {
            val limit = view.bodyLimit(p)
            val text = view.x.page(p).text
            val r = find(text, quote) { s, e -> view.inHidden(p, s, e) || e > limit } ?: continue
            return FlagAnchor(FlagAnchor.SOURCE_PAGE, r.first, r.last + 1, text.substring(r.first, r.last + 1), page = p, label = label)
        }
        return null
    }

    /** Locates [quote] in a reference's abstract. */
    fun locateAbstract(abstract: String, quote: String, ref: String, label: String = "abstract"): FlagAnchor? {
        val r = find(abstract, quote) ?: return null
        return FlagAnchor(FlagAnchor.SOURCE_ABSTRACT, r.first, r.last + 1, abstract.substring(r.first, r.last + 1), ref = ref, label = label)
    }

    /** Re-checks a stored anchor against the text it points at (S4). */
    fun verify(a: FlagAnchor, x: Extraction, abstracts: Map<String, String> = emptyMap()): Boolean {
        val text =
            when (a.source) {
                FlagAnchor.SOURCE_PAGE -> a.page?.let { p -> x.pages.getOrNull(p - 1)?.text }
                FlagAnchor.SOURCE_CHANNEL -> a.channel?.let { x.channel(it)?.text }
                FlagAnchor.SOURCE_ABSTRACT -> a.ref?.let { abstracts[it] }
                else -> null
            } ?: return false
        return a.start >= 0 && a.end <= text.length && a.start < a.end && text.substring(a.start, a.end) == a.quote
    }
}
