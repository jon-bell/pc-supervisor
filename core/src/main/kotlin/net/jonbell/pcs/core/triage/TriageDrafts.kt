package net.jonbell.pcs.core.triage

import net.jonbell.pcs.core.rules.Conventions
import net.jonbell.pcs.core.rules.Ground
import net.jonbell.pcs.core.rules.Trace
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.query
import net.jonbell.pcs.core.writeback.Artifact
import net.jonbell.pcs.core.writeback.AssignmentArtifact
import net.jonbell.pcs.core.writeback.CommentArtifact
import net.jonbell.pcs.core.writeback.DecisionArtifact
import net.jonbell.pcs.core.writeback.ScreenRound
import net.jonbell.pcs.core.writeback.TagArtifact
import net.jonbell.pcs.core.writeback.TagChange
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/**
 * The chair's actions of spec §10.4 B and §11, as Writeback artifacts and mail drafts. Nothing here writes to HotCRP or sends mail:
 * a chair reviews HotCRP's dry run, confirms, and Writeback applies it (the Mail page does not take a token, so a chair sends the
 * notices from HotCRP with the text drafted here).
 */
public object TriageDrafts {
    /** A mail the chair sends: the text, and the HotCRP search for the papers it is about (a chair pastes both into the Mail tool). */
    public data class MailDraft(val subject: String, val body: String, val search: String)

    private fun search(pids: List<Long>) = pids.sorted().joinToString(" ")

    /** The triage mirror (hidden tags), then the unsubmit-and-move of the AC's screening metareviews (M3a's leftover, done by Writeback). */
    public fun mirrorTriage(store: Store): List<Artifact> = ScreenRound.triageDrafts(store)

    /** Q5: once a paper is kept, its screen-round second opinions move to the normal round, text kept. */
    public fun moveSecondOpinions(store: Store): List<Artifact> = ScreenRound.secondOpinionDrafts(store)

    /** Papers that already carry a screening-record comment by a chair, with the comment's id and visibility. */
    public fun findingsComments(store: Store): Map<Long, Pair<Long, String?>> {
        val chairs =
            store.conn.query("SELECT lower(email), roles FROM person WHERE gone_at IS NULL") { it.getString(1) to it.getString(2) }
                .filter { "\"chair\"" in it.second }.map { it.first }.toSet()
        return store.conn.query(
            "SELECT c.cid, c.pid, lower(c.email), c.visibility, (SELECT text FROM comment_text t WHERE t.cid = c.cid ORDER BY modified_at DESC LIMIT 1) " +
                "FROM comment c WHERE c.deleted_seen_at IS NULL ORDER BY c.cid",
        ) { listOf(it.getLong(1), it.getLong(2), it.getString(3), it.getString(4), it.getString(5)) }
            .filter {
                Conventions.decodeComment(it[1] as Long, it[0] as Long, it[2] as String?, (it[4] as String?).orEmpty()) is Trace.Findings &&
                    it[2] in chairs
            }
            .associate { (it[1] as Long) to ((it[0] as Long) to (it[3] as String?)) }
    }

    /** The screening record as a reviewer-visible comment on each flagged paper that has none yet (spec §11: the AC sees it before writing anything). */
    public fun postFindings(store: Store, rows: List<TriageRow>): List<Artifact> {
        val have = findingsComments(store).keys
        return rows.filter { it.findings.isNotEmpty() && it.pid !in have && it.status != TriageStatus.REMOVED }
            .map { CommentArtifact(it.pid, Notices.findingsComment(it.findings), visibility = "rev") }
    }

    /** After triage the record is withdrawn from reviewers by editing its visibility to admin (spec §11). */
    public fun withdrawFindings(store: Store, rows: List<TriageRow>): List<Artifact> {
        val have = findingsComments(store)
        val done = rows.filter { it.status == TriageStatus.KEPT || it.status == TriageStatus.REMOVED }.map { it.pid }.toSet()
        return have.filter { (pid, c) -> pid in done && c.second != "admin" }
            .map { (pid, c) -> CommentArtifact(pid, Conventions.FINDINGS_MARKER + "\nWithdrawn after triage.", visibility = "admin", cid = c.first) }
    }

    /** Asks [email] for a second opinion on [pid]: a screen-round review assignment, and the mail text the chair sends with it. */
    public fun requestSecondOpinion(row: TriageRow, email: String): Pair<Artifact, MailDraft> {
        val g = row.grounds.firstOrNull() ?: throw IllegalArgumentException("paper ${row.pid} has no ground to ask about")
        return AssignmentArtifact(
            listOf(mapOf("pid" to "${row.pid}", "action" to "pcreview", "user" to email, "round" to "screen")),
            "Second opinion on #${row.pid}",
        ) to MailDraft("Second opinion on paper #${row.pid}", Notices.secondOpinionRequest(g), "${row.pid}")
    }

    private fun zoned(t: Instant, zone: ZoneId) = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm z").withZone(zone).format(t)

    /** Offers the Q1 fix window: the hidden tag `pcs-remedy-due`, and the notice. Only an anonymity referral gets one (the model's `offerRemedy`). */
    public fun offerRemedy(
        row: TriageRow,
        now: Instant,
        zone: ZoneId,
        windowH: Long = net.jonbell.pcs.core.rules.DeskFlow.REMEDY_WINDOW_H,
    ): Pair<Artifact, MailDraft> {
        require(row.status == TriageStatus.NEEDS_REMEDY && Ground.ANONYMITY in row.grounds) { "paper ${row.pid} is not waiting for a fix window" }
        val due = now.plusSeconds(windowH * 3600)
        return TagArtifact(
            listOf(TagChange(row.pid, add = listOf(Conventions.encode(Trace.RemedyDue(row.pid, due.epochSecond))))),
            "Fix window for #${row.pid}",
        ) to
            MailDraft("Paper #${row.pid}: a fix is needed", Notices.remedyOffer(Ground.ANONYMITY, zoned(due, zone)), "${row.pid}")
    }

    /** Q10's warning: the hidden tag `pcs-warned`, and the warning's text. */
    public fun warn(row: TriageRow): Pair<Artifact, MailDraft> {
        require(row.status == TriageStatus.NEEDS_WARNING) { "paper ${row.pid} is not waiting for a warning" }
        return TagArtifact(listOf(TagChange(row.pid, add = listOf(Conventions.encode(Trace.Warned(row.pid))))), "Warn #${row.pid}") to
            MailDraft("Paper #${row.pid}: nominations", Notices.warning(), "${row.pid}")
    }

    /** The removal: a decision for each paper that is `READY`, and one notice per ground (a chair sends each to that ground's authors). */
    public fun remove(rows: List<TriageRow>, confirmed: Set<Long>? = null): Pair<Artifact, List<MailDraft>> {
        val ready = rows.filter { it.status == TriageStatus.READY && (confirmed == null || it.pid in confirmed) }
        require(ready.isNotEmpty()) { "no paper is ready to remove" }
        val byGround = ready.groupBy { it.grounds.first() }.toSortedMap(compareBy { it.ordinal })
        return DecisionArtifact(ready.associate { it.pid to "Reject" }, byGround.entries.joinToString("\n---\n") { Notices.removal(it.key) }) to
            byGround.map { (g, rs) -> MailDraft("Paper rejected before review", Notices.removal(g), search(rs.map { it.pid })) }
    }
}
