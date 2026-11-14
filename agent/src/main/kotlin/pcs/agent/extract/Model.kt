package pcs.agent.extract

import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient

/*
 * Extraction (docs/concepts.md §3.6; agent.md §2): a PDF turned into quotable text with page
 * anchors, layout facts, parsed references, and everything a reader would not see. Principle:
 * a quotation shown to anyone is one that Extraction can find (prop:S4).
 *
 * Coordinates are PDF user space in points, origin at the bottom left of the page.
 */

@Serializable
data class Region(val x0: Float, val y0: Float, val x1: Float, val y1: Float) {
    fun union(o: Region) = Region(minOf(x0, o.x0), minOf(y0, o.y0), maxOf(x1, o.x1), maxOf(y1, o.y1))

    fun intersects(o: Region) = x0 < o.x1 && o.x0 < x1 && y0 < o.y1 && o.y0 < y1

    val width get() = x1 - x0
    val height get() = y1 - y0
}

/** One drawn glyph and the graphics state it was drawn in. */
@Serializable
data class Glyph(
    val text: String,
    val box: Region,
    val font: String,
    val size: Float,
    val renderMode: Int,
    val fillRgb: Int,
    /** The glyph lies outside the clipping path in force when it was drawn. */
    val clipped: Boolean,
    /** Drawn inside optional content that is off by default. */
    val hiddenLayer: Boolean,
    /** The extracted characters differ from the glyph the font's encoding names (ToUnicode remapping). */
    val remapped: Boolean,
)

/**
 * The text layer of one page. [text] is what a text extractor (and so a model) reads, hidden text
 * included. `glyphAt[i]` is the index into [glyphs] that produced character `i`, or -1 for a
 * separator the extractor inserted.
 */
@Serializable
data class PageText(
    val page: Int,
    val width: Float,
    val height: Float,
    val text: String,
    val glyphs: List<Glyph>,
    @Transient val glyphAt: IntArray = IntArray(0),
) {
    fun regionOf(start: Int, end: Int): Region? =
        (start until end).mapNotNull { glyphAt.getOrNull(it)?.takeIf { g -> g >= 0 }?.let { g -> glyphs[g].box } }
            .reduceOrNull(Region::union)
}

/** Text outside the page content that a tool might hand to a model (agent.md §3.2 `injection.channels`). */
@Serializable
data class Channel(
    /** e.g. `info:Subject`, `xmp`, `annot:p2#0`, `form:comments`, `bookmark:3`, `embedded:notes.txt`, `js:OpenAction`, `actualtext:p1#0`, `alt:p1#0`. */
    val key: String,
    val text: String,
    val page: Int? = null,
    /** For `actualtext:`: the page-text range the replacement text stands for. */
    val coversStart: Int? = null,
    val coversEnd: Int? = null,
)

@Serializable
data class FontUse(val font: String, val chars: Int)

@Serializable
data class PageLayout(
    val page: Int,
    val width: Float,
    val height: Float,
    /** Bounding box of the drawn text that lies on the page, or null for a page without text. */
    val textBox: Region?,
    val marginLeft: Float?,
    val marginRight: Float?,
    val marginTop: Float?,
    val marginBottom: Float?,
)

@Serializable
data class LayoutFacts(
    val pageCount: Int,
    val pages: List<PageLayout>,
    val fonts: List<FontUse>,
    /** Characters per font size, rounded to 0.5 pt. */
    val sizes: Map<String, Int>,
    val bodyFont: String?,
    val bodySize: Float?,
)

/** A bibliography entry, located in the page text. */
@Serializable
data class Reference(
    val label: String,
    val raw: String,
    val page: Int,
    val start: Int,
    val end: Int,
    val doi: String? = null,
    val title: String? = null,
    val authors: List<String> = emptyList(),
    val year: Int? = null,
)

@Serializable
data class Extraction(
    val sha256: String,
    val pages: List<PageText>,
    val layout: LayoutFacts,
    val channels: List<Channel>,
    val references: List<Reference> = emptyList(),
    /** The page and character offset where the bibliography starts, if one was found. */
    val referencesAt: Pair<Int, Int>? = null,
) {
    fun page(n: Int): PageText = pages[n - 1]

    fun channel(key: String): Channel? = channels.firstOrNull { it.key == key }
}
