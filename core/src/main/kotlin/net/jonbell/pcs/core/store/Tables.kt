package net.jonbell.pcs.core.store

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import java.sql.ResultSet
import java.time.Instant

/** One row of the paper table: aggregated in SQL, one query for every paper (AGENTS.md Scale). */
public data class PaperRow(
    val pid: Long,
    val title: String,
    val status: String?,
    val decision: String?,
    /** The paper's metareviewers (its ACs, with `PCS_AC_ROLE=meta`), by name. */
    val acs: List<String>,
    val reviewsComplete: Int,
    val reviewsAssigned: Int,
    /** Merit of the complete non-AC reviews, ascending. */
    val merits: List<Int>,
    val comments: Int,
    val lastActivity: Instant?,
    val tags: List<String>,
)

/** One row of the review table. */
public data class ReviewRow(
    val rid: Long,
    val pid: Long,
    val ordinal: String?,
    val reviewer: String,
    val kind: String,
    val status: String,
    val merit: Int?,
    val expertise: Int?,
    val words: Int,
)

/** Read models for the app's tables (spec §4). */
public object Tables {
    private fun tags(s: String): List<String> = Json.parseToJsonElement(s).jsonArray.map { it.jsonPrimitive.content }

    private fun ResultSet.longOrNull(i: Int): Long? = getObject(i)?.toString()?.toLongOrNull()

    public fun papers(store: Store, meritField: String = "OveMer"): List<PaperRow> {
        val sql =
            """
            SELECT p.pid, coalesce(p.title, ''), p.status, p.decision, p.tags,
              (SELECT group_concat(n, '|') FROM (SELECT coalesce(pe.name, r.email) n FROM review r LEFT JOIN person pe ON pe.email = r.email
                 WHERE r.pid = p.pid AND r.rtype = 5 AND r.gone_at IS NULL ORDER BY n)),
              (SELECT count(*) FROM review r WHERE r.pid = p.pid AND r.rtype <> 5 AND r.gone_at IS NULL AND r.status = 'complete'),
              (SELECT count(*) FROM review r WHERE r.pid = p.pid AND r.rtype <> 5 AND r.gone_at IS NULL),
              (SELECT group_concat(m, ' ') FROM (SELECT CAST(json_extract(r.scores, '$.' || ?) AS INTEGER) m FROM review r
                 WHERE r.pid = p.pid AND r.rtype <> 5 AND r.gone_at IS NULL AND r.status = 'complete' AND json_extract(r.scores, '$.' || ?) IS NOT NULL ORDER BY m)),
              (SELECT count(*) FROM comment c WHERE c.pid = p.pid AND c.deleted_seen_at IS NULL AND c.draft = 0),
              (SELECT max(t) FROM (SELECT modified_at t FROM review r WHERE r.pid = p.pid AND r.gone_at IS NULL
                 UNION ALL SELECT modified_at FROM comment c WHERE c.pid = p.pid AND c.deleted_seen_at IS NULL AND c.draft = 0))
            FROM paper p WHERE p.gone_at IS NULL ORDER BY p.pid
            """.trimIndent()
        return store.conn.prepareStatement(sql).use { st ->
            st.setString(1, meritField)
            st.setString(2, meritField)
            st.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        add(
                            PaperRow(
                                pid = rs.getLong(1),
                                title = rs.getString(2),
                                status = rs.getString(3),
                                decision = rs.getString(4),
                                tags = tags(rs.getString(5)),
                                acs = rs.getString(6)?.split('|').orEmpty(),
                                reviewsComplete = rs.getInt(7),
                                reviewsAssigned = rs.getInt(8),
                                merits = rs.getString(9)?.split(' ')?.mapNotNull { it.toIntOrNull() }.orEmpty(),
                                comments = rs.getInt(10),
                                lastActivity = rs.longOrNull(11)?.let(Instant::ofEpochSecond),
                            ),
                        )
                    }
                }
            }
        }
    }

    /** HotCRP's review types (`rtype`), as the chair reads them. */
    public fun kind(rtype: Int): String =
        when (rtype) {
            1 -> "external"
            2 -> "PC"
            3 -> "secondary"
            4 -> "primary"
            5 -> "metareview"
            else -> "type $rtype"
        }

    public fun reviews(store: Store, meritField: String = "OveMer", expertiseField: String = "RevExp"): List<ReviewRow> {
        val sql =
            """
            SELECT r.rid, r.pid, r.ordinal, coalesce(pe.name, r.email, ''), r.rtype, r.status,
              CAST(json_extract(r.scores, '$.' || ?) AS INTEGER), CAST(json_extract(r.scores, '$.' || ?) AS INTEGER), r.word_count
            FROM review r LEFT JOIN person pe ON pe.email = r.email
            WHERE r.gone_at IS NULL ORDER BY r.pid, r.rtype DESC, r.ordinal, r.rid
            """.trimIndent()
        return store.conn.prepareStatement(sql).use { st ->
            st.setString(1, meritField)
            st.setString(2, expertiseField)
            st.executeQuery().use { rs ->
                buildList {
                    while (rs.next()) {
                        add(
                            ReviewRow(
                                rid = rs.getLong(1),
                                pid = rs.getLong(2),
                                ordinal = rs.getString(3),
                                reviewer = rs.getString(4),
                                kind = kind(rs.getInt(5)),
                                status = rs.getString(6),
                                merit = rs.longOrNull(7)?.toInt(),
                                expertise = rs.longOrNull(8)?.toInt(),
                                words = rs.getInt(9),
                            ),
                        )
                    }
                }
            }
        }
    }
}
