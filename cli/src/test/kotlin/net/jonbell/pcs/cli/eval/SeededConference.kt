package net.jonbell.pcs.cli.eval

import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import net.jonbell.pcs.agent.eval.Corpus
import net.jonbell.pcs.agent.eval.Generated
import net.jonbell.pcs.agent.llm.LiveSample
import net.jonbell.pcs.agent.llm.LlmCorpus
import java.nio.file.Files
import java.nio.file.Path

/**
 * A synthetic conference for the kit's tests, written as an export directory plus a directory of PDFs: invented names at example.org, papers
 * from the screening corpus (clean ones, mutants and benign controls), the LLM corpus's cases (which the replay fixtures cover), conflicts,
 * reviews with merit scores, and recorded decisions. Mutants of the first four checks are the recorded desk rejects.
 * Everything a report must not contain is in [secrets].
 */
class SeededConference(val root: Path) {
    class Paper(
        val pid: Long,
        val title: String,
        val authorNames: List<String>,
        val authorEmails: List<String>,
        val decision: String?,
        val pdf: ByteArray,
        val info: net.jonbell.pcs.agent.checks.AuthorInfo? = null,
        val abstracts: Map<String, String> = emptyMap(),
    )

    val papers: List<Paper>
    val pcEmails: List<String> = (1..24).map { "pc%02d@example.org".format(it) }
    val pcNames: List<String> = (1..24).map { "Pcmember Surname%02d".format(it) }
    val export: Path = root.resolve("export")
    val pdfDir: Path = root.resolve("pdfs")

    init {
        val items: List<Generated> = Corpus.generate()
        val cases = LlmCorpus.generate().associateBy { it.id }
        val llm = LiveSample.PLAN.map { it.first }.distinct()
        val desk = setOf("format", "refs.doi", "anonymity", "injection.hidden")
        var pid = 7001L
        val out = mutableListOf<Paper>()
        items.forEach { g ->
            val m = g.entry.planted
            val decision =
                when {
                    m != null && m.check in desk -> "Desk reject"
                    pid % 4L == 0L -> "Reject"
                    else -> "Accept"
                }
            out +=
                Paper(
                    pid,
                    "Study ${pid * 31} of Quasar Lattices",
                    listOf("Author${pid}a Quill", "Author${pid}b Vance"),
                    listOf("a$pid@authors.example.org", "b$pid@authors.example.org"),
                    decision,
                    g.bytes,
                )
            pid++
        }
        llm.forEach { id ->
            val c = cases.getValue(id)
            out +=
                Paper(pid, "Case ${pid * 17} on Zephyr Graphs", c.authors.names, listOf("l$pid@authors.example.org"), "Reject", c.pdf, c.authors, c.abstracts)
            pid++
        }
        papers = out
        Files.createDirectories(export)
        Files.createDirectories(pdfDir)
        papers.forEach { Files.write(pdfDir.resolve("${it.pid}.pdf"), it.pdf) }
        write()
        val json = kotlinx.serialization.json.Json
        val str = String.serializer()
        Files.writeString(root.resolve("cfp.txt"), LlmCorpus.CFP)
        Files.writeString(
            root.resolve("abstracts.json"),
            json.encodeToString(
                kotlinx.serialization.builtins.MapSerializer(str, kotlinx.serialization.builtins.MapSerializer(str, str)),
                papers.filter { it.abstracts.isNotEmpty() }.associate { it.pid.toString() to it.abstracts },
            ),
        )
        Files.writeString(
            root.resolve("authors.json"),
            json.encodeToString(
                kotlinx.serialization.builtins.MapSerializer(str, net.jonbell.pcs.agent.checks.AuthorInfo.serializer()),
                papers.filter { it.info != null }.associate { it.pid.toString() to it.info!! },
            ),
        )
    }

    /** The reviews of paper [p]: three complete ones; a quarter of the papers get all-negative scores. */
    private fun merits(p: Paper): List<Int> =
        when ((p.pid % 8L).toInt()) {
            0, 1 -> listOf(1, 1, 1)
            2 -> listOf(1, 2, 2)
            3 -> listOf(2, 2, 3)
            else -> listOf(3, 4, 5)
        }

    private fun write() {
        val pc =
            pcEmails.indices.map { i ->
                JsonObject(
                    mapOf(
                        "email" to JsonPrimitive(pcEmails[i]),
                        "given_name" to JsonPrimitive("Pcmember"),
                        "family_name" to JsonPrimitive("Surname%02d".format(i + 1)),
                        "roles" to JsonPrimitive("pc"),
                        "tags" to JsonPrimitive(if (i % 3 == 0) "jr" else ""),
                    ),
                )
            }
        val ps =
            papers.map { p ->
                val i = (p.pid % 20).toInt()
                JsonObject(
                    mapOf(
                        "pid" to JsonPrimitive(p.pid),
                        "title" to JsonPrimitive(p.title),
                        "status" to JsonPrimitive("submitted"),
                        "decision" to (p.decision?.let { JsonPrimitive(it) } ?: JsonNull),
                        "authors" to JsonArray(p.authorEmails.map { JsonObject(mapOf("email" to JsonPrimitive(it))) }),
                        "pc_conflicts" to
                            JsonObject(
                                (0..(i % 3)).associate { k -> pcEmails[(i + k * 7) % pcEmails.size] to JsonPrimitive("conflict") },
                            ),
                    ),
                )
            }
        var rid = 1L
        val rs =
            papers.filter { it.decision != "Desk reject" }.flatMap { p ->
                merits(p).mapIndexed { k, m ->
                    JsonObject(
                        mapOf(
                            "rid" to JsonPrimitive(rid++),
                            "pid" to JsonPrimitive(p.pid),
                            "rtype" to JsonPrimitive(if (k == 0) 4 else 2),
                            "status" to JsonPrimitive("complete"),
                            "reviewer_email" to JsonPrimitive(pcEmails[(p.pid.toInt() + k) % pcEmails.size]),
                            "OveMer" to JsonPrimitive(m),
                            "ComPC" to JsonPrimitive("SECRET-REVIEW-TEXT-${p.pid}-$k"),
                        ),
                    )
                }
            }

        fun w(name: String, key: String, items: List<JsonObject>) =
            Files.writeString(export.resolve(name), JsonObject(mapOf("ok" to JsonPrimitive(true), key to JsonArray(items))).toString())
        w("pc.json", "pc", pc)
        w("papers.json", "papers", ps)
        w("reviews.json", "reviews", rs)
        // a TPMS scores file: every PC member scores every paper, deterministically, except a few members with no profile
        Files.writeString(
            root.resolve("tpms-scores.csv"),
            "paper,email,score\n" +
                papers.flatMap { p ->
                    pcEmails.drop(4).mapIndexed { j, e ->
                        "${p.pid},$e,${"%.2f".format(
                            java.util.Locale.ROOT,
                            ((p.pid * 7 + j * 13) % 100) / 100.0,
                        )}"
                    }
                }
                    .joinToString("\n") + "\n",
        )
    }

    /** Every identifier, title, name, email and review text in the export: the strings a report must not contain. */
    val secrets: List<String>
        get() =
            papers.flatMap { listOf(it.title) + it.authorNames + it.authorEmails } + pcEmails + pcNames +
                papers.flatMap { p -> (0..2).map { "SECRET-REVIEW-TEXT-${p.pid}-$it" } } + listOf("Pcmember")

    val pids: List<Long> get() = papers.map { it.pid }
}
