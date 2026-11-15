package net.jonbell.pcs.core.store

import java.sql.Connection

/**
 * When a sync first saw each accountability tag on a paper (spec §11: HotCRP's tag carries a number, not a time). Only
 * the tags the accountability module reads are kept: requests, reminders and case outcomes.
 */
public object TagSeen {
    private val kept = Regex("""(~~)?pcs-(req|remind|case)-.*""")

    internal fun record(c: Connection, pid: Long, tags: List<String>, now: Long) {
        val mine = tags.filter { kept.matches(it.substringBefore('#')) }.associate { it.substringBefore('#') to it.substringAfter('#', "0") }
        val prev = c.query("SELECT name, value FROM tag_seen WHERE pid = $pid AND gone_at IS NULL") { it.getString(1) to it.getString(2) }.toMap()
        for ((name, value) in mine) {
            if (name !in prev) {
                c.exec(
                    "INSERT INTO tag_seen(pid,name,value,first_seen_at,changed_at,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(pid,name) DO UPDATE SET value=excluded.value, changed_at=excluded.changed_at, last_seen_at=excluded.last_seen_at, gone_at=NULL",
                    pid,
                    name,
                    value,
                    now,
                    now,
                    now,
                )
            } else if (prev[name] != value) {
                c.exec("UPDATE tag_seen SET value=?, changed_at=?, last_seen_at=? WHERE pid=? AND name=?", value, now, now, pid, name)
            } else {
                c.exec("UPDATE tag_seen SET last_seen_at=? WHERE pid=? AND name=?", now, pid, name)
            }
        }
        for (name in prev.keys - mine.keys) c.exec("UPDATE tag_seen SET gone_at=? WHERE pid=? AND name=?", now, pid, name)
    }

    public data class Seen(val pid: Long, val name: String, val value: String, val firstSeenAt: Long, val changedAt: Long)

    public fun all(store: Store): List<Seen> =
        store.conn.query("SELECT pid, name, coalesce(value,'0'), first_seen_at, changed_at FROM tag_seen WHERE gone_at IS NULL") {
            Seen(it.getLong(1), it.getString(2), it.getString(3), it.getLong(4), it.getLong(5))
        }
}
