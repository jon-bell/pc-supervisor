package net.jonbell.pcs.cli.eval

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import net.jonbell.pcs.core.hotcrp.HotcrpClient
import net.jonbell.pcs.core.hotcrp.PaperRecord
import net.jonbell.pcs.core.hotcrp.PcMember
import net.jonbell.pcs.core.hotcrp.Review
import net.jonbell.pcs.core.imports.Csv
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path

/**
 * What a past venue's chair hands the kit: the PC, the papers with their conflicts and recorded decisions, and the reviews. It lives in memory
 * for one run and is never written anywhere. [fromClient] reads through HotcrpClient's read paths only (it has no other); [fromExport] reads a
 * directory of the JSON HotCRP's own API returns.
 */
class EvalInput(val pc: List<PcMember>, val papers: List<PaperRecord>, val reviews: List<Review>) {
    companion object {
        /** `GET /pc`, `/search`, `/papers`, `/reviews`: nothing else. [gate] is asked first. */
        fun fromClient(url: URI, token: String, gate: NetworkGate): EvalInput {
            gate.open("hotcrp")
            HotcrpClient(url, token, strict = false).use { c ->
                return runBlocking {
                    val pc = c.pc()
                    val pids = c.paperIds()
                    EvalInput(pc, c.papers(pids), c.reviews(pids).map { it.copy(fields = it.fields.filterKeys { k -> k !in TEXT_FIELDS }) })
                }
            }
        }

        /**
         * A directory holding `pc.json`, `papers.json` and `reviews.json`, each as HotCRP's API returns it (`{"ok":true,"pc":[...]}`, `"papers"`,
         * `"reviews"`) or as a bare array. Unknown keys are ignored: the chair's export may be from a different HotCRP version than the harness.
         */
        fun fromExport(dir: Path): EvalInput {
            fun load(name: String, key: String): List<JsonObject> {
                val f = dir.resolve(name)
                require(Files.isRegularFile(f)) { "export directory has no $name" }
                val root: JsonElement = kotlinx.serialization.json.Json.parseToJsonElement(Files.readString(f))
                val list = if (root is JsonArray) root else root.jsonObject[key]?.jsonArray ?: throw IllegalArgumentException("$name has no \"$key\" list")
                return list.map { it.jsonObject }
            }
            return EvalInput(
                load("pc.json", "pc").map(::pcMember),
                load("papers.json", "papers").map(::paper),
                load("reviews.json", "reviews").map(::review),
            )
        }

        private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull

        private fun JsonObject.num(k: String): Long? = (this[k] as? JsonPrimitive)?.longOrNull

        private fun JsonObject.words(k: String): List<String> =
            when (val v = this[k]) {
                is JsonArray -> v.mapNotNull { (it as? JsonPrimitive)?.contentOrNull }
                is JsonPrimitive -> v.contentOrNull?.split(' ', ',')?.filter { it.isNotBlank() }.orEmpty()
                else -> emptyList()
            }

        private fun pcMember(o: JsonObject): PcMember {
            val name = listOfNotNull(o.str("given_name"), o.str("family_name")).joinToString(" ").ifBlank { o.str("name").orEmpty() }
            return PcMember(requireNotNull(o.str("email")) { "a pc entry has no email" }, name.ifBlank { null }, o.words("roles"), o.words("tags"))
        }

        private fun paper(o: JsonObject): PaperRecord =
            PaperRecord(
                pid = requireNotNull(o.num("pid")) { "a paper has no pid" },
                title = o.str("title"),
                status = o.str("status"),
                decision = o.str("decision"),
                authors = (o["authors"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.str("email") },
                pcConflicts = (o["pc_conflicts"] as? JsonObject).orEmpty().mapValues { (_, v) -> (v as? JsonPrimitive)?.contentOrNull ?: v.toString() },
                modifiedAt = o.num("modified_at"),
            )

        /** Review-form fields that hold words, not a score. They are dropped on the way in. */
        val TEXT_FIELDS = setOf("PapSum", "ComAut", "ComPC", "Tri")

        private fun review(o: JsonObject): Review =
            Review(
                rid = requireNotNull(o.num("rid")) { "a review has no rid" },
                pid = requireNotNull(o.num("pid")) { "a review has no pid" },
                rtype = o.num("rtype")?.toInt() ?: 0,
                status = o.str("status").orEmpty(),
                ordinal = o.str("ordinal"),
                reviewerEmail = o.str("reviewer_email"),
                version = null,
                modifiedAt = o.num("modified_at"),
                ratings = emptyList(),
                // only the fields a score is read from; review text never enters the kit's memory
                fields = o.filterKeys { it !in TEXT_FIELDS && it.length in 3..16 && it.first().isUpperCase() && it.all { c -> c.isLetterOrDigit() } },
                round = o.str("round"),
            )
    }
}

/** TPMS's scores for a venue: `paper,email,score` rows, and optionally `email` rows for who registered. Read leniently; the kit counts what it can use. */
class TpmsData(val scores: Map<Pair<Long, String>, Double>, val registered: Set<String>, val malformedRows: Int) {
    companion object {
        val NONE = TpmsData(emptyMap(), emptySet(), 0)

        fun read(scores: Path?, registrations: Path?): TpmsData {
            var bad = 0
            val sc = HashMap<Pair<Long, String>, Double>()
            if (scores != null) {
                val csv = Csv.parse(Files.readString(scores)).getOrThrow()
                val h = csv.header.map { it.trim().lowercase() }
                val (ip, ie, iv) = listOf("paper", "email", "score").map { h.indexOf(it) }
                require(ip >= 0 && ie >= 0 && iv >= 0) { "the TPMS scores file needs the columns paper, email, score" }
                for ((_, r) in csv.records) {
                    val pid = r.getOrNull(ip)?.trim()?.toLongOrNull()
                    val v = r.getOrNull(iv)?.trim()?.toDoubleOrNull()
                    val e = r.getOrNull(ie)?.trim()?.lowercase()
                    if (pid == null || v == null || !v.isFinite() || v < 0.0 || v > 1.0 || e.isNullOrEmpty()) bad++ else sc[pid to e] = v
                }
            }
            val reg = HashSet<String>()
            if (registrations != null) {
                val csv = Csv.parse(Files.readString(registrations)).getOrThrow()
                val ie = csv.header.map { it.trim().lowercase() }.indexOf("email")
                require(ie >= 0) { "the TPMS registrations file needs the column email" }
                for ((_, r) in csv.records) r.getOrNull(ie)?.trim()?.lowercase()?.takeIf { it.isNotEmpty() }?.let { reg += it } ?: bad++
            }
            return TpmsData(sc, reg, bad)
        }
    }
}
