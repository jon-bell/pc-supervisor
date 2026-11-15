package net.jonbell.pcs.core.discussion

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.core.accountability.Tiers
import net.jonbell.pcs.core.rules.Phases
import net.jonbell.pcs.core.rules.Thresholds
import net.jonbell.pcs.core.session.Session
import net.jonbell.pcs.core.store.MirrorView
import net.jonbell.pcs.core.store.query
import java.time.Instant

/** What the discussion screen can show: the report, or what blocks it. */
public sealed interface DiscussionState {
    public data class Blocked(val reasons: List<String>) : DiscussionState

    /** [asOf] is when the last sync finished: every fact shown is as of then (H3). [notes] are settings problems and parts that could not be filled. */
    public data class Ready(val report: DiscussionReport, val asOf: Instant?, val notes: List<String>) : DiscussionState
}

public object DiscussionLoader {
    /** Dates the rules need: the review deadline, discussion opening, and the decisions deadline (spec §10.1). */
    public fun phases(dates: Map<String, Instant>): Pair<Phases?, List<String>> {
        val missing = listOf("REVIEW_DUE", "DISCUSSION_OPEN", "DECISIONS_DUE").filter { it !in dates }.map { "PCS_PHASE_$it is not set" }
        return if (missing.isNotEmpty()) {
            null to missing
        } else {
            Phases(dates.getValue("REVIEW_DUE"), dates.getValue("DISCUSSION_OPEN"), dates.getValue("DECISIONS_DUE")) to emptyList()
        }
    }

    /** Why "no movement" can't be trusted yet (H3): the mirror only knows scores from the syncs it has seen until the review history is read. */
    public fun historyNote(unread: Int): String =
        "$unread review(s) have no score history read from HotCRP yet, so 'no movement since discussion opened' may be premature. " +
            "A chair's Backfill review history reads it."

    /** The discussion dashboard at the session clock's now, from the mirror alone, plus the reviewing-progress report for outstanding reviews. */
    public fun state(s: Session): DiscussionState {
        val (ph, missing) = phases(s.settings.phases)
        if (ph == null) return DiscussionState.Blocked(missing)
        val st = s.settings
        val (thresholds, problems) = Thresholds.fromSettings(st.raw, st.meritAcceptMin, st.expertiseOkMin, st.reviewsRequired)
        val notes = problems.toMutableList()
        val unread =
            s.store.conn.query(
                "SELECT count(*) FROM review r LEFT JOIN backfill b ON b.rid = r.rid WHERE b.rid IS NULL AND r.gone_at IS NULL AND r.rtype <> 5 AND r.status <> 'empty'",
            ) { it.getInt(1) }.single()
        if (unread > 0) notes += historyNote(unread)
        val papers = MirrorView.load(s.store, st.fieldMerit, st.fieldExpertise)
        val names = s.store.conn.query("SELECT lower(email), coalesce(name, email) FROM person") { it.getString(1) to it.getString(2) }.toMap()
        val tags =
            s.store.conn.query("SELECT lower(email), tags FROM person WHERE gone_at IS NULL") {
                it.getString(1) to Json.parseToJsonElement(it.getString(2)).jsonArray.map { t -> t.jsonPrimitive.content }
            }.toMap()
        val sheet = net.jonbell.pcs.core.nominations.NominationData(s.store, net.jonbell.pcs.core.imports.Imports(s.store, s.clock)).input().sheet
        val tiers = Tiers.build(sheet, tags, st.tierTags)
        val acc =
            runCatching { s.accountability() }.onFailure {
                notes +=
                    "Reviewing progress could not be read, so outstanding reviews are not shown: ${it.message}"
            }.getOrNull()
        val input = DiscussionInput(papers, names, { tiers.of(it).group }, acc?.outstanding.orEmpty(), acc?.progress.orEmpty())
        return DiscussionState.Ready(DiscussionReports.build(input, ph, s.clock.now(), thresholds), s.lastSync()?.finishedAt, notes)
    }
}
