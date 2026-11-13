package pcs.core.rules

import pcs.core.readings.Q11
import pcs.core.readings.Q20

// Writeback's dry run and accountability requests (concepts §3.2, §3.6; model/ReviewProcess/Model.lean).

public data class Change(val dryRunOk: Boolean, val confirmed: Boolean)

public object WritebackRule {
    public fun mayApply(f: Faults, c: Change): Boolean = c.confirmed && (c.dryRunOk || f.applyWithoutDryRun)
}

public enum class ReqDisposition {
    REVISED,
    EXPLAINED,
    DECLINED,
    NO_REPLY,
    DISPUTED,
    ;

    public val engaged: Boolean get() = this == REVISED || this == EXPLAINED
    public val notEngaged: Boolean get() = this == DECLINED || this == NO_REPLY
}

public data class Request(
    val reviewer: Long,
    /** null: nobody sent it. */
    val sentBy: Long?,
    val due: Long = 48,
    val remindedAt: Long? = null,
    val replied: Boolean = false,
    val disp: ReqDisposition? = null,
)

public data class Suggestion(val reviewer: Long, val dismissed: Boolean = false)

public object Accountability {
    public const val GRACE: Long = 48

    /** Rule for `dispose` (AR5). */
    public fun mayDispose(req: Request, d: ReqDisposition, now: Long): Boolean =
        when (d) {
            ReqDisposition.NO_REPLY -> !req.replied && req.remindedAt != null && now > req.due + GRACE
            else -> req.replied
        }

    /** Requests that reached the reviewer: a person sent them, unless the mutant lets a heuristic send by itself. */
    public fun sentRequests(f: Faults, reqs: List<Request>): List<Request> = reqs.filter { it.sentBy != null || f.heuristicSendsItself }

    /** The engagement record (AR4): counts of dispositions only. */
    public fun engagement(f: Faults, reqs: List<Request>, sugs: List<Suggestion>, u: Long): Pair<Int, Int> {
        val mine = sentRequests(f, reqs).filter { it.reviewer == u }
        val engaged = mine.count { it.disp?.engaged == true }
        val notEng = mine.count { it.disp?.notEngaged == true }
        val dismissed = if (f.dismissedSuggestionCounts) sugs.count { it.reviewer == u && it.dismissed } else 0
        return engaged to notEng + dismissed
    }

    /** May an Accountability case about a nominee open? A missing review always may; a quality case needs a request under Q20 (AR6). */
    public fun caseMayOpen(f: Faults, q20: Q20, missingReview: Boolean, reqs: List<Request>): Boolean =
        missingReview || q20 == Q20.NO || sentRequests(f, reqs).any { it.disp?.notEngaged == true }

    public fun consequence(q11: Q11): String =
        when (q11) {
            Q11.REJECT_OWN_PAPERS -> "the nominating papers may be desk rejected, via the two-person path"
            Q11.RECORD_ONLY -> "recorded for the PC chairs; no effect on papers"
            Q11.NONE -> "no consequence"
        }
}
