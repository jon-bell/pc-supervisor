package net.jonbell.pcs.core.triage

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.core.rules.Conventions
import net.jonbell.pcs.core.rules.DeskFlow
import net.jonbell.pcs.core.rules.Ground
import net.jonbell.pcs.core.rules.Opinion
import net.jonbell.pcs.core.rules.Referral
import net.jonbell.pcs.core.rules.Stage
import net.jonbell.pcs.core.rules.Tier
import net.jonbell.pcs.core.rules.Trace
import net.jonbell.pcs.core.rules.TriageChoice
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.query
import net.jonbell.pcs.core.writeback.ConventionAudit

/*
 * What the mirror says about one paper's desk-reject referral (spec §11): the AC's triage (the hidden tag a chair mirrored, else the
 * Triage field of the AC's complete screen-round metareview), the second opinions (complete screen-round reviews by someone who is
 * not the AC), the fix window and the warning (hidden tags), the cure (an edit of the paper inside the window), and the decision.
 * Nothing here decides: `DeskReject.mayRemove` does, through [DeskFacts.referral].
 */

/** Where the AC's triage was read from. A review is the AC's own words; a tag is what a chair mirrored from it. */
public enum class TriageSource { TAG, REVIEW }

/**
 * One person who gave a second opinion. [agrees] is false when they said keep in the Triage field of their screen-round review (true for remove,
 * the model's `Opinion.agrees`). [isAcNote] is the AC's own comment to the PC in her screening review, which is never an opinion.
 */
public data class GivenOpinion(
    val email: String,
    val tier: Tier?,
    val conflicted: Boolean,
    val isAcNote: Boolean = false,
    val requestedAtH: Long? = null,
    val agrees: Boolean = true,
)

public data class DeskFacts(
    val pid: Long,
    val title: String,
    val ac: String?,
    val choice: TriageChoice?,
    val source: TriageSource?,
    /** The paper's `pcs-keep` / `pcs-refer-*` tag exists (the chair mirrored the triage). */
    val mirrored: Boolean,
    val opinions: List<GivenOpinion>,
    /** Screen-round review assignments for second opinions that are not complete yet. */
    val requested: List<String>,
    /** Epoch hours the fix window closes, if offered. */
    val remedyDueH: Long?,
    val warned: Boolean,
    val cured: Boolean,
    val removed: Boolean,
    val authors: List<String>,
    /** Epoch hours of the first second-opinion request (the "silence removes" mutant's clock), or null. */
    val askedAtH: Long?,
) {
    /** The ground of a referral, or null for a keep or no triage. */
    val ground: Ground? get() = (choice as? TriageChoice.Refer)?.ground

    /** The model's person numbers: the AC is 1, everyone else numbered from 2 by sorted email. Only comparisons with the AC matter. */
    public fun ids(): Map<String, Long> =
        opinions.map { it.email.lowercase() }.distinct().filter { it != ac?.lowercase() }.sorted().mapIndexed { i, e -> e to (i + 2L) }.toMap()

    /** The referral as the model's rules take it; null if the paper was not referred. */
    public fun referral(stage: Stage, nowH: Long): Referral? {
        val g = ground ?: return null
        val ids = ids()
        return Referral(
            ac = 1,
            ground = g,
            opinions =
                opinions.map { o ->
                    Opinion(if (o.email.equals(ac, true)) 1 else ids.getValue(o.email.lowercase()), o.email.equals(ac, true), o.tier, o.conflicted, o.agrees)
                },
            stage = stage,
            remedyOffered = remedyDueH != null,
            remedyDue = remedyDueH ?: 0,
            cured = cured,
            warned = warned,
            askedAt = askedAtH ?: 0,
            now = nowH,
        )
    }
}

public object DeskFactsReader {
    private fun tags(json: String): List<String> = Json.parseToJsonElement(json).jsonArray.map { it.jsonPrimitive.content }

    private data class Pr(
        val pid: Long,
        val title: String,
        val decision: String?,
        val traces: List<Trace>,
        val conflicts: Set<String>,
        val authors: List<String>,
        val modified: Long?,
    )

    private data class Rv(
        val pid: Long,
        val rid: Long,
        val email: String,
        val rtype: Int,
        val status: String,
        val round: String?,
        val firstSeen: Long,
        val note: Boolean,
    )

