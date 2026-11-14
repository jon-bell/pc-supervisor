package pcs.core.store

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import pcs.core.hotcrp.Comment
import pcs.core.hotcrp.HotcrpClient
import pcs.core.hotcrp.PaperRecord
import pcs.core.hotcrp.PcMember
import pcs.core.time.Clock
import java.sql.Connection

/** What one sync changed (spec §4; concepts Mirror). Zero everywhere means nothing changed. */
public data class SyncCounts(
    val newRows: Map<String, Int>,
    val changed: Map<String, Int>,
    val gone: Map<String, Int>,
) {
    public val isNoop: Boolean get() = newRows.values.all { it == 0 } && changed.values.all { it == 0 } && gone.values.all { it == 0 }
}

/**
 * The full sync: fetch everything, diff against the store, record what's new, changed, and gone.
 * It is idempotent: a second sync with no HotCRP changes writes no rows (PLAN M3).
 */
public class Sync(private val store: Store, private val clock: Clock) {
    private val mentionRe = Regex("""@([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})""")

    public suspend fun run(client: HotcrpClient, formTextFields: Set<String> = setOf("PapSum", "ComAut", "ComPC")): SyncCounts {
        val started = clock.now().epochSecond
        val pc = client.pc()
        val assignments = client.assignments()
        val pids = client.paperIds()
        val papers = client.papers(pids)
        val reviews = client.reviews(pids)
        val comments = client.comments(pids)
        val pcTags = client.pcTags
        // instance settings the conventions rely on (spec §11); a token that can't read them leaves the fact unknown
        val instance = runCatching { client.settings() }.getOrNull()?.takeIf { it.isNotEmpty() }
        val tagHidden = instance?.let { it["tag_hidden"]?.toString() ?: "" }
        val now = clock.now().epochSecond
        val newRows = mutableMapOf<String, Int>().withDefault { 0 }
        val changed = mutableMapOf<String, Int>().withDefault { 0 }
        val gone = mutableMapOf<String, Int>().withDefault { 0 }

        fun bump(m: MutableMap<String, Int>, k: String) {
            m[k] = m.getValue(k) + 1
        }

        store.tx { c ->
            persons(c, pc, now, ::bump, newRows, changed, gone)
            fact(c, "pc_tags", pcTags.joinToString(" "), now)
            if (tagHidden != null) fact(c, "tag_hidden", tagHidden, now)
            papers(c, papers, now, ::bump, newRows, changed, gone)

            // assignments
            val seenA = assignments.map { Triple(it.pid, it.email, it.action) }.toSet()
            val haveA =
                c.query("SELECT pid, email, role FROM assignment WHERE gone_at IS NULL") {
                    Triple(it.getLong(1), it.getString(2), it.getString(3))
                }.toSet()
            for (a in seenA - haveA) {
                c.exec(
                    "INSERT INTO assignment(pid,email,role,first_seen_at,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(pid,email,role) DO UPDATE SET gone_at=NULL, last_seen_at=excluded.last_seen_at",
                    a.first,
                    a.second,
                    a.third,
                    now,
                    now,
                )
                bump(newRows, "assignment")
            }
            for (a in haveA - seenA) {
                c.exec("UPDATE assignment SET gone_at=? WHERE pid=? AND email=? AND role=?", now, a.first, a.second, a.third)
                bump(gone, "assignment")
            }

            // reviews
            val known =
                c.query("SELECT rid, vtag, status, ratings, first_complete_seen_at FROM review") { r ->
                    r.getLong(1) to listOf(r.getString(2), r.getString(3), r.getString(4), r.getObject(5)?.toString())
                }.toMap()
            for (rv in reviews) {
                val scores = JsonObject(rv.fields.filterKeys { it !in formTextFields }).toString()
                // an empty review's text fields are JSON null: absent, not the string "null"
                val texts =
                    rv.fields.filterKeys { it in formTextFields }
                        .mapValues { (_, v) -> (v as? JsonPrimitive)?.takeIf { it.isString }?.content.orEmpty() }
                val words = texts.values.sumOf { t -> t.split(Regex("\\s+")).count { it.isNotBlank() } }
                val ratings = JsonArray(rv.ratings.map { JsonPrimitive(it) }).toString()
                val prev = known[rv.rid]
                val complete = rv.status == "complete"
                if (prev == null) {
                    c.exec(
                        "INSERT INTO review(rid,pid,email,rtype,status,ordinal,vtag,modified_at,scores,word_count,ratings,first_seen_at,first_complete_seen_at,last_seen_at,round) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                        rv.rid,
                        rv.pid,
                        rv.reviewerEmail,
                        rv.rtype,
                        rv.status,
                        rv.ordinal,
                        rv.version,
                        rv.modifiedAt,
                        scores,
                        words,
                        ratings,
                        now,
                        if (complete) now else null,
                        now,
                        rv.round,
                    )
                    bump(newRows, "review")
                } else {
                    val (vtag, status, oldRatings, firstComplete) = prev
                    if (vtag != rv.version || status != rv.status) bump(changed, "review")
                    if (oldRatings != ratings) {
                        c.exec("INSERT INTO rating_change(rid,seen_at,before,after) VALUES(?,?,?,?)", rv.rid, now, oldRatings, ratings)
                        bump(newRows, "rating_change")
                    }
                    c.exec(
                        "UPDATE review SET pid=?,email=?,rtype=?,status=?,ordinal=?,vtag=?,modified_at=?,scores=?,word_count=?,ratings=?,first_complete_seen_at=?,last_seen_at=?,round=?,gone_at=NULL WHERE rid=?",
                        rv.pid,
                        rv.reviewerEmail,
                        rv.rtype,
                        rv.status,
                        rv.ordinal,
                        rv.version,
                        rv.modifiedAt,
                        scores,
                        words,
                        ratings,
                        firstComplete?.toLong() ?: if (complete) now else null,
                        now,
                        rv.round,
                        rv.rid,
                    )
                }
                if (rv.version != null && (prev == null || prev[0] != rv.version)) {
                    if (c.exec(
                            "INSERT OR IGNORE INTO review_version(rid,vtag,seen_at,source,scores,status) VALUES(?,?,?,?,?,?)",
                            rv.rid,
                            rv.version,
                            now,
                            "snapshot",
                            scores,
                            rv.status,
                        ) >
                        0
                    ) {
                        bump(newRows, "review_version")
                    }
                    for ((uid, t) in texts) {
                        if (t.isEmpty()) continue
                        if (c.exec("INSERT OR IGNORE INTO review_text(rid,vtag,field_uid,text) VALUES(?,?,?,?)", rv.rid, rv.version, uid, t) > 0) {
                            c.exec("INSERT INTO fts(kind,ref,text) VALUES('review',?,?)", "${rv.rid}/${rv.version}/$uid", t)
                            bump(newRows, "review_text")
                        }
                    }
                }
            }
            val seenR = reviews.map { it.rid }.toSet()
            for (rid in known.keys - seenR) {
                if (c.exec("UPDATE review SET gone_at=? WHERE rid=? AND gone_at IS NULL", now, rid) > 0) bump(gone, "review")
            }

            commentsSync(c, comments, pc, now, ::bump, newRows, changed, gone)
        }
        // Writeback (H2): every applied artifact must now show its effect, or be flagged
        pcs.core.writeback.Ledger.observe(store, now)
        val counts = SyncCounts(newRows.toMap(), changed.toMap(), gone.toMap())
        store.conn.prepareStatement("INSERT INTO sync_run(started_at,finished_at,now_used,counts,errors) VALUES(?,?,?,?,?)").use { st ->
            st.setLong(1, started)
            st.setLong(2, clock.now().epochSecond)
            st.setLong(3, now)
            st.setString(4, counts.toString())
            st.setString(5, client.drift.joinToString("\n"))
            st.executeUpdate()
        }
        return counts
    }

