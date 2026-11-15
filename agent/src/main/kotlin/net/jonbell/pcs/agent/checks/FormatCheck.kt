package net.jonbell.pcs.agent.checks

import kotlinx.serialization.Serializable
import net.jonbell.pcs.agent.extract.PageText
import net.jonbell.pcs.core.rules.Ground

/**
 * The venue's template, as numbers. The limits belong to a decision (agent.md §3.1, `format.limits`),
 * so they are parameters of the check, not constants of it. The defaults are permissive;
 * [SYNTHETIC] is the template of the synthetic corpus.
 */
@Serializable
data class FormatPolicy(
    val maxPages: Int = 100,
    val pageWidthPt: Float = 612f,
    val pageHeightPt: Float = 792f,
    val sizeTolerancePt: Float = 3f,
    val enforcePageSize: Boolean = false,
    val minMarginPt: Float = 0f,
    val minBodySizePt: Float = 0f,
    /** Body-font prefixes allowed (e.g. `Times`); empty means any. */
    val bodyFontPrefixes: List<String> = emptyList(),
) {
    companion object {
        val SYNTHETIC =
            FormatPolicy(maxPages = 8, enforcePageSize = true, minMarginPt = 54f, minBodySizePt = 9.5f, bodyFontPrefixes = listOf("Times"))
    }
}

/** `format` (agent.md §3.2): page count, page size, margins, and body font from the PDF's layout. No LLM. */
object FormatCheck : Check {
    override val id = "format"

    override fun run(ctx: ScreenContext): List<Finding> {
        val pol = ctx.config.format
        val lay = ctx.x.layout
        val out = mutableListOf<Finding>()

        fun f(vector: String, msg: String, quote: String?, anchor: Anchor, measured: Map<String, String>) =
            out.add(ctx.finding(id, Ground.FORMAT, Severity.HIGH, listOf(vector), msg, quote, anchor, measured))

        if (lay.pageCount > pol.maxPages) {
            f(
                "page-count",
                "The paper has ${lay.pageCount} pages; the limit is ${pol.maxPages}",
                null,
                Anchor(page = lay.pageCount),
                mapOf(
                    "pages" to "${lay.pageCount}",
                    "limit" to "${pol.maxPages}",
                ),
            )
        }
        if (pol.enforcePageSize) {
            lay.pages.firstOrNull {
                kotlin.math.abs(it.width - pol.pageWidthPt) > pol.sizeTolerancePt ||
                    kotlin.math.abs(it.height - pol.pageHeightPt) > pol.sizeTolerancePt
            }?.let { p ->
                f(
                    "page-size",
                    "Page ${p.page} is ${p.width} x ${p.height} pt; the template is ${pol.pageWidthPt} x ${pol.pageHeightPt} pt",
                    null,
                    Anchor(page = p.page),
                    mapOf("width" to "${p.width}", "height" to "${p.height}", "expected" to "${pol.pageWidthPt}x${pol.pageHeightPt}"),
                )
            }
        }
        if (pol.minMarginPt > 0f) marginFinding(ctx, pol)?.let { out += it }
        val size = lay.bodySize
        if (pol.minBodySizePt > 0f && size != null && size < pol.minBodySizePt) {
            val span = firstSpan(ctx) { g -> g.size.coerceAtLeast(0f).let { s -> ((s * 2).toInt() / 2f) == size } }
            out +=
                ctx.finding(
                    id,
                    Ground.FORMAT,
                    Severity.HIGH,
                    listOf("font-size"),
                    "The body text is $size pt; the minimum is ${pol.minBodySizePt} pt",
                    span?.third,
                    Anchor(span?.first, null, span?.second?.first, span?.second?.last?.plus(1), null),
                    mapOf(
                        "bodySize" to "$size",
                        "minimum" to "${pol.minBodySizePt}",
                    ),
                )
        }
        val font = lay.bodyFont
        if (pol.bodyFontPrefixes.isNotEmpty() && font != null && pol.bodyFontPrefixes.none { font.startsWith(it) }) {
            val span = firstSpan(ctx) { g -> g.font == font }
            out +=
                ctx.finding(
                    id,
                    Ground.FORMAT,
                    Severity.HIGH,
                    listOf("font-family"),
                    "The body font is $font; the template uses ${pol.bodyFontPrefixes.joinToString(" or ")}",
                    span?.third,
                    Anchor(span?.first, null, span?.second?.first, span?.second?.last?.plus(1), null),
                    mapOf(
                        "bodyFont" to font,
                        "allowed" to pol.bodyFontPrefixes.joinToString(","),
                    ),
                )
        }
        return out
    }

    /** The first run of body-text characters whose glyph satisfies [want], as (page, range, text). */
    private fun firstSpan(ctx: ScreenContext, want: (net.jonbell.pcs.agent.extract.Glyph) -> Boolean): Triple<Int, IntRange, String>? {
        for (p in ctx.x.pages) {
            val idx =
                p.text.indices.filter { i ->
                    p.glyphAt.getOrElse(i) { -1 }.let { g ->
                        g >= 0 &&
                            !p.text[i].isWhitespace() &&
                            want(p.glyphs[g]) &&
                            visible(p, g)
                    }
                }
            if (idx.isEmpty()) continue
            var e = idx.first()
            while (e + 1 < p.text.length && e - idx.first() < 60 && p.text[e + 1] != '\n') e++
            return Triple(p.page, idx.first()..e, p.text.substring(idx.first(), e + 1))
        }
        return null
    }

    private fun visible(p: PageText, g: Int) =
        p.glyphs[g].let {
            it.renderMode != 3 &&
                !it.hiddenLayer &&
                !it.clipped &&
                !it.covered &&
                it.box.intersects(net.jonbell.pcs.agent.extract.Region(0f, 0f, p.width, p.height))
        }

    private fun marginFinding(ctx: ScreenContext, pol: FormatPolicy): Finding? {
        val min = pol.minMarginPt
        for (p in ctx.x.pages) {
            val lines = p.text.split('\n')
            var off = 0
            for (line in lines) {
                val start = off
                off += line.length + 1
                if (line.isBlank() || line.trim().all { it.isDigit() }) continue
                val gl =
                    line.indices.mapNotNull { i ->
                        p.glyphAt.getOrElse(start + i) { -1 }.takeIf { it >= 0 && !line[i].isWhitespace() }?.let { p.glyphs[it] }
                    }.filter { visible(p, p.glyphs.indexOf(it)) }
                if (gl.isEmpty()) continue
                val box = gl.map { it.box }.reduce { a, b -> a.union(b) }
                val m = mapOf("left" to box.x0, "right" to p.width - box.x1, "top" to p.height - box.y1, "bottom" to box.y0)
                val bad = m.entries.firstOrNull { it.value < min - 0.5f } ?: continue
                val q = line.trim()
                val s = start + line.indexOf(q)
                return ctx.finding(
                    id,
                    Ground.FORMAT,
                    Severity.HIGH,
                    listOf("margins"),
                    "Text on page ${p.page} is ${"%.1f".format(bad.value)} pt from the ${bad.key} edge; the minimum margin is $min pt",
                    q,
                    Anchor(p.page, null, s, s + q.length, p.regionOf(s, s + q.length)),
                    mapOf("edge" to bad.key, "margin" to "%.1f".format(bad.value), "minimum" to "$min"),
                )
            }
        }
        return null
    }
}
