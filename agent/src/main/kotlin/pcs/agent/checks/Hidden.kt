package pcs.agent.checks

import pcs.agent.extract.Extraction
import pcs.agent.extract.Invisible
import pcs.agent.extract.Ocr
import pcs.agent.extract.PageText
import pcs.agent.extract.Region
import java.text.Normalizer

/** Text a model would read that a person would not see: where it is, which detectors saw it, and what it says. */
data class HiddenSpan(
    val page: Int,
    val start: Int,
    val end: Int,
    val vectors: List<String>,
    val text: String,
    val region: Region?,
    /** What the span decodes to where an encoding is recognizable (Unicode tags, zero-width binary, bidi). */
    val decoded: String? = null,
    /** `[start, end)` in a channel's text rather than the page's (ActualText, alt text). */
    val channel: String? = null,
)

class HiddenAnalysis(val spans: List<HiddenSpan>) {
    fun overlaps(page: Int, start: Int, end: Int) = spans.any { it.channel == null && it.page == page && start < it.end && it.start < end }
}

/**
 * `injection.hidden` (agent.md §3.2): the render-and-OCR diff, plus a direct detector per known
 * vector. Vectors: `render-mode-3`, `fill-matches-background`, `tiny-font`, `clipped`,
 * `off-page`, `covered`, `optional-content-off`, `tounicode-remap`, `actualtext`, `alt-text`,
 * `zero-width`, `unicode-tag`, `bidi-override`, `ocr-diff`.
 */
object HiddenDetector {
    const val MIN_FONT_PT = 2f
    private const val RING_PT = 2.5f
    private const val FILL_TOLERANCE = 16

    private val priority =
        listOf(
            "render-mode-3",
            "fill-matches-background",
            "tiny-font",
            "clipped",
            "off-page",
            "covered",
            "optional-content-off",
            "tounicode-remap",
            "zero-width",
            "unicode-tag",
            "bidi-override",
            "actualtext",
            "alt-text",
            "ocr-diff",
        )

    fun analyze(ctx: ScreenContext): HiddenAnalysis {
        val spans = mutableListOf<HiddenSpan>()
        for (p in ctx.x.pages) {
            if (ctx.config.hiddenVectors) {
                spans += glyphVectors(ctx, p)
                spans += invisibleChars(p)
            }
            ctx.config.ocr?.let { ocr -> spans += ocrDiff(ctx, p, ocr) }
        }
        if (ctx.config.hiddenVectors) spans += markedChannels(ctx.x)
        return HiddenAnalysis(consolidate(spans, ctx.x))
    }

    // ---- per-glyph vectors ------------------------------------------------------------

    private fun glyphVectors(ctx: ScreenContext, p: PageText): List<HiddenSpan> {
        val flagged = HashMap<String, BooleanArray>()

        fun mark(v: String, i: Int) {
            flagged.getOrPut(v) { BooleanArray(p.text.length) }[i] = true
        }
        val pageBox = Region(0f, 0f, p.width, p.height)
        for (i in p.text.indices) {
            val gi = p.glyphAt.getOrElse(i) { -1 }
            if (gi < 0 || p.text[i].isWhitespace()) continue
            val g = p.glyphs[gi]
            if (g.renderMode == 3 || g.renderMode == 7) mark("render-mode-3", i)
            if (g.size < MIN_FONT_PT) mark("tiny-font", i)
            if (!g.box.intersects(pageBox)) mark("off-page", i)
            if (g.clipped && g.box.intersects(pageBox)) mark("clipped", i)
            if (g.covered) mark("covered", i)
            if (g.hiddenLayer) mark("optional-content-off", i)
            if (g.remapped) mark("tounicode-remap", i)
        }
        fillMatchesBackground(ctx, p, flagged)
        flagged["tounicode-remap"]?.let { fillGaps(p, it, 3) }
        return flagged.flatMap { (v, bits) -> runs(p, bits).map { (s, e) -> span(p, s, e, listOf(v)) } }
    }

    /**
     * In a font whose ToUnicode map is wrong, a few characters come out right by chance. Unflagged
     * characters of the same font, at most [maxGap] of them between two flagged ones, belong to the span.
     */
    private fun fillGaps(p: PageText, bits: BooleanArray, maxGap: Int) {
        val idx = p.text.indices.filter { i -> p.glyphAt.getOrElse(i) { -1 } >= 0 && !p.text[i].isWhitespace() }
        var last = -1
        for ((k, i) in idx.withIndex()) {
            if (!bits[i]) continue
            if (last >= 0 && k - last - 1 in 1..maxGap) {
                val fontA = p.glyphs[p.glyphAt[idx[last]]].font
                val between = idx.subList(last + 1, k)
                if (between.all { p.glyphs[p.glyphAt[it]].font == fontA }) between.forEach { bits[it] = true }
            }
            last = k
        }
    }

