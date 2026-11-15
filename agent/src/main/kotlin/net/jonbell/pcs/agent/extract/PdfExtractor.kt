package net.jonbell.pcs.agent.extract

import org.apache.pdfbox.Loader
import org.apache.pdfbox.contentstream.operator.Operator
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingColor
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingColorN
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingColorSpace
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingDeviceCMYKColor
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingDeviceGrayColor
import org.apache.pdfbox.contentstream.operator.color.SetNonStrokingDeviceRGBColor
import org.apache.pdfbox.contentstream.operator.color.SetStrokingColor
import org.apache.pdfbox.contentstream.operator.color.SetStrokingColorN
import org.apache.pdfbox.contentstream.operator.color.SetStrokingColorSpace
import org.apache.pdfbox.contentstream.operator.color.SetStrokingDeviceCMYKColor
import org.apache.pdfbox.contentstream.operator.color.SetStrokingDeviceGrayColor
import org.apache.pdfbox.contentstream.operator.color.SetStrokingDeviceRGBColor
import org.apache.pdfbox.cos.COSBase
import org.apache.pdfbox.cos.COSDictionary
import org.apache.pdfbox.cos.COSName
import org.apache.pdfbox.pdmodel.PDDocument
import org.apache.pdfbox.pdmodel.PDPage
import org.apache.pdfbox.pdmodel.font.PDSimpleFont
import org.apache.pdfbox.pdmodel.font.encoding.GlyphList
import org.apache.pdfbox.pdmodel.graphics.image.PDImageXObject
import org.apache.pdfbox.pdmodel.graphics.optionalcontent.PDOptionalContentGroup
import org.apache.pdfbox.pdmodel.graphics.optionalcontent.PDOptionalContentProperties
import org.apache.pdfbox.text.PDFTextStripper
import org.apache.pdfbox.text.TextPosition
import java.security.MessageDigest
import java.text.Normalizer
import java.util.IdentityHashMap

/** PDF → [Extraction] with PDFBox (agent.md §8 `extract/`). Deterministic: the same bytes give the same result. */
class PdfExtractor(private val references: ReferenceParser = HeuristicReferenceParser) {
    fun extract(pdf: ByteArray): Extraction = Loader.loadPDF(pdf).use { doc -> extract(doc, sha256(pdf), pdf) }

    fun extract(doc: PDDocument, sha: String, bytes: ByteArray): Extraction {
        val stripper = AnchoredStripper(doc)
        stripper.getText(doc)
        val pages = stripper.pages
        val channels = Channels.read(doc) + stripper.markedChannels
        val layout = layoutOf(pages)
        val partial = Extraction(sha, pages, layout, channels)
        val refsAt = HeuristicReferenceParser.findHeading(partial)
        val withAt = partial.copy(referencesAt = refsAt)
        return withAt.copy(references = references.parse(withAt, bytes))
    }

    companion object {
        fun sha256(b: ByteArray): String = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

        fun layoutOf(pages: List<PageText>): LayoutFacts {
            val fonts = mutableMapOf<String, Int>()
            val sizes = mutableMapOf<String, Int>()
            val layouts =
                pages.map { p ->
                    val page = Region(0f, 0f, p.width, p.height)
                    // Glyphs a reader can see on the page: not invisible by render mode, not off the page, not in a hidden layer.
                    val drawn =
                        p.glyphs.filter {
                            it.renderMode != 3 && it.renderMode != 7 && it.text.isNotBlank() && !it.hiddenLayer && it.box.intersects(page)
                        }
                    drawn.forEach { g ->
                        fonts.merge(g.font, g.text.length, Int::plus)
                        sizes.merge(((g.size * 2).toInt() / 2.0).toString(), g.text.length, Int::plus)
                    }
                    val box = drawn.map { it.box }.reduceOrNull(Region::union)
                    PageLayout(
                        p.page,
                        p.width,
                        p.height,
                        box,
                        box?.x0,
                        box?.let { p.width - it.x1 },
                        box?.let { p.height - it.y1 },
                        box?.y0,
                    )
                }
            return LayoutFacts(
                pageCount = pages.size,
                pages = layouts,
                fonts = fonts.entries.sortedByDescending { it.value }.map { FontUse(it.key, it.value) },
                sizes = sizes.toSortedMap(compareBy { it.toDouble() }),
                bodyFont = fonts.maxByOrNull { it.value }?.key,
                bodySize = sizes.maxByOrNull { it.value }?.key?.toFloat(),
            )
        }

        fun baseFontName(name: String?): String = (name ?: "unknown").substringAfter('+')
    }
}

