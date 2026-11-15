package net.jonbell.pcs.core.triage

import net.jonbell.pcs.core.bundle.BundleFinding
import net.jonbell.pcs.core.bundle.BundlePayload
import net.jonbell.pcs.core.imports.ImportRow
import net.jonbell.pcs.core.readings.Q10
import net.jonbell.pcs.core.readings.Q2
import net.jonbell.pcs.core.readings.Readings
import net.jonbell.pcs.core.rules.DeskFlow
import net.jonbell.pcs.core.rules.DeskReject
import net.jonbell.pcs.core.rules.Faults
import net.jonbell.pcs.core.rules.Ground
import net.jonbell.pcs.core.rules.Referral
import net.jonbell.pcs.core.rules.Stage
import net.jonbell.pcs.core.rules.Tier
import net.jonbell.pcs.core.rules.TriageChoice
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.query

/*
 * The triage queue (concepts §3.4, spec §10.4 B): `paper -> findings (screening bundle), refcheck, AC flag -> AC triage -> second
 * opinion -> remedy -> chair action -> notice`. The decision whether a chair may remove a paper is the model's `mayRemove`
 * (`DeskReject`); this file reads the mirror into its inputs, says which conjunct holds a paper back, and never writes.
 * Silence keeps (S8): a paper with no triage, no opinion, or an unanswered request is in review and says why.
 */

public enum class TriageStatus(public val label: String, public val needsChair: Boolean = false) {
    UNTRIAGED("waiting for the AC"),
    KEPT("kept in review"),
    KEEP_REFUSED("keep not allowed: an anonymity violation (Q1)", true),
    NEEDS_SECOND_OPINION("referred; needs a second opinion", true),
    OPINION_PENDING("referred; second opinion requested"),
    OPINION_DISAGREES("referred; the second opinion says keep", true),
    NOT_ADMISSIBLE("referred; not a ground under the readings", true),
    NEEDS_WARNING("referred; needs the warning first (Q10)", true),
    TOO_LATE("referred; too late for this ground (Q3)", true),
    NEEDS_REMEDY("referred; needs the fix window (Q1)", true),
    REMEDY_OPEN("fix window open"),
    CURED("cured inside the fix window; stays in review"),
    READY("ready for a chair to remove", true),
    REMOVED("desk rejected"),
}

/** One refcheck row from the `refcheck` import that bears on a paper (a reference that no index found, and why). */
public data class RefcheckNote(val reference: String, val status: String, val detail: String)

public data class TriageRow(
    val pid: Long,
    val title: String,
    val ac: String?,
    /** Verified findings only: an unverified one never reaches a person. */
    val findings: List<BundleFinding>,
    val refcheck: List<RefcheckNote>,
    val facts: DeskFacts?,
    val status: TriageStatus,
    /** Every conjunct of `mayRemove` that does not hold, in words. */
    val blockers: List<String>,
    val stage: Stage,
    /** The paper would be (or was) removed after the desk-reject window (`PCS_PHASE_DESKREJECT_DUE`): tracked as late. */
    val late: Boolean,
    /** The AC's triage is in a screening review and no chair has mirrored it yet. */
    val needsMirror: Boolean,
    /** The ground of the referral, else the findings' grounds. */
    val grounds: List<Ground>,
) {
    val flagged: Boolean get() = findings.isNotEmpty()
}

public sealed interface TriageReport {
    public data class Blocked(val reasons: List<String>) : TriageReport

    public data class Ready(val rows: List<TriageRow>, val stage: Stage, val bundleHash: String?) : TriageReport {
        public fun status(pid: Long): TriageStatus? = rows.firstOrNull { it.pid == pid }?.status

        public val queue: List<TriageRow> get() = rows.filter { it.status != TriageStatus.REMOVED && it.status != TriageStatus.KEPT }
    }
}

public object TriagePlan {
    /** The questions the plan reads; any unresolved one blocks it (an unanswered question is never defaulted). */
    public fun unresolved(r: Readings): List<String> =
        listOfNotNull(
            if (r.q1 == null) "Q1 (a double-anonymity violation) is unresolved" else null,
            if (r.q2 == null) "Q2 (who must agree to a desk reject) is unresolved" else null,
            if (r.q3 == null) "Q3 (until when a desk reject is possible) is unresolved" else null,
            if (r.q6 == null) "Q6 (a fabricated reference) is unresolved" else null,
            if (r.q10 == null) "Q10 (a paper that names no nominee) is unresolved" else null,
        )