    /** Line runs of one fill colour, whose colour is the colour of the pixels around them. */
    private fun fillMatchesBackground(ctx: ScreenContext, p: PageText, flagged: HashMap<String, BooleanArray>) {
        val gl = p.glyphs
        var i = 0
        val n = p.text.length
        while (i < n) {
            val gi = p.glyphAt.getOrElse(i) { -1 }
            if (gi < 0 || p.text[i].isWhitespace()) {
                i++
                continue
            }
            val fill = gl[gi].fillRgb
            var j = i
            var box = gl[gi].box
            while (j < n) {
                val gj = p.glyphAt.getOrElse(j) { -1 }
                if (p.text[j] == '\n') break
                if (gj >= 0 && !p.text[j].isWhitespace()) {
                    if (gl[gj].fillRgb != fill) break
                    box = box.union(gl[gj].box)
                }
                j++
            }
            if (visibleCandidate(gl[gi], p) && ringColor(ctx, p.page, box, p)?.let { close(it, fill) } == true) {
                for (k in i until j) {
                    if (p.glyphAt.getOrElse(k) { -1 } >= 0 &&
                        !p.text[k].isWhitespace()
                    ) {
                        flagged.getOrPut("fill-matches-background") { BooleanArray(n) }[k] = true
                    }
                }
            }
            i = maxOf(j, i + 1)
        }
    }

    private fun visibleCandidate(g: pcs.agent.extract.Glyph, p: PageText) = g.renderMode != 3 && g.box.intersects(Region(0f, 0f, p.width, p.height))

    private fun close(a: Int, b: Int): Boolean {
        fun ch(v: Int, s: Int) = (v shr s) and 0xFF
        return listOf(16, 8, 0).all { kotlin.math.abs(ch(a, it) - ch(b, it)) <= FILL_TOLERANCE }
    }

    /** The commonest colour in a ring just outside [box], from a render of the page; null if the ring is off the page. */
    private fun ringColor(ctx: ScreenContext, page: Int, box: Region, p: PageText): Int? {
        val scale = 1f
        val img = ctx.renderer.image(page, scale)
        val x0 = ((box.x0 - RING_PT) * scale).toInt().coerceAtLeast(0)
        val x1 = ((box.x1 + RING_PT) * scale).toInt().coerceAtMost(img.width - 1)
        val yTop = ((p.height - box.y1 - RING_PT) * scale).toInt().coerceAtLeast(0)
        val yBot = ((p.height - box.y0 + RING_PT) * scale).toInt().coerceAtMost(img.height - 1)
        if (x1 <= x0 || yBot <= yTop) return null
        val ix0 = (box.x0 * scale).toInt()
        val ix1 = (box.x1 * scale).toInt()
        val iy0 = ((p.height - box.y1) * scale).toInt()
        val iy1 = ((p.height - box.y0) * scale).toInt()
        val buckets = HashMap<Int, IntArray>()
        for (y in yTop..yBot) {
            for (x in x0..x1) {
                if (x in ix0..ix1 && y in iy0..iy1) continue
                val rgb = img.getRGB(x, y) and 0xFFFFFF
                val key = ((rgb shr 19) shl 10) or (((rgb shr 11) and 0x1F) shl 5) or ((rgb shr 3) and 0x1F)
                val b = buckets.getOrPut(key) { IntArray(4) }
                b[0]++
                b[1] += rgb shr 16
                b[2] += (rgb shr 8) and 0xFF
                b[3] += rgb and 0xFF
            }
        }
        val top = buckets.values.maxByOrNull { it[0] } ?: return null
        return ((top[1] / top[0]) shl 16) or ((top[2] / top[0]) shl 8) or (top[3] / top[0])
    }

    // ---- invisible characters and marked content -----------------------------------------

    private fun invisibleChars(p: PageText): List<HiddenSpan> =
        Invisible.runs(p.text).map { r ->
            val vector =
                when {
                    Invisible.Kind.TAG in r.kinds -> "unicode-tag"
                    Invisible.Kind.BIDI in r.kinds -> "bidi-override"
                    else -> "zero-width"
                }
            span(p, r.start, r.end, listOf(vector), r.decoded)
        }

    private fun markedChannels(x: Extraction): List<HiddenSpan> {
        val out = mutableListOf<HiddenSpan>()
        for (c in x.channels) {
            when {
                c.key.startsWith("actualtext:") -> {
                    val page = c.page?.let { x.pages.getOrNull(it - 1) } ?: continue
                    val under = if (c.coversStart != null && c.coversEnd != null) page.text.substring(c.coversStart, c.coversEnd) else ""
                    if (fold(under) != fold(c.text)) out += HiddenSpan(page.page, 0, c.text.length, listOf("actualtext"), c.text, null, channel = c.key)
                }
                c.key.startsWith("alt:") -> {
                    // Alt text is legitimate in tagged PDFs; it is hidden text only when it addresses a reader that is not a person.
                    if (AddressedPatterns.scan(c.text).isNotEmpty()) {
                        out +=
                            HiddenSpan(c.page ?: 1, 0, c.text.length, listOf("alt-text"), c.text, null, channel = c.key)
                    }
                }
            }
        }
        return out
    }

    private fun fold(s: String) = Normalizer.normalize(s, Normalizer.Form.NFKC).filter { it.isLetterOrDigit() }.lowercase()

