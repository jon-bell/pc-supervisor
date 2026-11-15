package pcs.testing

import pcs.core.store.Store

/**
 * A mirror for the accountability module, built row by row. Review text goes in `review_text`, so a test can plant text
 * (including a canary) the suggestion code must never read; `tagSeen` is when a sync first saw a request tag.
 */
public class AccFixture(public val store: Store) {
    private var nextRid = 1L

    private fun sql(q: String) = store.conn.createStatement().use { it.executeUpdate(q) }

    private fun esc(s: String) = s.replace("'", "''")

    public fun person(email: String, name: String = email, tags: List<String> = emptyList()) {
        sql(
            "INSERT INTO person(email,name,roles,tags,first_seen_at,last_seen_at) VALUES('${esc(
                email,
            )}','${esc(name)}','pc','${tags.joinToString(",", "[", "]") {
                "\"$it\""
            }}',0,0)",
        )
    }

    public fun paper(pid: Long, tags: List<String> = emptyList()) {
        sql(
            "INSERT INTO paper(pid,title,authors,pc_conflicts,tags,first_seen_at,last_seen_at) VALUES($pid,'Paper $pid','[]','{}','${tags.joinToString(
                ",",
                "[",
                "]",
            ) {
                "\"$it\""
            }}',0,0)",
        )
    }

    /** Returns the review's rid. [texts] maps a field id to what the reviewer wrote there. */
    public fun review(
        pid: Long,
        who: String,
        ordinal: String? = null,
        status: String = "complete",
        rtype: Int = 2,
        words: Int = 300,
        merit: Int? = 3,
        ratings: List<String> = emptyList(),
        firstCompleteAt: Long? = 0,
        round: String? = null,
        texts: Map<String, String> = emptyMap(),
        versionSeenAt: List<Long> = listOf(0),
        /** HotCRP's time of the current version; the default is the unrevised review, last modified when first seen complete. */
        modifiedAt: Long? = firstCompleteAt,
        /** HotCRP's time of the first complete version, when the review's `/reviewhistory` was read (adds a backfill row). */
        historyCompleteAt: Long? = null,
    ): Long {
        val rid = nextRid++
        val scores = if (merit == null) "{}" else "{\"OveMer\":$merit}"
        val cols = "rid,pid,email,rtype,status,ordinal,vtag,scores,word_count,ratings,first_seen_at,first_complete_seen_at,last_seen_at,round,modified_at"
        val ratingJson = ratings.joinToString(",", "[", "]") { "\"$it\"" }
        val ord = ordinal?.let { "'$it'" } ?: "NULL"
        val rnd = round?.let { "'$it'" } ?: "NULL"
        val who2 = esc(who)
        val vals = "$rid,$pid,'$who2',$rtype,'$status',$ord,'v0','$scores',$words,'$ratingJson',0,${firstCompleteAt ?: "NULL"},0,$rnd,${modifiedAt ?: "NULL"}"
        sql("INSERT INTO review($cols) VALUES($vals)")
        versionSeenAt.forEachIndexed {
            i,
            at,
            ->
            sql(
                "INSERT INTO review_version(rid,vtag,seen_at,source,scores,status) VALUES($rid,'v${if (i == versionSeenAt.lastIndex) "0" else "old$i"}',$at,'snapshot','$scores','$status')",
            )
        }
        if (historyCompleteAt != null) {
            sql("INSERT INTO review_version(rid,vtag,seen_at,source,scores,status) VALUES($rid,'h0',$historyCompleteAt,'history','$scores','complete')")
            sql("INSERT INTO backfill(rid,done_at) VALUES($rid,0)")
        }
        for ((f, t) in texts) sql("INSERT INTO review_text(rid,vtag,field_uid,text) VALUES($rid,'v0','$f','${esc(t)}')")
        return rid
    }

    public fun comment(pid: Long, who: String, visibility: String, cid: Long) {
        sql(
            "INSERT INTO comment(cid,pid,email,visibility,draft,word_count,mentions,tags,modified_at,first_seen_at,last_seen_at) VALUES($cid,$pid,'$who','$visibility',0,5,'[]','[]',0,0,0)",
        )
    }

    public fun tagSeen(pid: Long, name: String, value: String, firstSeenAt: Long) {
        sql("INSERT INTO tag_seen(pid,name,value,first_seen_at,changed_at,last_seen_at) VALUES($pid,'$name','$value',$firstSeenAt,$firstSeenAt,$firstSeenAt)")
    }

    public fun setTags(pid: Long, tags: List<String>) {
        sql("UPDATE paper SET tags='${tags.joinToString(",", "[", "]") { "\"$it\"" }}' WHERE pid=$pid")
    }
}
