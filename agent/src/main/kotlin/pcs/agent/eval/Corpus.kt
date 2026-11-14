package pcs.agent.eval

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import pcs.agent.checks.AuthorInfo
import pcs.agent.checks.ResolvedWork
import pcs.agent.extract.Ocr
import java.awt.image.BufferedImage
import java.io.File
import kotlin.random.Random

@Serializable
data class Entry(
    val id: String,
    val kind: String,
    val seed: Long,
    val planted: Planted?,
    val control: String?,
    val payload: String?,
    /** What a reader sees, per page: the oracle that stands in for OCR in unit tests. */
    val visible: List<String>,
    /** The works that truly exist: what the mocked resolver knows. */
    val truth: List<ResolvedWork>,
    val authors: AuthorInfo,
    val pages: Int,
)

class Generated(val entry: Entry, val bytes: ByteArray)

/** Stands in for OCR in unit tests by returning what the generator knows a reader sees. */
class ManifestOcr(private val visible: List<String>) : Ocr {
    override fun recognize(page: Int, image: () -> BufferedImage) = visible.getOrElse(page - 1) { "" }
}

/**
 * The corpus: clean papers, one mutant per declared operator (injection operators once per payload),
 * and the benign controls. Deterministic from [seed]; PDFs are written only to `build/`.
 */
object Corpus {
    private val json = Json { prettyPrint = true }

    fun generate(seed: Long = 20260101L, cleanCount: Int = 6): List<Generated> {
        val out = mutableListOf<Generated>()

        fun truthOf(s: PaperSpec) = s.refs.map { ResolvedWork(it.doi, it.title, it.year) }

        fun authorsOf(s: PaperSpec) =
            AuthorInfo(
                s.authors.map {
                    it.name
                },
                s.authors.map { it.affiliation },
                s.authors.map { it.domain },
                s.authors.map { it.handle },
            )

        fun add(id: String, kind: String, s: PaperSpec, m: Mutation?, control: String? = null, payload: String? = null) {
            val spec = m?.spec ?: s
            val built = PaperRenderer.render(spec, m?.hooks ?: Hooks())
            out += Generated(Entry(id, kind, s.seed, m?.planted, control, payload, built.visible, truthOf(s), authorsOf(s), built.pages), built.bytes)
        }
        for (i in 1..cleanCount) add("clean-%02d".format(i), "clean", CleanPapers.make(seed + i), null)

        val payloads = Oracle.payloads()
        var n = 0
        for (check in Oracle.checks) {
            for (decl in Oracle.operators(check).filterNot { it.control }) {
                val impl = requireNotNull(Operators.impl["$check/${decl.operator}"]) { "operator $check/${decl.operator} is declared but not implemented" }
                val variants = if (check.startsWith("injection.")) payloads else listOf(null)
                for (p in variants) {
                    n++
                    val s = CleanPapers.make(seed + 1000 + n)
                    val m = impl(decl, s, p, Random(seed + n))
                    add("mutant/$check/${decl.operator}" + (p?.let { "/${it.id}" } ?: ""), "mutant", s, m, payload = p?.text)
                }
            }
        }
        for ((name, make) in Operators.controls) {
            n++
            val s = CleanPapers.make(seed + 2000 + n, aboutLlms = name == "paper-about-prompt-injection")
            add("benign/$name", "benign", s, make(s, Random(seed + n)), control = name)
        }
        return out
    }

    /** Writes the PDFs and `manifest.json` under [dir]. */
    fun write(dir: File, items: List<Generated> = generate()) {
        dir.deleteRecursively()
        dir.mkdirs()
        items.forEach { g -> File(dir, g.entry.id.replace('/', '_') + ".pdf").writeBytes(g.bytes) }
        File(dir, "manifest.json").writeText(json.encodeToString(items.map { it.entry }))
    }
}

fun main(args: Array<String>) {
    val dir = File(args.firstOrNull() ?: "agent/build/synthetic")
    val items = Corpus.generate()
    Corpus.write(dir, items)
    println("wrote ${items.size} synthetic papers to $dir")
}
