package pcs.core.store

import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonObject
import pcs.core.hotcrp.HotcrpClient
import pcs.core.time.Clock

/**
 * The one-time `/reviewhistory` backfill (spec §4): for each review not yet backfilled, read its
 * version history and record each version with the time HotCRP gives it. One request per review,
 * paced at `PCS_HISTORY_RPS` to stay under HotCRP's rate limit.
 */
public class Backfill(private val store: Store, private val clock: Clock) {
    public suspend fun run(client: HotcrpClient, rps: Int, formTextFields: Set<String> = setOf("PapSum", "ComAut", "ComPC")): Int {
        val todo =
            store.conn.query(
                "SELECT r.rid, r.pid FROM review r LEFT JOIN backfill b ON b.rid = r.rid WHERE b.rid IS NULL AND r.gone_at IS NULL AND r.status != 'empty'",
            ) {
                it.getLong(1) to it.getLong(2)
            }
        var added = 0
        for ((rid, pid) in todo) {
            val versions = client.reviewHistory(pid, rid)
            store.tx { c ->
                for (v in versions) {
                    val vtag = v.version ?: continue
                    val scores = JsonObject(v.fields.filterKeys { it !in formTextFields }).toString()
                    added +=
                        c.exec(
                            "INSERT OR IGNORE INTO review_version(rid,vtag,seen_at,source,scores,status) VALUES(?,?,?,?,?,?)",
                            rid,
                            vtag,
                            v.modifiedAt ?: clock.now().epochSecond,
                            "history",
                            scores,
                            v.status,
                        )
                    // a version first seen by a snapshot takes HotCRP's own, earlier time when history gives one
                    if (v.modifiedAt !=
                        null
                    ) {
                        c.exec("UPDATE review_version SET seen_at = ? WHERE rid = ? AND vtag = ? AND seen_at > ?", v.modifiedAt, rid, vtag, v.modifiedAt)
                    }
                }
                c.exec("INSERT INTO backfill(rid, done_at) VALUES(?, ?)", rid, clock.now().epochSecond)
            }
            delay(1000L / rps.coerceAtLeast(1))
        }
        return added
    }
}