    private fun fact(c: Connection, k: String, v: String, now: Long) {
        c.exec("INSERT INTO instance_fact(k,v,read_at) VALUES(?,?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, read_at=excluded.read_at", k, v, now)
    }

    private fun persons(
        c: Connection,
        pc: List<PcMember>,
        now: Long,
        bump: (MutableMap<String, Int>, String) -> Unit,
        n: MutableMap<String, Int>,
        ch: MutableMap<String, Int>,
        g: MutableMap<String, Int>,
    ) {
        val have =
            c.query("SELECT email, name, roles, tags FROM person WHERE gone_at IS NULL") {
                it.getString(1) to
                    listOf(it.getString(2), it.getString(3), it.getString(4))
            }.toMap()
        for (p in pc) {
            val roles = JsonArray(p.roles.map { JsonPrimitive(it) }).toString()
            val tags = JsonArray(p.tags.map { JsonPrimitive(it) }).toString()
            val prev = have[p.email]
            if (prev == null) {
                c.exec(
                    "INSERT INTO person(email,name,roles,tags,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name, roles=excluded.roles, tags=excluded.tags, last_seen_at=excluded.last_seen_at, gone_at=NULL",
                    p.email,
                    p.name,
                    roles,
                    tags,
                    now,
                    now,
                )
                bump(n, "person")
            } else {
                if (prev != listOf(p.name, roles, tags)) bump(ch, "person")
                c.exec("UPDATE person SET name=?, roles=?, tags=?, last_seen_at=? WHERE email=?", p.name, roles, tags, now, p.email)
            }
        }
        for (e in have.keys - pc.map { it.email }.toSet()) {
            c.exec("UPDATE person SET gone_at=? WHERE email=?", now, e)
            bump(g, "person")
        }
    }

