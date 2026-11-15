package net.jonbell.pcs.core.accountability

import net.jonbell.pcs.core.nominations.Resolved
import net.jonbell.pcs.core.rules.ReqDisposition
import net.jonbell.pcs.core.rules.Tier
import java.time.Instant

/*
 * Reviewing progress and accountability requests (concepts §3.6, spec §10.4 D). These are the shapes the screen shows.
 * Everything here derives from HotCRP's record in the mirror plus the chairs' local choices (a dismissal, a case status);
 * PC Supervisor never contacts a reviewer.
 */

/** A reviewer's tier as the appointments sheet and tier tags give it; an accepted reciprocal nominee also has [nominee]. */
public data class PersonTier(val tier: Tier, val nominee: Boolean) {
    /** The group the progress view splits by: senior, junior or nominee. */
    public val group: String get() = if (nominee) "nominee" else tier.name.lowercase()
}

public data class ProgressRow(val group: String, val reviewers: Int, val assigned: Int, val submitted: Int, val outstanding: Int, val late: Int)

public data class OutstandingReview(
    val email: String,
    val name: String,
    val group: String,
    val pid: Long,
    val ordinal: String?,
    val status: String,
    /** Whole days past the review deadline, or null before it (or with no deadline configured). */
    val lateDays: Long?,
)

public data class CoachingItem(
    val pid: Long,
    val ordinal: String?,
    val reviewer: String,
    val name: String,
    val group: String,
    val words: Int,
    val reasons: List<String>,
    /** An AC comment visible to the paper's reviewers already exists on the paper (spec §11, "Coach a junior review"). */
    val coached: Boolean,
)

public enum class Source(public val key: String) {
    HEURISTIC("heuristic"),
    AC("ac"),
    JUNIOR_PC_CHAIR("junior-pc-chair"),
    ;

    public companion object {
        public fun ofKey(k: String): Source = entries.first { it.key == k }
    }
}

public enum class SuggestionStatus { OPEN, DISMISSED, SENT }

/** Concepts `AccountabilityRequest.suggestions`: a reminder to the AC that a review may deserve a request, never a message. */
public data class ReqSuggestion(
    val pid: Long,
    val ordinal: String,
    val reviewer: String,
    val name: String,
    val group: String,
    val source: Source,
    /** Criteria ids from the chairs' list that the signals point to (AR1: nothing outside the list). */
    val criteria: List<Int>,
    val reasons: List<String>,
    val status: SuggestionStatus,
)

public enum class ReqStatus { SENT, REMINDED, REPLIED, DISPOSED }

/** One request, from its tag (spec §11) and when a sync first saw it. Times are the clock's. */
public data class AccRequest(
    val pid: Long,
    val ordinal: String,
    val n: Int,
    val reviewer: String,
    val name: String,
    val group: String,
    val sentAt: Instant,
    val due: Instant,
    val remindedAt: Instant?,
    /** The reviewer revised the review after the request was first seen. */
    val revised: Boolean,
    val disposition: ReqDisposition?,
    val status: ReqStatus,
    /** The model's rule for the one reminder, whatever is recorded: after the due date, no reply, none sent yet (`accRule.remind`). Offer it only while [disposition] is null. */
    val mayRemind: Boolean,
    /** The model's rule for "no reply" (AR5): reminded, and past the due date plus the grace period. Offer it only while [disposition] is null. */
    val mayNoReply: Boolean,
    /** When "no reply" first becomes available; null if no reminder has been recorded yet. */
    val noReplyFrom: Instant?,
)

/** The engagement record (AR4): counts of dispositions only. */
public data class Engagement(
    val reviewer: String,
    val name: String,
    val group: String,
    val engaged: Int,
    val notEngaged: Int,
    val disputed: Int,
    /** Requests that reached the reviewer and have no disposition yet (the model's `sentRequests`: a person sent them). */
    val open: Int,
    /** Requests that reached the reviewer, whatever their disposition. */
    val requests: Int = engaged + notEngaged + disputed + open,
    /** The papers those requests were about, for who may see the record (Q21). */
    val pids: List<Long> = emptyList(),
)

public enum class CaseStatus { CANDIDATE, OPEN, DISMISSED, UPHELD }

/** An Accountability case about an accepted nominee (concepts `Accountability`, Q11 and Q20). */
public data class AccCase(
    val nominee: String,
    val name: String,
    val number: Int,
    /** The nominating papers whose share went unmet (X10): one case lists them all. */
    val papers: List<Long>,
    val missingReview: Boolean,
    val qualityConcern: Boolean,
    /** Q20: a quality case needs an earlier request disposed declined or unanswered. */
    val mayOpen: Resolved<Boolean>,
    /** Q11: what the case may lead to (always through the two-person path, V4). */
    val consequence: Resolved<String>,
    val status: CaseStatus,
    val notes: List<String>,
)

/** A criterion of the chairs' list: [signals] are the heuristic signals it answers. */
public data class Criterion(val id: Int, val text: String, val signals: Set<String>)

/** Who is looking at an engagement record. */
public sealed interface Viewer {
    public data object PcChair : Viewer

    public data object JuniorPcChair : Viewer

    public data class Ac(val email: String) : Viewer
}

public data class AccountabilityReport(
    val progress: List<ProgressRow>,
    val outstanding: List<OutstandingReview>,
    val coaching: List<CoachingItem>,
    val suggestions: List<ReqSuggestion>,
    val requests: List<AccRequest>,
    val engagement: List<Engagement>,
    val cases: List<AccCase>,
    val criteria: List<Criterion>,
    /** Why a part can't be shown or acted on yet (no criteria list, an unanswered reading). */
    val notes: List<String>,
    /** Each paper's ACs (its metareviewers) by email: the AC who sent a request is the paper's AC. */
    val acPapers: Map<Long, Set<String>> = emptyMap(),
    /** The rules' view of the requests: what a person sent, and each open suggestion as a request nobody sent (so the model's mutants show). */
    val modelRequests: List<net.jonbell.pcs.core.rules.Request> = emptyList(),
    /** How lateness was dated: reviews whose HotCRP time is unknown, and reviews first seen by a sync far from HotCRP's own time (empty when all agree). */
    val dating: List<String> = emptyList(),
) {
    /**
     * Who sees a reviewer's engagement record (Q21, policy cell `see-engagement`): the PC chairs see all; an AC the
     * records of requests about their own papers; the junior PC chair those of junior reviewers and nominees.
     */
    public fun engagementFor(viewer: Viewer): List<Engagement> =
        when (viewer) {
            Viewer.PcChair -> engagement
            Viewer.JuniorPcChair -> engagement.filter { it.group != "senior" }
            is Viewer.Ac -> engagement.filter { e -> e.pids.any { viewer.email.lowercase() in acPapers[it].orEmpty() } }
        }

    /** The nominee view: progress and outstanding reviews of accepted nominees only. */
    public val nomineeProgress: ProgressRow? get() = progress.firstOrNull { it.group == "nominee" }
    public val nomineeOutstanding: List<OutstandingReview> get() = outstanding.filter { it.group == "nominee" }
}