    /** The conjuncts of `mayRemove` that fail for [ref], as (priority, status, words). */
    public fun blockers(r: Readings, ref: Referral): List<Pair<TriageStatus, String>> {
        val out = mutableListOf<Pair<TriageStatus, String>>()
        val q1 = r.q1!!
        val q2 = r.q2!!
        val q3 = r.q3!!
        val q6 = r.q6!!
        val q10 = r.q10!!
        if (!DeskReject.stageAllowed(q3, ref.ground, ref.stage)) {
            out += TriageStatus.TOO_LATE to "Q3 (${q3.key}) does not allow a desk reject on ${ref.ground.key} at the ${ref.stage.key} stage"
        }
        if (!DeskReject.groundAdmissible(q6, q10, ref)) {
            out +=
                when {
                    ref.ground == Ground.FABRICATED_REFERENCE ->
                        TriageStatus.NOT_ADMISSIBLE to
                            "Q6: a fabricated reference is evidence for the AC, not a ground"
                    q10 == Q10.WARN_ONLY -> TriageStatus.NOT_ADMISSIBLE to "Q10: a paper that names no nominee gets a warning only"
                    else -> TriageStatus.NEEDS_WARNING to "Q10: the authors must be warned first, and the warning ignored"
                }
        }
        if (!DeskReject.twoPerson(Faults.NONE, q2, ref)) {
            out += TriageStatus.NEEDS_SECOND_OPINION to "Q2 (${q2.key}): the AC's referral needs another person to agree"
        }
        if (!DeskReject.remedyHonored(q1, ref)) {
            out +=
                when {
                    !ref.remedyOffered -> TriageStatus.NEEDS_REMEDY to "Q1: the authors get a fix window before a removal"
                    ref.cured -> TriageStatus.CURED to "the authors fixed it inside the window"
                    else -> TriageStatus.REMEDY_OPEN to "the fix window is still open"
                }
        }
        return out
    }

    /** Where one paper stands. [f] is the implementation's fault switch, used only by the end-to-end mutant tests. */
    public fun statusOf(
        f: Faults,
        r: Readings,
        facts: DeskFacts,
        stage: Stage,
        nowH: Long,
        anonymityFound: Boolean,
    ): Triple<TriageStatus, List<String>, Boolean> {
        if (facts.removed) return Triple(TriageStatus.REMOVED, emptyList(), stage != Stage.SCREENING)
        val choice = facts.choice ?: return Triple(TriageStatus.UNTRIAGED, listOf("the AC has not triaged this paper: it stays in review"), false)
        if (choice is TriageChoice.Keep) {
            return if (anonymityFound && !DeskReject.acMayKeep(r.q1!!, Ground.ANONYMITY)) {
                Triple(TriageStatus.KEEP_REFUSED, listOf("Q1 (reject at once): an anonymity violation can't be kept; the AC refers it"), false)
            } else {
                Triple(TriageStatus.KEPT, emptyList(), false)
            }
        }
        val ref = facts.referral(stage, nowH)!!
        if (DeskReject.mayRemove(f, r, ref)) return Triple(TriageStatus.READY, emptyList(), stage != Stage.SCREENING)
        val bl = blockers(r, ref)
        val first = bl.firstOrNull()?.first ?: TriageStatus.NEEDS_SECOND_OPINION
        val disagree = facts.opinions.count { !it.isAcNote && !it.agrees }
        val status =
            when {
                first != TriageStatus.NEEDS_SECOND_OPINION -> first
                facts.requested.isNotEmpty() -> TriageStatus.OPINION_PENDING
                disagree > 0 -> TriageStatus.OPINION_DISAGREES
                else -> first
            }
        val words =
            bl.map { it.second } +
                if (disagree >
                    0
                ) {
                    listOf(
                        "$disagree second opinion(s) say keep (recorded in the Triage field of their screening review); a keep never counts toward removal",
                    )
                } else {
                    emptyList()
                }
        return Triple(status, words, false)
    }

