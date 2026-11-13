package pcs.core.rules

import java.time.Duration
import java.time.Instant

/*
 * The discussion rules of spec §5c: each fires with a reason that quotes the numbers. Pure:
 * (snapshot view, phase dates, now, thresholds) -> reasons. Decided papers fire nothing except
 * REVIEW_FLAGGED, which is phase-independent.
 */

public data class Version(val at: Instant, val merit: Int?)

public data class ReviewView(
    val email: String?,
    val isAc: Boolean,
    val complete: Boolean,
    val merit: Int?,
    val expertise: Int?,
    val words: Int,
    val ratings: List<String>,
    val modifiedAt: Instant?,
    /** Known versions, oldest first (snapshots and the history backfill). */
    val versions: List<Version>,
)

public data class CommentView(val email: String?, val at: Instant, val isResponse: Boolean, val byAc: Boolean, val mentions: List<String>)

public data class PaperView(val pid: Long, val decided: Boolean, val reviews: List<ReviewView>, val comments: List<CommentView>)

public data class Thresholds(
    val reviewsRequired: Int = 3,
    val meritAcceptMin: Int = 3,
    val expertiseOkMin: Int = 3,
    val splitRange: Int = 2,
    val unresolvedDays: Long = 5,
    val staleDays: Long = 4,
    val minWords: Int = 150,
    val ratingRaters: Int = 2,
    val deadlineDays: Long = 3,
    val weights: Map<String, Int> = DEFAULT_WEIGHTS,
) {
    public companion object {
        public val DEFAULT_WEIGHTS: Map<String, Int> =
            mapOf(
                "MISSING_REVIEWS" to 3,
                "SPLIT" to 3,
                "UNRESOLVED_SPLIT" to 2,
                "SILENT_DISCUSSION" to 3,
                "GONE_QUIET" to 2,
                "AC_ABSENT" to 2,
                "CHAMPION_MISSING" to 1,
                "LOW_EXPERTISE" to 2,
                "THIN_REVIEWS" to 1,
                "RESPONSE_UNADDRESSED" to 2,
                "REVIEW_FLAGGED" to 4,
                "DEADLINE_NO_CONSENSUS" to 3,
            )
    }
}

public data class Phases(val reviewDue: Instant, val discussionOpen: Instant, val decisionsDue: Instant)

public data class Reason(val rule: String, val weight: Int, val text: String)

public object Discussion {
    private fun days(from: Instant, to: Instant): Long = Duration.between(from, to).toDays()

    public fun reasons(p: PaperView, ph: Phases, now: Instant, t: Thresholds = Thresholds()): List<Reason> {
        val out = mutableListOf<Reason>()

        fun fire(rule: String, text: String) {
            out += Reason(rule, t.weights.getValue(rule), text)
        }
        val reviewers = p.reviews.filter { !it.isAc }
        val complete = reviewers.filter { it.complete }
        val merits = complete.mapNotNull { it.merit }

        // phase-independent
        val flagged = p.reviews.filter { r -> r.ratings.any { it == "disrespectful" || it == "wrong" } }
        if (flagged.isNotEmpty()) fire("REVIEW_FLAGGED", "${flagged.size} review(s) rated disrespectful or wrong")
        if (p.decided) return out

        val inDiscussion = now >= ph.discussionOpen
        if (now > ph.reviewDue && complete.size < t.reviewsRequired) fire("MISSING_REVIEWS", "${complete.size} of ${t.reviewsRequired} reviews complete")

        val split =
            merits.isNotEmpty() &&
                (merits.max() - merits.min() >= t.splitRange || (merits.min() < t.meritAcceptMin && merits.max() >= t.meritAcceptMin))
        if (split) fire("SPLIT", "scores ${merits.sorted().joinToString("/")}")

        val moved =
            reviewers.any { r ->
                r.versions.zipWithNext().any { (a, b) -> b.at >= ph.discussionOpen && a.merit != null && b.merit != null && a.merit != b.merit }
            }
        val discussionDays = days(ph.discussionOpen, now)
        if (split && !moved && inDiscussion && discussionDays > t.unresolvedDays) {
            fire("UNRESOLVED_SPLIT", "scores ${merits.sorted().joinToString("/")}; no movement since discussion opened $discussionDays days ago")
        }

        val discussion = p.comments.filter { !it.isResponse && it.at >= ph.discussionOpen }
        if (inDiscussion && discussion.isEmpty()) fire("SILENT_DISCUSSION", "no comments since discussion opened $discussionDays days ago")

        val last = (p.comments.map { it.at } + p.reviews.mapNotNull { it.modifiedAt }).maxOrNull()
        if (last != null && days(last, now) > t.staleDays) fire("GONE_QUIET", "no activity for ${days(last, now)} days")

        if (inDiscussion && discussion.none { it.byAc }) fire("AC_ABSENT", "no AC comment since discussion opened")

        val top = merits.maxOrNull()
        if (top != null && top >= t.meritAcceptMin) {
            val champions = complete.filter { it.merit == top }.mapNotNull { it.email }.toSet()
            if (p.comments.none { !it.isResponse && it.email in champions }) fire("CHAMPION_MISSING", "no comment from the reviewer(s) who scored $top")
        }

        if (complete.isNotEmpty() && complete.none { (it.expertise ?: 0) >= t.expertiseOkMin }) {
            fire("LOW_EXPERTISE", "no review with expertise ≥ ${t.expertiseOkMin}")
        }

        val thin = complete.filter { r -> r.words < t.minWords || r.ratings.count { it == "short" || it == "vague" } >= t.ratingRaters }
        if (thin.isNotEmpty()) {
            fire("THIN_REVIEWS", thin.joinToString("; ") { r -> "${r.words} words, ${r.ratings.count { it == "short" || it == "vague" }} short/vague ratings" })
        }

        val response = p.comments.filter { it.isResponse }.maxOfOrNull { it.at }
        if (response != null) {
            val reviewerEmails = reviewers.mapNotNull { it.email }.toSet()
            if (p.comments.none { !it.isResponse && it.email in reviewerEmails && it.at > response }) {
                fire("RESPONSE_UNADDRESSED", "author response with no reviewer comment after it")
            }
        }

        val toDeadline = Duration.between(now, ph.decisionsDue)
        if (toDeadline.toHours() < t.deadlineDays * 24 && (split || discussion.isEmpty())) {
            fire("DEADLINE_NO_CONSENSUS", "${toDeadline.toHours()} hours to decisions, no decision, ${if (split) "split" else "silent"}")
        }
        return out
    }
}