/**
 * A text stripper that keeps, for every character it emits, the glyph that produced it and the
 * graphics state at the time: render mode, fill colour, clip, optional content, ActualText.
 */
private class AnchoredStripper(private val doc: PDDocument) : PDFTextStripper() {
    val pages = mutableListOf<PageText>()
    val markedChannels = mutableListOf<Channel>()

    private val glyphOf = IdentityHashMap<TextPosition, Glyph>()
    private var sb = StringBuilder()
    private var glyphAt = mutableListOf<Int>()
    private var glyphs = mutableListOf<Glyph>()
    private var glyphSeq = mutableListOf<Int>()
    private var indexOf = IdentityHashMap<TextPosition, Int>()
    private var page: PDPage? = null

    private class Marked(val hidden: Boolean, val actualText: String?, val alt: String?, val members: MutableList<TextPosition> = mutableListOf())

    private val marked = ArrayDeque<Marked>()

    // Content-stream order, rectangle clips, and opaque covers, tracked from the operators because
    // the text engine does not interpret path operators.
    private class Cover(val box: Region, val seq: Int)

    private var seq = 0
    private val drawSeq = IdentityHashMap<TextPosition, Int>()
    private var covers = mutableListOf<Cover>()
    private var clip: Region? = null
    private val clipStack = ArrayDeque<Region?>()
    private val pendingRects = mutableListOf<Region>()
    private var pendingClip = false
    private val closedActual = mutableListOf<Marked>()
    private var altCount = 0
    private val ocProps: PDOptionalContentProperties? = doc.documentCatalog.ocProperties

    init {
        // The text engine does not interpret colour operators; without them every glyph would look black.
        listOf(
            SetNonStrokingDeviceGrayColor(this),
            SetNonStrokingDeviceRGBColor(this),
            SetNonStrokingDeviceCMYKColor(this),
            SetNonStrokingColorSpace(this),
            SetNonStrokingColor(this),
            SetNonStrokingColorN(this),
            SetStrokingDeviceGrayColor(this),
            SetStrokingDeviceRGBColor(this),
            SetStrokingDeviceCMYKColor(this),
            SetStrokingColorSpace(this),
            SetStrokingColor(this),
            SetStrokingColorN(this),
        ).forEach(::addOperator)
        sortByPosition = false
        suppressDuplicateOverlappingText = false
        lineSeparator = "\n"
        wordSeparator = " "
    }

    override fun startPage(page: PDPage) {
        this.page = page
        sb = StringBuilder()
        glyphAt = mutableListOf()
        glyphs = mutableListOf()
        glyphSeq = mutableListOf()
        indexOf = IdentityHashMap()
        glyphOf.clear()
        closedActual.clear()
        altCount = 0
        covers = mutableListOf()
        clip = null
        clipStack.clear()
        pendingRects.clear()
        pendingClip = false
        drawSeq.clear()
        super.startPage(page)
    }