    public fun compute(
        store: Store,
        bundle: BundlePayload?,
        refcheck: List<ImportRow>,
        readings: Readings,
        stage: Stage,
        nowH: Long,
        tier: (String) -> Tier?,
        f: Faults = Faults.NONE,
        remedyWindowH: Long = DeskFlow.REMEDY_WINDOW_H,
    ): TriageReport {
        val blocked = unresolved(readings)
        if (blocked.isNotEmpty()) return TriageReport.Blocked(blocked)
        val findings = bundle?.visible?.filter { it.ground != null || it.kind.isNotEmpty() }?.groupBy { it.pid.toLongOrNull() }.orEmpty()
        val flagged = findings.keys.filterNotNull().toSet()
        val facts = DeskFactsReader.read(store, tier, remedyWindowH, also = flagged).associateBy { it.pid }
        val titles =
            store.conn.createStatement().use { s ->
                s.executeQuery("SELECT pid, coalesce(title,'') FROM paper WHERE gone_at IS NULL").use { rs ->
                    buildMap { while (rs.next()) put(rs.getLong(1), rs.getString(2)) }
                }
            }
        val ref = refcheck.groupBy { it.data["pid"]?.toLongOrNull() }
        val rows =
            (flagged + facts.keys).filter { it in titles }.sorted().map { pid ->
                val fs = findings[pid].orEmpty().filter { it.ground != null }
                val fa =
                    facts[pid] ?: DeskFacts(
                        pid,
                        titles[pid].orEmpty(),
                        null,
                        null,
                        null,
                        false,
                        emptyList(),
                        emptyList(),
                        null,
                        false,
                        false,
                        false,
                        emptyList(),
                        null,
                    )
                val (status, why, late) =
                    statusOf(f, readings, fa, stage, nowH, anonymityFound = fs.any { it.ground == Ground.ANONYMITY.key })
                TriageRow(
                    pid = pid,
                    title = titles[pid].orEmpty(),
                    ac = fa.ac,
                    findings = findings[pid].orEmpty(),
                    refcheck =
                        ref[pid].orEmpty().map {
                            RefcheckNote(it.data["reference"].orEmpty(), it.data["status"].orEmpty(), it.data["detail"].orEmpty())
                        },
                    facts = facts[pid],
                    status = status,
                    blockers = why,
                    stage = stage,
                    late = late,
                    needsMirror = fa.source == TriageSource.REVIEW,
                    grounds = listOfNotNull(fa.ground).ifEmpty { fs.mapNotNull { Ground.ofKey(it.ground!!) }.distinct() },
                )
            }
        return TriageReport.Ready(rows, stage, bundle?.hash())
    }
}

/** The PC members the chairs could ask for a second opinion on [pid]: Q2's kind, unconflicted, not the AC, not an author, not already reviewing it. */
public data class OpinionCandidate(val email: String, val tier: Tier?, val isAc: Boolean, val screeningOpinions: Int)

public object SecondOpinions {
    public fun candidates(store: Store, pid: Long, q2: Q2, tier: (String) -> Tier?): List<OpinionCandidate> {
        if (q2 == Q2.AC_ALONE) return emptyList()
        val pcs =
            store.conn.query("SELECT lower(email), roles FROM person WHERE gone_at IS NULL") { it.getString(1) to it.getString(2) }.filter {
                "\"pc\"" in
                    it.second ||
                    "\"chair\"" in it.second
            }
        val acs =
            store.conn.query("SELECT DISTINCT lower(email) FROM review WHERE rtype = 5 AND gone_at IS NULL AND email IS NOT NULL") {
                it.getString(1)
            }.toSet()
        val on = store.conn.query("SELECT lower(email) FROM review WHERE pid = $pid AND gone_at IS NULL AND email IS NOT NULL") { it.getString(1) }.toSet()
        val conflicted =
            store.conn.query("SELECT pc_conflicts FROM paper WHERE pid = $pid") { it.getString(1) }.firstOrNull()
                ?.let {
                    kotlinx.serialization.json.Json.parseToJsonElement(it) as kotlinx.serialization.json.JsonObject
                }?.keys?.map { it.lowercase() }?.toSet().orEmpty()
        val authors =
            store.conn.query("SELECT authors FROM paper WHERE pid = $pid") { it.getString(1) }.firstOrNull()
                ?.let {
                    kotlinx.serialization.json.Json.parseToJsonElement(it) as kotlinx.serialization.json.JsonArray
                }?.map { (it as kotlinx.serialization.json.JsonPrimitive).content.lowercase() }?.toSet().orEmpty()
        val screen =
            store.conn.query("SELECT lower(email), count(*) FROM review WHERE round = 'screen' AND rtype <> 5 AND gone_at IS NULL GROUP BY lower(email)") {
                it.getString(1) to
                    it.getInt(2)
            }.toMap()
        return pcs.map { it.first }.filter { it !in on && it !in conflicted && it !in authors }.map {
            OpinionCandidate(it, tier(it), it in acs, screen[it] ?: 0)
        }.filter {
            when (q2) {
                Q2.AC_PLUS_SENIOR -> it.tier != Tier.JUNIOR
                Q2.AC_PLUS_AC -> it.isAc
                Q2.VOTE -> true
                Q2.AC_ALONE -> false
            }
        }.sortedWith(compareBy({ it.screeningOpinions }, { it.email }))
    }
}
