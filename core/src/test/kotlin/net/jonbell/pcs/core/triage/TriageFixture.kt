package net.jonbell.pcs.core.triage

import net.jonbell.pcs.core.bundle.BundleAnchor
import net.jonbell.pcs.core.bundle.BundleFinding
import net.jonbell.pcs.core.bundle.BundleManifest
import net.jonbell.pcs.core.bundle.BundlePaper
import net.jonbell.pcs.core.bundle.BundlePayload
import net.jonbell.pcs.core.readings.Q1
import net.jonbell.pcs.core.readings.Q10
import net.jonbell.pcs.core.readings.Q2
import net.jonbell.pcs.core.readings.Q3
import net.jonbell.pcs.core.readings.Q6
import net.jonbell.pcs.core.readings.Readings
import net.jonbell.pcs.core.rules.Stage
import net.jonbell.pcs.core.rules.Tier
import net.jonbell.pcs.core.store.Store
import java.nio.file.Files
import java.time.Instant

/** A mirror built by hand for the triage plan: what a sync would leave for papers, people, screen-round reviews, tags and comments. */
class TriageFixture(val store: Store) {
    private var rid = 1L
    private var cid = 1L

    private fun sql(q: String) = store.conn.createStatement().use { it.executeUpdate(q) }

    private fun q(s: String) = s.replace("'", "''")

    fun person(email: String, roles: String = """["pc"]""", tags: String = "[]") =
        sql("INSERT INTO person(email,name,roles,tags,first_seen_at,last_seen_at) VALUES('${q(email)}','${q(email)}','$roles','$tags',0,0)")

    fun paper(
        pid: Long,
        decision: String? = null,
        tags: List<String> = emptyList(),
        conflicts: List<String> = emptyList(),
        authors: List<String> = listOf("author$pid@example.org"),
        modifiedAt: Long? = null,
    ) {
        val c = conflicts.joinToString(",", "{", "}") { "\"$it\":\"conflict\"" }
        val a = authors.joinToString(",", "[", "]") { "\"$it\"" }
        val t = tags.joinToString(",", "[", "]") { "\"$it\"" }
        sql(
            "INSERT INTO paper(pid,title,decision,authors,pc_conflicts,tags,first_seen_at,last_seen_at,modified_at) VALUES($pid,'Paper $pid'," +
                "${decision?.let { "'$it'" } ?: "NULL"},'$a','$c','$t',0,0,${modifiedAt ?: "NULL"})",
        )
    }

    /** The AC's metareview: in the screen round with a Triage value (null: assigned, not written), or in the normal round. */
    fun meta(pid: Long, ac: String, triage: Int? = null, status: String = "complete", round: String? = "screen", note: String? = null) {
        val id = rid++
        val scores = if (triage != null) """{"Tri":$triage}""" else "{}"
        sql(
            "INSERT INTO review(rid,pid,email,rtype,status,round,vtag,scores,word_count,ratings,first_seen_at,last_seen_at) VALUES($id,$pid,'${q(
                ac,
            )}',5,'$status'," +
                "${round?.let { "'$it'" } ?: "NULL"},'v0','$scores',0,'[]',0,0)",
        )
        if (note != null) sql("INSERT INTO review_text(rid,vtag,field_uid,text) VALUES($id,'v0','ComPC','${q(note)}')")
    }

    /** A second opinion: a screen-round review, complete (agrees) or not (asked, not answered). */
    fun opinion(pid: Long, who: String, complete: Boolean = true, askedAt: Long = 0) {
        val id = rid++
        sql(
            "INSERT INTO review(rid,pid,email,rtype,status,round,vtag,scores,word_count,ratings,first_seen_at,last_seen_at) VALUES($id,$pid,'${q(who)}',2," +
                "'${if (complete) "complete" else "empty"}','screen','v0','{}',0,'[]',$askedAt,$askedAt)",
        )
    }

    /** A normal-round review (what a reviewer of the paper writes). */
    fun review(pid: Long, who: String, status: String = "complete") {
        val id = rid++
        sql(
            "INSERT INTO review(rid,pid,email,rtype,status,round,vtag,scores,word_count,ratings,first_seen_at,last_seen_at) VALUES($id,$pid,'${q(who)}',2," +
                "'$status',NULL,'v0','{\"OveMer\":2}',100,'[]',0,0)",
        )
    }

    fun comment(pid: Long, who: String, text: String, visibility: String = "rev") {
        val id = cid++
        sql(
            "INSERT INTO comment(cid,pid,email,visibility,draft,word_count,mentions,tags,modified_at,first_seen_at,last_seen_at) VALUES($id,$pid,'${q(
                who,
            )}','$visibility',0,5,'[]','[]',1,0,0)",
        )
        sql("INSERT INTO comment_text(cid,modified_at,text) VALUES($id,1,'${q(text)}')")
    }

    companion object {
        fun store(build: TriageFixture.() -> Unit): Store {
            val p = Files.createTempFile("pcs-triage", ".db")
            Files.delete(p)
            return Store.open(p, "test-only-key").also { TriageFixture(it).build() }
        }

        fun readings(
            q1: Q1 = Q1.REJECT_AT_ONCE,
            q2: Q2 = Q2.AC_PLUS_SENIOR,
            q3: Q3 = Q3.ANY_UNTIL_RELEASE,
            q6: Q6 = Q6.GROUNDS,
            q10: Q10 = Q10.DESK_REJECT,
        ) = Readings(q1 = q1, q2 = q2, q3 = q3, q6 = q6, q10 = q10)

        fun finding(
            pid: Long,
            ground: String?,
            engine: String = "stand-in",
            check: String = "format-check",
            quote: String = "a quoted sentence",
            verified: Boolean = true,
        ) =
            BundleFinding(
                pid = "$pid",
                check = check,
                version = "v1",
                kind = if (ground == null) "note" else "violation",
                ground = ground,
                severity = "high",
                status = if (verified) "verified" else "unverified",
                engine = engine,
                key = "$pid|$check|$ground",
                anchors = listOf(BundleAnchor(source = "pdf", quote = quote, page = 3, label = "p. 3")),
            )

        fun bundle(findings: List<BundleFinding>): BundlePayload =
            BundlePayload(
                BundleManifest(
                    createdAt = "2030-01-01T00:00:00Z",
                    papers = findings.map { it.pid }.distinct().map { BundlePaper(it, "0".repeat(64), "synthetic") },
                    checks = emptyList(),
                ),
                findings,
            )

        val tiers: (String) -> Tier? = { if (it.startsWith("junior")) Tier.JUNIOR else Tier.SENIOR }
    }
}

private val acEmail = "ac@example.org"
private val nowInstant = Instant.ofEpochSecond(1_900_000_000L)

fun triageWorld(vararg grounds: Pair<Long, String>, engine: String = "stand-in", giver: String = "senior1@example.org", build: TriageFixture.() -> Unit = {}) =
    TriageFixture.store {
        listOf(acEmail, giver, "senior2@example.org").forEach { person(it) }
        for ((pid, g) in grounds) {
            paper(pid, tags = listOf("pcs-refer-$g"))
            meta(pid, acEmail, round = null)
            opinion(pid, giver)
        }
        build()
    }.let { store ->
        store to
            TriagePlan.compute(
                store,
                TriageFixture.bundle(grounds.map { (pid, g) -> TriageFixture.finding(pid, g, engine = engine) }),
                emptyList(),
                TriageFixture.readings(),
                Stage.SCREENING,
                nowInstant.epochSecond / 3600,
                TriageFixture.tiers,
            ) as TriageReport.Ready
    }
