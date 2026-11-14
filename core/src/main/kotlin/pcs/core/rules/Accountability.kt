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

    /** The papers an Accountability case lists: those whose share went unmet (X10). */
    public fun unmetPapers(shares: List<Share>): List<Long> = shares.filter { it.done < it.owed }.map { it.paper }

    /** One case per nominee, never one per paper. */
    public fun casesFor(shares: List<Share>): Int = if (unmetPapers(shares).isEmpty()) 0 else 1

    /** Who disposes of a request the reviewer disputes (C5): the junior PC chair for a junior reviewer, else the PC chairs. */
    public fun escalationTarget(tier: Tier?): String = if (tier == Tier.JUNIOR) "the junior PC chair" else "the PC chairs"
}

/** A nominating paper's share of a nominee's reviews: owed, and done (model `Share`). */
public data class Share(val paper: Long, val owed: Int, val done: Int)

/** The accountability subsystem's state (model `AccSt`): one request about one review, and a case about its reviewer. */
public data class AccSt(
    val criteria: Boolean = false,
    val suggested: Boolean = false,
    val dismissed: Boolean = false,
    val coached: Boolean = false,
    val req: Request? = null,
    val now: Long = 0,
    val caseOpen: Boolean = false,
    val upheld: Boolean = false,
)

public sealed interface AccAct {
    public data object SetCriteria : AccAct

    public data object Suggest : AccAct

    public data object Dismiss : AccAct

    public data object Coach : AccAct

    public data object Send : AccAct

    public data object Remind : AccAct

    public data object Reply : AccAct

    public data class Dispose(val d: ReqDisposition) : AccAct

    public data object Tick : AccAct

    public data object OpenCase : AccAct

    public data object Uphold : AccAct
}

/**
 * The guards of each accountability action (model `accRule`), in the order the model gives them. The app and the
 * scenario runner use these guards before any write; the policy gate (who may act) is the caller's, as the model's
 * `gated` is separate from its rules.
 */
public object AccFlow {
    /** Model hours between sending a request and its due date. */
    public const val DUE_H: Long = 48

    public fun mayRemind(q: Request, now: Long): Boolean = !q.replied && q.remindedAt == null && now > q.due

    public fun mayDismiss(s: AccSt): Boolean = s.suggested && !s.dismissed && s.req == null

    public fun maySend(s: AccSt): Boolean = s.criteria && s.req == null

    public fun rule(f: Faults, q20: Q20, s: AccSt, who: String?, a: AccAct): AccSt? =
        when (a) {
            AccAct.SetCriteria -> if (!s.criteria) s.copy(criteria = true) else null
            AccAct.Suggest -> if (!s.suggested) s.copy(suggested = true) else null
            AccAct.Dismiss -> if (mayDismiss(s)) s.copy(dismissed = true) else null
            AccAct.Coach -> if (!s.coached) s.copy(coached = true) else null
            AccAct.Send -> if (maySend(s)) s.copy(req = Request(reviewer = 7, sentBy = if (who == "ac") 1 else 5, due = s.now + DUE_H)) else null
            AccAct.Remind -> s.req?.let { q -> if (mayRemind(q, s.now)) s.copy(req = q.copy(remindedAt = s.now)) else null }
            AccAct.Reply ->
                s.req?.let { q -> if ((who == "nominee" || who == "pc-member") && !q.replied && q.disp == null) s.copy(req = q.copy(replied = true)) else null }
            is AccAct.Dispose -> s.req?.let { q -> if (q.disp == null && Accountability.mayDispose(q, a.d, s.now)) s.copy(req = q.copy(disp = a.d)) else null }
            AccAct.Tick -> if (s.now < 200) s.copy(now = s.now + 50) else null
            AccAct.OpenCase ->
                if ((who == "pcs" || who == "process-chair") && !s.caseOpen && Accountability.caseMayOpen(f, q20, false, listOfNotNull(s.req))) {
                    s.copy(caseOpen = true)
                } else {
                    null
                }
            AccAct.Uphold -> if (who == "pc-chair" && s.caseOpen && !s.upheld) s.copy(upheld = true) else null
        }
}
