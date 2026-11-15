package pcs.core.store

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import pcs.core.rules.CommentView
import pcs.core.rules.PaperView
import pcs.core.rules.ReviewView
import pcs.core.rules.Version
import java.time.Instant

/** Reads the mirror into the rules' view (spec §5): current papers, reviews with versions, comments. */
public object MirrorView {
    private fun score(scores: String, field: String): Int? =
        (Json.parseToJsonElement(scores).jsonObject[field] as? JsonPrimitive)?.content?.toIntOrNull()

    public fun load(store: Store, meritField: String = "OveMer", expertiseField: String = "RevExp"): List<PaperView> {
        val c = store.conn
        val versions =
            c.query("SELECT rid, seen_at, scores, source FROM review_version ORDER BY rid, seen_at") {
                it.getLong(1) to
                    Version(
                        Instant.ofEpochSecond(it.getLong(2)),
                        score(it.getString(3), meritField),
                        score(it.getString(3), expertiseField),
                        approx = it.getString(4) == "history",
                    )
            }.groupBy({ it.first }, { it.second })
        val reviews =
            c.query(
                "SELECT rid, pid, email, rtype, status, scores, word_count, ratings, modified_at, ordinal, first_complete_seen_at FROM review WHERE gone_at IS NULL",
            ) { r ->
                val rid = r.getLong(1)
                r.getLong(2) to
                    ReviewView(
                        email = r.getString(3),
                        isAc = r.getInt(4) == 5,
                        complete = r.getString(5) == "complete",
                        merit = score(r.getString(6), meritField),
                        expertise = score(r.getString(6), expertiseField),
                        words = r.getInt(7),
                        ratings = Json.parseToJsonElement(r.getString(8)).jsonArray.map { it.jsonPrimitive.content },
                        modifiedAt = r.getObject(9)?.toString()?.toLong()?.let(Instant::ofEpochSecond),
                        versions = versions[rid].orEmpty().sortedBy { it.at },
                        ordinal = r.getString(10),
                        status = r.getString(5),
                        completeAt = (r.getObject(11) ?: r.getObject(9))?.toString()?.toLong()?.let(Instant::ofEpochSecond),
                    )
            }.groupBy({ it.first }, { it.second })
        val acs = reviews.mapValues { (_, rs) -> rs.filter { it.isAc }.mapNotNull { it.email }.toSet() }
        val comments =
            c.query("SELECT pid, email, modified_at, response_round, mentions, word_count, cid FROM comment WHERE deleted_seen_at IS NULL AND draft = 0") { r ->
                val pid = r.getLong(1)
                pid to
                    CommentView(
                        email = r.getString(2),
                        at = Instant.ofEpochSecond(r.getLong(3)),
                        isResponse = r.getString(4) != null,
                        byAc = r.getString(2) in acs[pid].orEmpty(),
                        mentions = Json.parseToJsonElement(r.getString(5)).jsonArray.map { it.jsonPrimitive.content },
                        words = r.getInt(6),
                        cid = r.getLong(7),
                    )
            }.groupBy({ it.first }, { it.second })
        return c.query("SELECT pid, decision, coalesce(title, '') FROM paper WHERE gone_at IS NULL ORDER BY pid") { r ->
            val pid = r.getLong(1)
            PaperView(pid, decided = r.getString(2) != null, reviews = reviews[pid].orEmpty(), comments = comments[pid].orEmpty(), title = r.getString(3))
        }
    }
}