    // ---- render-and-OCR diff -------------------------------------------------------------

    private class W(val norm: String, val start: Int, val end: Int)

    private fun words(s: String): List<W> =
        Regex("""\S+""").findAll(s).mapNotNull { m ->
            val n = Normalizer.normalize(m.value, Normalizer.Form.NFKC).lowercase().filter { it.isLetterOrDigit() }
            if (n.isEmpty()) null else W(n, m.range.first, m.range.last + 1)
        }.toList()

    private fun lev1(a: String, b: String): Boolean {
        if (a == b) return true
        if (kotlin.math.abs(a.length - b.length) > 1 || minOf(a.length, b.length) < 5) return false
        var i = 0
        while (i < minOf(a.length, b.length) && a[i] == b[i]) i++
        var ea = a.length
        var eb = b.length
        while (ea > i && eb > i && a[ea - 1] == b[eb - 1]) {
            ea--
            eb--
        }
        return maxOf(ea - i, eb - i) <= 1
    }

    /**
     * Words of the text layer that the page's OCR does not contain, in runs of at least
     * [minRun] consecutive words (single dropped words are OCR noise). Words found only by OCR
     * (text drawn as pixels) have no anchor in the text layer and are not findings (assume A5).
     */
    fun ocrDiff(ctx: ScreenContext, p: PageText, ocr: Ocr, minRun: Int = 3): List<HiddenSpan> {
        val ocrText = ocr.recognize(p.page) { ctx.renderer.image(p.page, Ocr.SCALE) }
        val a = words(p.text)
        val b = words(ocrText)
        if (a.isEmpty()) return emptyList()
        val dp = Array(a.size + 1) { IntArray(b.size + 1) }
        for (i in a.indices.reversed()) {
            for (j in b.indices.reversed()) {
                dp[i][j] = if (lev1(a[i].norm, b[j].norm)) dp[i + 1][j + 1] + 1 else maxOf(dp[i + 1][j], dp[i][j + 1])
            }
        }
        val matched = BooleanArray(a.size)
        var i = 0
        var j = 0
        while (i < a.size && j < b.size) {
            if (lev1(a[i].norm, b[j].norm) && dp[i][j] == dp[i + 1][j + 1] + 1) {
                matched[i] = true
                i++
                j++
            } else if (dp[i + 1][j] >= dp[i][j + 1]) {
                i++
            } else {
                j++
            }
        }
        val out = mutableListOf<HiddenSpan>()
        var k = 0
        while (k < a.size) {
            if (matched[k]) {
                k++
                continue
            }
            var e = k
            while (e < a.size && !matched[e]) e++
            if (e - k >= minRun) out += span(p, a[k].start, a[e - 1].end, listOf("ocr-diff"))
            k = e
        }
        return out
    }

    // ---- spans ---------------------------------------------------------------------------

    private fun runs(p: PageText, bits: BooleanArray): List<Pair<Int, Int>> {
        val out = mutableListOf<Pair<Int, Int>>()
        var i = 0
        while (i < bits.size) {
            if (!bits[i]) {
                i++
                continue
            }
            var e = i + 1
            var last = i
            // Bridge separators and spaces between flagged characters; stop at the first unflagged real character.
            while (e < bits.size) {
                if (bits[e]) {
                    last = e
                } else if (!(p.text[e].isWhitespace() || p.glyphAt.getOrElse(e) { -1 } < 0)) {
                    break
                }
                e++
            }
            out += i to last + 1
            i = e
        }
        return out
    }

    private fun span(p: PageText, s: Int, e: Int, vectors: List<String>, decoded: String? = null) =
        HiddenSpan(p.page, s, e, vectors, p.text.substring(s, e), p.regionOf(s, e), decoded)

    /** The strings of a span to scan for addressed text: what it says and what it decodes to. */
    fun payloads(span: HiddenSpan): List<String> = listOfNotNull(span.text, span.decoded)

    private fun consolidate(spans: List<HiddenSpan>, x: Extraction): List<HiddenSpan> {
        val out = mutableListOf<HiddenSpan>()
        val (page, chan) = spans.partition { it.channel == null }
        for ((n, group) in page.groupBy { it.page }) {
            val p = x.page(n)
            val sorted = group.sortedBy { it.start }
            var cur: HiddenSpan? = null
            for (s in sorted) {
                val c = cur
                cur =
                    if (c != null && s.start < c.end) {
                        val st = minOf(c.start, s.start)
                        val en = maxOf(c.end, s.end)
                        HiddenSpan(n, st, en, c.vectors + s.vectors, p.text.substring(st, en), p.regionOf(st, en), c.decoded ?: s.decoded)
                    } else {
                        cur?.let { out += it }
                        s
                    }
            }
            cur?.let { out += it }
        }
        return (out + chan).map { it.copy(vectors = it.vectors.distinct().sortedBy { v -> priority.indexOf(v) }) }
            .sortedWith(compareBy({ it.page }, { it.channel ?: "" }, { it.start }))
    }
}