    override fun endPage(page: PDPage) {
        super.endPage(page)
        val n = currentPageNo
        val box = page.cropBox
        val text = sb.toString()
        val finalGlyphs =
            glyphs.mapIndexed { gi, g ->
                val d = glyphSeq.getOrElse(gi) { Int.MAX_VALUE }
                val cov =
                    covers.any {
                        it.seq > d &&
                            it.box.x0 <= g.box.x0 + 0.5f &&
                            it.box.y0 <= g.box.y0 + 0.5f &&
                            it.box.x1 >= g.box.x1 - 0.5f &&
                            it.box.y1 >= g.box.y1 - 0.5f
                    }
                if (cov) g.copy(covered = true) else g
            }
        val pt = PageText(n, box.width, box.height, text, finalGlyphs, glyphAt.toIntArray())
        pages += pt
        closedActual.forEachIndexed { i, m ->
            val idx = m.members.mapNotNull { indexOf[it] }
            val chars = idx.flatMap { g -> glyphAt.indices.filter { glyphAt[it] == g } }
            val s = chars.minOrNull()
            val e = chars.maxOrNull()?.plus(1)
            markedChannels += Channel("actualtext:p$n#$i", m.actualText!!, n, s, e)
        }
    }

    override fun beginMarkedContentSequence(tag: COSName?, properties: COSDictionary?) {
        super.beginMarkedContentSequence(tag, properties)
        val parentHidden = marked.lastOrNull()?.hidden ?: false
        val hidden = parentHidden || (tag == COSName.OC && properties != null && isOff(properties))
        val actual = properties?.getString(COSName.ACTUAL_TEXT)
        val alt = properties?.getString(COSName.ALT)
        if (alt != null) markedChannels += Channel("alt:p$currentPageNo#${altCount++}", alt, currentPageNo)
        marked.addLast(Marked(hidden, actual, alt))
    }

    override fun endMarkedContentSequence() {
        super.endMarkedContentSequence()
        val m = marked.removeLastOrNull() ?: return
        if (m.actualText != null) closedActual += m
    }

    private fun isOff(props: COSDictionary): Boolean {
        val oc = ocProps ?: return false
        return when (props.getCOSName(COSName.TYPE)) {
            COSName.OCG -> !oc.isGroupEnabled(PDOptionalContentGroup(props))
            COSName.getPDFName("OCMD") -> {
                val ocgs = props.getDictionaryObject(COSName.OCGS)
                val list =
                    when (ocgs) {
                        is COSDictionary -> listOf(ocgs)
                        is org.apache.pdfbox.cos.COSArray -> (0 until ocgs.size()).mapNotNull { ocgs.getObject(it) as? COSDictionary }
                        else -> emptyList()
                    }
                list.isNotEmpty() && list.none { oc.isGroupEnabled(PDOptionalContentGroup(it)) }
            }
            else -> false
        }
    }

    override fun processOperator(operator: Operator, operands: List<COSBase>) {
        seq++
        val gs = graphicsState
        when (operator.name) {
            "q" -> clipStack.addLast(clip)
            "Q" -> if (clipStack.isNotEmpty()) clip = clipStack.removeLast()
            "re" -> {
                val n = operands.filterIsInstance<org.apache.pdfbox.cos.COSNumber>().map { it.floatValue() }
                if (n.size == 4) {
                    val m = gs.currentTransformationMatrix
                    val pts = listOf(0f to 0f, n[2] to 0f, 0f to n[3], n[2] to n[3]).map { (dx, dy) -> m.transformPoint(n[0] + dx, n[1] + dy) }
                    pendingRects += Region(pts.minOf { it.x }, pts.minOf { it.y }, pts.maxOf { it.x }, pts.maxOf { it.y })
                }
            }
            "W", "W*" -> pendingClip = true
            "f", "F", "f*", "B", "B*", "b", "b*" -> {
                if (gs.nonStrokeAlphaConstant >= 0.999) pendingRects.forEach { covers += Cover(it, seq) }
                endPath()
            }
            "n", "S", "s" -> endPath()
            "Do" -> {
                val name = operands.firstOrNull() as? COSName
                val xo = name?.let { runCatching { resources.getXObject(it) }.getOrNull() }
                if (xo is PDImageXObject && gs.nonStrokeAlphaConstant >= 0.999) {
                    val m = gs.currentTransformationMatrix
                    val pts = listOf(0f to 0f, 1f to 0f, 0f to 1f, 1f to 1f).map { (x, y) -> m.transformPoint(x, y) }
                    covers += Cover(Region(pts.minOf { it.x }, pts.minOf { it.y }, pts.maxOf { it.x }, pts.maxOf { it.y }), seq)
                }
            }
        }
        super.processOperator(operator, operands)
    }

