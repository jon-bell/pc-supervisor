package net.jonbell.pcs.core.report

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.core.accountability.Tiers
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.nominations.NominationData
import net.jonbell.pcs.core.session.Session
import net.jonbell.pcs.core.store.query
import java.nio.file.Files
import java.nio.file.Path

/** One exported table: a header and rows of plain values. */
public data class ExportTable(val name: String, val header: List<String>, val rows: List<List<String>>) {
    public fun csv(): String =
        buildString {
            append(header.joinToString(",")).append('\n')
            for (r in rows) append(r.joinToString(",") { cell(it) }).append('\n')
        }

    private fun cell(v: String) = if (v.any { it == ',' || it == '"' || it == '\n' }) "\"" + v.replace("\"", "\"\"") + "\"" else v
}

/**
 * Rows for research or federated evaluation (spec §10.4 G). Every person is a keyed pseudonym and every paper is one too; no email,
 * name, title or text is read into a row. Fields are numbers, timestamps (epoch seconds), and enumerated labels (tier group, status,
 * rating flag names, dispositions). Rows are in a fixed order, so an export is a function of the mirror and the key.
 */
public object PseudonymousExport {
    private fun ts(r: java.sql.ResultSet, i: Int): String = r.getObject(i)?.toString().orEmpty()

    public fun build(s: Session, ps: Pseudonyms): List<ExportTable> {
        val c = s.store.conn
        val input = NominationData(s.store, Imports(s.store, s.clock)).input()
        val tags =
            c.query("SELECT lower(email), tags FROM person WHERE gone_at IS NULL") {
                it.getString(1) to Json.parseToJsonElement(it.getString(2)).jsonArray.map { t -> t.jsonPrimitive.content }
            }.toMap()
        val tiers = Tiers.build(input.sheet, tags, s.settings.tierTags)
        val merit = s.settings.fieldMerit
        val expertise = s.settings.fieldExpertise

        fun score(json: String, field: String) =
            (
                Json.parseToJsonElement(
                    json,
                ).jsonObject[field] as? kotlinx.serialization.json.JsonPrimitive
            )?.content.orEmpty()

        val reviews =
            c.query(
                "SELECT rid, pid, email, rtype, status, word_count, ratings, scores, modified_at, first_complete_seen_at FROM review " +
                    "WHERE gone_at IS NULL AND email IS NOT NULL ORDER BY rid",
            ) { r ->
                listOf(
                    ps.paper(r.getLong(2)),
                    ps.person(r.getString(3)),
                    tiers.of(r.getString(3)).group,
                    if (r.getInt(4) == 5) "meta" else "review",
                    r.getString(5),
                    r.getInt(6).toString(),
                    Json.parseToJsonElement(r.getString(7)).jsonArray.joinToString(" ") { it.jsonPrimitive.content },
                    score(r.getString(8), merit),
                    score(r.getString(8), expertise),
                    ts(r, 9),
                    ts(r, 10),
                )
            }
        val comments =
            c.query(
                "SELECT pid, email, visibility, response_round, word_count, modified_at FROM comment " +
                    "WHERE deleted_seen_at IS NULL AND draft = 0 AND email IS NOT NULL " +
                    "ORDER BY cid",
            ) { r ->
                listOf(
                    ps.paper(r.getLong(1)),
                    ps.person(r.getString(2)),
                    tiers.of(r.getString(2)).group,
                    r.getString(3).orEmpty(),
                    (!r.getString(4).isNullOrEmpty()).toString(),
                    r.getInt(5).toString(),
                    ts(r, 6),
                )
            }
        val nominations =
            input.sheet.sortedBy { it.email.lowercase() }.map { cand ->
                listOf(
                    ps.person(cand.email),
                    cand.origin,
                    cand.nominatedBy.sorted().joinToString(" ") { ps.paper(it) },
                    cand.decision.key,
                    cand.acEmail.takeIf { it.isNotBlank() }?.let(ps::person).orEmpty(),
                    cand.tier?.name?.lowercase().orEmpty(),
                    cand.consent?.toString().orEmpty(),
                    cand.onPcAt.isNotBlank().toString(),
                )
            }
        val requests =
            runCatching { s.accountability() }.getOrNull()?.requests.orEmpty().sortedWith(compareBy({ it.pid }, { it.ordinal }, { it.n })).map { q ->
                listOf(
                    ps.paper(q.pid),
                    ps.person(q.reviewer),
                    q.group,
                    q.sentAt.epochSecond.toString(),
                    q.due.epochSecond.toString(),
                    q.remindedAt?.epochSecond?.toString().orEmpty(),
                    q.revised.toString(),
                    q.disposition?.name?.lowercase().orEmpty(),
                    q.status.name.lowercase(),
                )
            }
        return listOf(
            ExportTable(
                "reviews",
                listOf("paper", "reviewer", "group", "kind", "status", "words", "rating_flags", "merit", "expertise", "modified_at", "first_complete_at"),
                reviews,
            ),
            ExportTable("comments", listOf("paper", "author", "group", "visibility", "is_response", "words", "modified_at"), comments),
            ExportTable("nominations", listOf("candidate", "origin", "nominating_papers", "decision", "decided_by", "tier", "consent", "on_pc"), nominations),
            ExportTable("requests", listOf("paper", "reviewer", "group", "sent_at", "due_at", "reminded_at", "revised", "disposition", "status"), requests),
        )
    }

    /** Writes each table as `<name>.csv` into [dir] (created if needed). */
    public fun write(tables: List<ExportTable>, dir: Path): List<Path> {
        Files.createDirectories(dir)
        return tables.map { t -> dir.resolve("${t.name}.csv").also { Files.writeString(it, t.csv()) } }
    }
}
