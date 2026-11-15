package net.jonbell.pcs.agent.extract

import org.apache.pdfbox.cos.COSArray
import org.apache.pdfbox.cos.COSBase
import org.apache.pdfbox.cos.COSDictionary
import org.apache.pdfbox.cos.COSName
import org.apache.pdfbox.cos.COSObject
import org.apache.pdfbox.cos.COSStream
import org.apache.pdfbox.cos.COSString
import org.apache.pdfbox.pdmodel.PDDocument
import org.apache.pdfbox.pdmodel.common.PDNameTreeNode
import org.apache.pdfbox.pdmodel.common.filespecification.PDComplexFileSpecification
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationFileAttachment
import org.apache.pdfbox.pdmodel.interactive.annotation.PDAnnotationWidget
import org.apache.pdfbox.pdmodel.interactive.documentnavigation.outline.PDOutlineNode
import org.apache.pdfbox.pdmodel.interactive.form.PDField
import org.apache.pdfbox.pdmodel.interactive.form.PDNonTerminalField
import org.w3c.dom.Node
import java.io.ByteArrayInputStream
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilderFactory

/**
 * The non-page channels of a PDF (agent.md §3.2 `injection.channels`): document info, XMP,
 * annotations, form fields, bookmarks, embedded files, and JavaScript anywhere in the file.
 * Marked-content ActualText and alt text come from the page stripper.
 */
object Channels {
    private const val MAX_EMBEDDED = 64 * 1024

    fun read(doc: PDDocument): List<Channel> {
        val out = mutableListOf<Channel>()
        doc.documentInformation?.cosObject?.let { info ->
            info.keySet().sortedBy { it.name }.forEach { k ->
                (info.getDictionaryObject(k) as? COSString)?.string?.takeIf { it.isNotBlank() }?.let { out += Channel("info:${k.name}", it) }
            }
        }
        doc.documentCatalog.metadata?.let { md ->
            runCatching { xmpText(md.toByteArray()) }.getOrNull()?.takeIf { it.isNotBlank() }?.let { out += Channel("xmp", it) }
        }
        doc.pages.forEachIndexed { pi, page ->
            val n = pi + 1
            page.annotations.forEachIndexed { ai, a ->
                if (a is PDAnnotationWidget) return@forEachIndexed
                val parts =
                    listOfNotNull(
                        a.contents,
                        a.cosObject.getString(COSName.T),
                        a.cosObject.getString(COSName.SUBJ),
                        a.cosObject.getString(COSName.RC),
                    ).filter { it.isNotBlank() }
                if (parts.isNotEmpty()) out += Channel("annot:p$n#$ai", parts.joinToString("\n"), n)
                if (a is PDAnnotationFileAttachment) {
                    (a.file as? PDComplexFileSpecification)?.let { fs -> embedded(fs, "annot-file:p$n#$ai")?.let { out += it } }
                }
            }
        }
        doc.documentCatalog.acroForm?.let { form ->
            fun walk(f: PDField) {
                if (f is PDNonTerminalField) f.children.forEach(::walk)
                val c = f.cosObject
                val parts =
                    listOf(COSName.V, COSName.DV, COSName.TU, COSName.TM).mapNotNull { k ->
                        when (val v = c.getDictionaryObject(k)) {
                            is COSString -> v.string
                            is COSStream -> v.toTextString()
                            else -> null
                        }
                    }.filter { it.isNotBlank() }
                if (parts.isNotEmpty()) out += Channel("form:${f.fullyQualifiedName}", parts.joinToString("\n"))
            }
            form.fields.forEach(::walk)
        }
        doc.documentCatalog.documentOutline?.let { outline ->
            var i = 0

            fun walk(node: PDOutlineNode) {
                node.children().forEach { item ->
                    item.title?.takeIf { it.isNotBlank() }?.let { out += Channel("bookmark:${i++}", it) }
                    walk(item)
                }
            }
            walk(outline)
        }
        doc.documentCatalog.names?.embeddedFiles?.let { tree ->
            names(tree).forEach { (name, fs) -> embedded(fs, "embedded:$name")?.let { out += it } }
        }
        // JavaScript anywhere in the object graph: OpenAction, additional actions, annotations, fields, the names tree.
        val seen = java.util.IdentityHashMap<Any, Boolean>()
        val stack = ArrayDeque<COSBase>()
        stack.addLast(doc.document.trailer)
        var n = 0
        while (stack.isNotEmpty()) {
            val raw = stack.removeLast()
            val o = if (raw is COSObject) raw.getObject() else raw
            if (o == null || seen.put(o, true) != null) continue
            when (o) {
                is COSDictionary -> {
                    val text =
                        when (val js = o.getDictionaryObject(COSName.JS)) {
                            is COSString -> js.string
                            is COSStream -> js.toTextString()
                            else -> null
                        }
                    if (!text.isNullOrBlank()) out += Channel("js:${n++}", text)
                    o.entrySet().sortedBy { it.key.name }.reversed().forEach { stack.addLast(it.value) }
                }
                is COSArray -> (o.size() - 1 downTo 0).forEach { stack.addLast(o.get(it)) }
            }
        }
        return out
    }

    private fun <T : org.apache.pdfbox.pdmodel.common.COSObjectable> names(node: PDNameTreeNode<T>): List<Pair<String, T>> =
        node.names.orEmpty().entries.sortedBy { it.key }.map { it.key to it.value } + node.kids.orEmpty().flatMap { names(it) }

    private fun embedded(fs: PDComplexFileSpecification, key: String): Channel? {
        val ef = fs.embeddedFileUnicode ?: fs.embeddedFile
        val bytes = ef?.toByteArray()?.let { if (it.size > MAX_EMBEDDED) it.copyOf(MAX_EMBEDDED) else it }
        val text = bytes?.let { String(it, Charsets.UTF_8) }?.takeIf { s -> s.count { it.isISOControl() && it !in "\n\r\t" } < s.length / 20 }
        val parts = listOfNotNull(fs.filename, fs.fileDescription, text).filter { it.isNotBlank() }
        return if (parts.isEmpty()) null else Channel(key, parts.joinToString("\n"))
    }

    /** The text nodes of an XMP packet, one per line. The parser refuses DOCTYPEs and external entities. */
    fun xmpText(xml: ByteArray): String {
        val f = DocumentBuilderFactory.newInstance()
        f.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        f.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true)
        f.isNamespaceAware = true
        f.isXIncludeAware = false
        f.isExpandEntityReferences = false
        val dom = f.newDocumentBuilder().parse(ByteArrayInputStream(xml))
        val lines = mutableListOf<String>()

        fun walk(n: Node) {
            if (n.nodeType == Node.TEXT_NODE || n.nodeType == Node.CDATA_SECTION_NODE) n.nodeValue.trim().takeIf { it.isNotEmpty() }?.let { lines += it }
            if (n.nodeType == Node.ELEMENT_NODE) {
                val attrs = n.attributes
                for (i in 0 until attrs.length) {
                    val a = attrs.item(i)
                    if (!a.nodeName.startsWith("xmlns") && a.nodeValue.isNotBlank()) lines += a.nodeValue.trim()
                }
            }
            var c = n.firstChild
            while (c != null) {
                walk(c)
                c = c.nextSibling
            }
        }
        walk(dom)
        return lines.joinToString("\n")
    }
}