    private fun endPath() {
        if (pendingClip && pendingRects.isNotEmpty()) {
            val r = pendingRects.reduce(Region::union)
            clip = clip?.let { c -> Region(maxOf(c.x0, r.x0), maxOf(c.y0, r.y0), minOf(c.x1, r.x1), minOf(c.y1, r.y1)) } ?: r
        }
        pendingClip = false
        pendingRects.clear()
    }

    override fun processTextPosition(text: TextPosition) {
        val gs = graphicsState
        val tm = text.textMatrix
        val size = text.fontSizeInPt
        val x = tm.translateX
        val y = tm.translateY
        val w = maxOf(text.width, 0.1f)
        val box = Region(x, y - 0.22f * size, x + w, y + 0.72f * size)
        val mode = gs.textState.renderingMode.intValue()
        val color = if (mode == 1 || mode == 5) gs.strokingColor else gs.nonStrokingColor
        val rgb = runCatching { color.toRGB() }.getOrDefault(0)
        val cx = (box.x0 + box.x1) / 2.0
        val cy = (box.y0 + box.y1) / 2.0
        val clipped = clip?.let { c -> cx < c.x0 || cx > c.x1 || cy < c.y0 || cy > c.y1 } ?: false
        drawSeq[text] = seq
        val glyph =
            Glyph(
                text = text.unicode ?: "",
                box = box,
                font = PdfExtractor.baseFontName(text.font?.name),
                size = size,
                renderMode = mode,
                fillRgb = rgb and 0xFFFFFF,
                clipped = clipped,
                hiddenLayer = marked.lastOrNull()?.hidden ?: false,
                remapped = isRemapped(text),
            )
        glyphOf[text] = glyph
        marked.lastOrNull { it.actualText != null }?.members?.add(text)
        super.processTextPosition(text)
    }

    /** True when a simple font's ToUnicode map gives characters other than the glyph its encoding names. */
    private fun isRemapped(t: TextPosition): Boolean {
        val font = t.font as? PDSimpleFont ?: return false
        if (!font.cosObject.containsKey(COSName.TO_UNICODE)) return false
        val enc = font.encoding ?: return false
        val expected = t.characterCodes.joinToString("") { code -> enc.getName(code)?.let { GlyphList.getAdobeGlyphList().toUnicode(it) } ?: "" }
        if (expected.isEmpty()) return false
        val norm = { s: String -> Normalizer.normalize(s, Normalizer.Form.NFKC) }
        return norm(expected) != norm(t.unicode ?: "")
    }

    override fun writeString(text: String, textPositions: List<TextPosition>) {
        for (tp in textPositions) {
            val g = glyphOf[tp] ?: continue
            val gi =
                indexOf.getOrPut(tp) {
                    glyphs.add(g)
                    glyphSeq.add(drawSeq[tp] ?: 0)
                    glyphs.size - 1
                }
            for (c in g.text) {
                sb.append(c)
                glyphAt += gi
            }
        }
    }

    override fun writeString(text: String) = sep(text)

    override fun writeLineSeparator() = sep(lineSeparator)

    override fun writeWordSeparator() = sep(wordSeparator)

    private fun sep(s: String) {
        for (c in s) {
            sb.append(c)
            glyphAt += -1
        }
    }
}