    /** Facts for every paper that is referred, kept, has a screen-round review, or is in [also] (the papers the bundle flagged). */
    public fun read(store: Store, tier: (String) -> Tier?, remedyWindowH: Long = DeskFlow.REMEDY_WINDOW_H, also: Set<Long> = emptySet()): List<DeskFacts> {
        val triage = ConventionAudit.trustedTriage(store).associateBy { it.pid }
        val unmirrored = ConventionAudit.trustedOpinions(store).groupBy { it.pid }
        val reviews =
            store.conn.query(
                "SELECT r.pid, r.rid, lower(r.email), r.rtype, r.status, r.round, r.first_seen_at, " +
                    "EXISTS(SELECT 1 FROM review_text t WHERE t.rid = r.rid AND t.vtag = r.vtag AND t.field_uid = 'ComPC' AND trim(t.text) <> '') " +
                    "FROM review r WHERE r.gone_at IS NULL AND r.email IS NOT NULL ORDER BY r.rid",
            ) {
                Rv(it.getLong(1), it.getLong(2), it.getString(3), it.getInt(4), it.getString(5), it.getString(6), it.getLong(7), it.getInt(8) == 1)
            }.groupBy { it.pid }
        val out = mutableListOf<DeskFacts>()
        store.conn.query("SELECT pid, coalesce(title,''), decision, tags, pc_conflicts, authors, modified_at FROM paper WHERE gone_at IS NULL ORDER BY pid") {
            Pr(
                it.getLong(1),
                it.getString(2),
                it.getString(3),
                Conventions.decode(it.getLong(1), tags(it.getString(4))),
                Json.parseToJsonElement(it.getString(5)).jsonObject.keys.map { k -> k.lowercase() }.toSet(),
                Json.parseToJsonElement(it.getString(6)).jsonArray.map { a -> a.jsonPrimitive.content },
                it.getObject(7)?.toString()?.toLongOrNull(),
            )
        }.forEach { (pid, title, decision, traces, conflicts, authors, modified) ->
            val rvs = reviews[pid].orEmpty()
            val ac = rvs.firstOrNull { it.rtype == 5 }?.email
            val screen = rvs.filter { it.round == "screen" && it.rtype != 5 }
            // second opinions: the hidden tag a chair mirrored (the review has since moved to the normal round), else the Triage value still in the review
            val tagged = traces.filterIsInstance<Trace.Opinion>().mapNotNull { t -> rvs.firstOrNull { it.rid == t.rid }?.let { it to t.keep } }
            val seen =
                unmirrored[pid].orEmpty().filter { o -> tagged.none { it.first.rid == o.rid } }.mapNotNull { o ->
                    rvs.firstOrNull { it.rid == o.rid }?.let {
                        it to
                            o.keep
                    }
                }
            val recorded = tagged + seen
            val tagChoice =
                when {
                    traces.any { it is Trace.Keep } -> TriageChoice.Keep
                    else -> traces.filterIsInstance<Trace.Refer>().firstOrNull()?.let { TriageChoice.Refer(it.ground) }
                }
            val read = triage[pid]
            val choice = tagChoice ?: read?.choice
            if (choice == null && screen.isEmpty() && pid !in also) return@forEach
            val given =
                recorded.map { (r, keep) -> GivenOpinion(r.email, tier(r.email), r.email in conflicts, requestedAtH = r.firstSeen / 3600, agrees = !keep) } +
                    rvs.filter { it.rtype == 5 && it.note }.map { GivenOpinion(it.email, tier(it.email), it.email in conflicts, isAcNote = true) }
            val dueH = traces.filterIsInstance<Trace.RemedyDue>().firstOrNull()?.dueEpoch?.let { it / 3600 }
            val cured = dueH != null && modified != null && modified > (dueH - remedyWindowH) * 3600 && modified <= dueH * 3600
            out +=
                DeskFacts(
                    pid = pid,
                    title = title,
                    ac = ac,
                    choice = choice,
                    source =
                        if (tagChoice != null) {
                            TriageSource.TAG
                        } else if (read != null) {
                            TriageSource.REVIEW
                        } else {
                            null
                        },
                    mirrored = tagChoice != null,
                    opinions = given.distinctBy { it.email },
                    requested = screen.filter { s -> recorded.none { it.first.rid == s.rid } }.map { it.email },
                    remedyDueH = dueH,
                    warned = traces.any { it is Trace.Warned },
                    cured = cured,
                    removed = decision?.lowercase()?.startsWith("reject") == true && choice is TriageChoice.Refer,
                    authors = authors,
                    askedAtH = (screen + recorded.map { it.first }).minOfOrNull { it.firstSeen }?.let { it / 3600 },
                )
        }
        return out
    }
}