    private fun papers(
        c: Connection,
        papers: List<PaperRecord>,
        now: Long,
        bump: (MutableMap<String, Int>, String) -> Unit,
        n: MutableMap<String, Int>,
        ch: MutableMap<String, Int>,
        g: MutableMap<String, Int>,
    ) {
        val have =
            c.query("SELECT pid, title, status, decision, authors, pc_conflicts, tags FROM paper WHERE gone_at IS NULL") {
                it.getLong(1) to
                    (2..7).map { i -> it.getString(i) }
            }.toMap()
        for (p in papers) {
            val authors = JsonArray(p.authors.map { JsonPrimitive(it) }).toString()
            val conf = JsonObject(p.pcConflicts.mapValues { JsonPrimitive(it.value) }).toString()
            val tags = JsonArray(p.tags.sorted().map { JsonPrimitive(it) }).toString()
            val row = listOf(p.title, p.status, p.decision, authors, conf, tags)
            val prev = have[p.pid]
            if (prev == null) {
                c.exec(
                    "INSERT INTO paper(pid,title,status,decision,authors,pc_conflicts,tags,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(pid) DO UPDATE SET gone_at=NULL",
                    p.pid,
                    p.title,
                    p.status,
                    p.decision,
                    authors,
                    conf,
                    tags,
                    now,
                    now,
                )
                bump(n, "paper")
            } else {
                if (prev != row) bump(ch, "paper")
                c.exec(
                    "UPDATE paper SET title=?, status=?, decision=?, authors=?, pc_conflicts=?, tags=?, last_seen_at=? WHERE pid=?",
                    p.title,
                    p.status,
                    p.decision,
                    authors,
                    conf,
                    tags,
                    now,
                    p.pid,
                )
            }
        }
        for (pid in have.keys - papers.map { it.pid }.toSet()) {
            c.exec("UPDATE paper SET gone_at=? WHERE pid=?", now, pid)
            bump(g, "paper")
        }
    }

    private fun commentsSync(
        c: Connection,
        comments: List<Comment>,
        pc: List<PcMember>,
        now: Long,
        bump: (MutableMap<String, Int>, String) -> Unit,
        n: MutableMap<String, Int>,
        ch: MutableMap<String, Int>,
        g: MutableMap<String, Int>,
    ) {
        val roster = pc.map { it.email }.toSet()
        val have =
            c.query("SELECT cid, modified_at FROM comment WHERE deleted_seen_at IS NULL") {
                it.getLong(1) to it.getObject(2)?.toString()?.toLong()
            }.toMap()
        for (cm in comments) {
            val text = cm.text.orEmpty()
            val mentions = mentionRe.findAll(text).map { it.groupValues[1].lowercase() }.filter { it in roster }.distinct().toList()
            val mj = JsonArray(mentions.map { JsonPrimitive(it) }).toString()
            val tags = JsonArray(cm.tags.map { JsonPrimitive(it) }).toString()
            val words = text.split(Regex("\\s+")).count { it.isNotBlank() }
            if (cm.cid !in have) {
                c.exec(
                    "INSERT INTO comment(cid,pid,email,topic,visibility,response_round,draft,word_count,mentions,tags,modified_at,first_seen_at,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(cid) DO UPDATE SET deleted_seen_at=NULL",
                    cm.cid,
                    cm.pid,
                    cm.authorEmail,
                    cm.topic,
                    cm.visibility,
                    cm.responseRound,
                    if (cm.draft) 1 else 0,
                    words,
                    mj,
                    tags,
                    cm.modifiedAt,
                    now,
                    now,
                )
                bump(n, "comment")
            } else {
                if (have[cm.cid] != cm.modifiedAt) bump(ch, "comment")
                c.exec(
                    "UPDATE comment SET pid=?,email=?,topic=?,visibility=?,response_round=?,draft=?,word_count=?,mentions=?,tags=?,modified_at=?,last_seen_at=? WHERE cid=?",
                    cm.pid,
                    cm.authorEmail,
                    cm.topic,
                    cm.visibility,
                    cm.responseRound,
                    if (cm.draft) 1 else 0,
                    words,
                    mj,
                    tags,
                    cm.modifiedAt,
                    now,
                    cm.cid,
                )
            }
            val mod = cm.modifiedAt ?: 0L
            if (c.exec("INSERT OR IGNORE INTO comment_text(cid,modified_at,text) VALUES(?,?,?)", cm.cid, mod, text) > 0) {
                c.exec("INSERT INTO fts(kind,ref,text) VALUES('comment',?,?)", "${cm.cid}/$mod", text)
                bump(n, "comment_text")
            }
        }
        for (cid in have.keys - comments.map { it.cid }.toSet()) {
            c.exec("UPDATE comment SET deleted_seen_at=? WHERE cid=?", now, cid)
            bump(g, "comment")
        }
    }
}

internal fun Connection.exec(sql: String, vararg args: Any?): Int =
    prepareStatement(sql).use { st ->
        args.forEachIndexed { i, a ->
            when (a) {
                null -> st.setObject(i + 1, null)
                is Int -> st.setInt(i + 1, a)
                is Long -> st.setLong(i + 1, a)
                is String -> st.setString(i + 1, a)
                else -> st.setString(i + 1, a.toString())
            }
        }
        st.executeUpdate()
    }

internal fun <T> Connection.query(sql: String, f: (java.sql.ResultSet) -> T): List<T> =
    createStatement().use { st ->
        st.executeQuery(sql).use { rs -> buildList { while (rs.next()) add(f(rs)) } }
    }
