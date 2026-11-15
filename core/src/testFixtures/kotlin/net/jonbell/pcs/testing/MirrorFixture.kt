package net.jonbell.pcs.testing

import net.jonbell.pcs.core.store.Store
import java.nio.file.Files
import java.nio.file.Path

/**
 * A mirror built by hand: what a sync and the history backfill would leave in the store, row by row, so a test
 * decides every timestamp. Each review is given with its versions (seen_at, merit, status); the last is its current state.
 */
public class MirrorFixture(public val store: Store) {
    private var nextRid = 1L
    private var nextCid = 1L

    private fun sql(q: String) = store.conn.createStatement().use { it.executeUpdate(q) }

    public fun paper(pid: Long, decision: String? = null, tags: List<String> = emptyList(), title: String = "Paper $pid") {
        val tagJson = tags.joinToString(",", "[", "]") { "\"$it\"" }
        sql(
            "INSERT INTO paper(pid,title,decision,authors,pc_conflicts,tags,first_seen_at,last_seen_at) VALUES($pid,'$title',${decision?.let {
                "'$it'"
            } ?: "NULL"},'[]','{}','$tagJson',0,0)",
        )
    }

    public fun review(pid: Long, who: String, vararg versions: Triple<Long, Int, String>) {
        val rid = nextRid++
        val last = versions.last()
        sql(
            "INSERT INTO review(rid,pid,email,rtype,status,scores,word_count,ratings,first_seen_at,last_seen_at) VALUES($rid,$pid,'$who@example.org',2,'${last.third}','{\"OveMer\":${last.second}}',100,'[]',0,0)",
        )
        versions.forEachIndexed { i, v ->
            sql(
                "INSERT INTO review_version(rid,vtag,seen_at,source,scores,status) VALUES($rid,'v$i',${v.first},'history','{\"OveMer\":${v.second}}','${v.third}')",
            )
        }
    }

    public fun comment(pid: Long, who: String, at: Long) {
        sql(
            "INSERT INTO comment(cid,pid,email,draft,word_count,mentions,tags,modified_at,first_seen_at,last_seen_at) VALUES(${nextCid++},$pid,'$who@example.org',0,5,'[]','[]',$at,0,0)",
        )
    }

    public companion object {
        /** A fresh encrypted store file at [path] (which must not exist yet), filled by [build]. */
        public fun build(path: Path, key: String, build: MirrorFixture.() -> Unit): Store {
            Files.deleteIfExists(path)
            return Store.open(path, key).also { MirrorFixture(it).build() }
        }

        public fun temp(build: MirrorFixture.() -> Unit): Store = build(Files.createTempFile("pcs-fixture", ".db"), "test-only-key", build)
    }
}
