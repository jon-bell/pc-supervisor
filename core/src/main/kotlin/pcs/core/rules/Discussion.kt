package pcs.core.rules

import java.time.Duration
import java.time.Instant

/*
 * The discussion rules of spec §5c: each is its own function, with a weight and a threshold setting, and fires with a reason
 * that quotes the numbers. Pure: (snapshot view, phase dates, now, thresholds) -> reasons. Decided papers fire nothing except
 * REVIEW_FLAGGED, which is phase-independent. The rules read metadata and scores, never review text.
 */

/** One known version of a review (a snapshot or a history-backfill row). [approx] times come from the backfill, not from a sync that saw it happen (H3). */
public data class Version(val at: Instant, val merit: Int?, val expertise: Int? = null, val approx: Boolean = false)

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
    val ordinal: String? = null,
    val status: String = if (complete) "complete" else "not started",
    /** When a sync first saw the review complete, or its last modification if that is all the mirror has. */
    val completeAt: Instant? = null,
)

public data class CommentView(
    val email: String?,
    val at: Instant,
    val isResponse: Boolean,
    val byAc: Boolean,
    val mentions: List<String>,
    val words: Int = 0,
    val cid: Long = 0,
)

public data class PaperView(
    val pid: Long,
    val decided: Boolean,
    val reviews: List<ReviewView>,
    val comments: List<CommentView>,
    val title: String = "",
)

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
    /** Unanswered pings older than this are listed (`PCS_THRESH_PING_DAYS`, spec §5a). */
    val pingDays: Long = 3,
    /** A reviewer whose negative flags come from at least this many papers is a coaching case (`PCS_THRESH_COACH_PAPERS`, spec §5a). */
    val coachPapers: Int = 2,
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

        /** The threshold settings this module reads, by `PCS_THRESH_<key>`. */
        public val THRESHOLD_KEYS: Set<String> =
            setOf("SPLIT_RANGE", "UNRESOLVED_DAYS", "STALE_DAYS", "MIN_WORDS", "RATING_RATERS", "DEADLINE_DAYS", "PING_DAYS", "COACH_PAPERS")

        /**
         * Thresholds from the settings: the three scale values come from their own settings, `PCS_THRESH_<key>` sets a threshold and
         * `PCS_RULE_<NAME>_WEIGHT` a weight. Every problem is returned, so a chair fixes the file in one pass; the thresholds are
         * still usable (the bad value is skipped).
         */
        public fun fromSettings(
            raw: Map<String, String>,
            meritAcceptMin: Int,
            expertiseOkMin: Int,
            reviewsRequired: Int,
        ): Pair<Thresholds, List<String>> {
            val problems = mutableListOf<String>()

            fun num(key: String, min: Long): Long? =
                raw[key]?.let { v ->
                    v.toLongOrNull()?.takeIf { it >= min } ?: null.also { problems += "$key: not an integer ≥ $min: $v" }
                }
            val weights = DEFAULT_WEIGHTS.toMutableMap()
            for ((k, v) in raw) {
                val m = Regex("PCS_RULE_([A-Z_]+)_WEIGHT").matchEntire(k) ?: continue
                val name = m.groupValues[1]
                when {
                    name !in DEFAULT_WEIGHTS -> problems += "$k: no such discussion rule (${DEFAULT_WEIGHTS.keys.joinToString()})"
                    v.toIntOrNull()?.takeIf { it >= 0 } == null -> problems += "$k: not an integer ≥ 0: $v"
                    else -> weights[name] = v.toInt()
                }
            }
            for (k in raw.keys) {
                val key = k.removePrefix("PCS_THRESH_")
                if (k.startsWith("PCS_THRESH_") && key !in THRESHOLD_KEYS) problems += "$k: no such threshold (${THRESHOLD_KEYS.joinToString()})"
            }
            val d = Thresholds()
            val t =
                Thresholds(
                    reviewsRequired = reviewsRequired,
                    meritAcceptMin = meritAcceptMin,
                    expertiseOkMin = expertiseOkMin,
                    splitRange = num("PCS_THRESH_SPLIT_RANGE", 1)?.toInt() ?: d.splitRange,
                    unresolvedDays = num("PCS_THRESH_UNRESOLVED_DAYS", 0) ?: d.unresolvedDays,
                    staleDays = num("PCS_THRESH_STALE_DAYS", 0) ?: d.staleDays,
                    minWords = num("PCS_THRESH_MIN_WORDS", 0)?.toInt() ?: d.minWords,
                    ratingRaters = num("PCS_THRESH_RATING_RATERS", 1)?.toInt() ?: d.ratingRaters,
                    deadlineDays = num("PCS_THRESH_DEADLINE_DAYS", 0) ?: d.deadlineDays,
                    pingDays = num("PCS_THRESH_PING_DAYS", 0) ?: d.pingDays,
                    coachPapers = num("PCS_THRESH_COACH_PAPERS", 1)?.toInt() ?: d.coachPapers,
                    weights = weights,
                )
            return t to problems
        }
    }
}

public data class Phases(val reviewDue: Instant, val discussionOpen: Instant, val decisionsDue: Instant)

public data class Reason(val rule: String, val weight: Int, val text: String)

/** Where a paper is in the process, for the overview's counts by phase. */
public enum class PaperStage(public val label: String) {
    AWAITING_REVIEWS("awaiting reviews"),
    BETWEEN("reviews due, discussion not open"),
    IN_DISCUSSION("in discussion"),
    DECIDED("decided"),
}

/*
 * Phases: MISSING_REVIEWS needs REVIEW_DUE to have passed; the rules about what people say (UNRESOLVED_SPLIT, SILENT_DISCUSSION,
 * GONE_QUIET, AC_ABSENT, CHAMPION_MISSING, RESPONSE_UNADDRESSED, and the silent branch of DEADLINE_NO_CONSENSUS) need DISCUSSION_OPEN,
 * because nobody is expected to comment before it. SPLIT, LOW_EXPERTISE, THIN_REVIEWS and REVIEW_FLAGGED read the reviews and fire
 * in any phase; REVIEW_FLAGGED also on a decided paper.
 */

/** The facts every rule reads, computed once per paper. */
public class DiscussionContext(public val p: PaperView, public val ph: Phases, public val now: Instant, public val t: Thresholds) {
    public val reviewers: List<ReviewView> = p.reviews.filter { !it.isAc }
    public val complete: List<ReviewView> = reviewers.filter { it.complete }
    public val merits: List<Int> = complete.mapNotNull { it.merit }
    public val inDiscussion: Boolean = now >= ph.discussionOpen
    public val discussionDays: Long = Duration.between(ph.discussionOpen, now).toDays()

    /** Scores on both sides of the accept line, or a merit range of at least `splitRange`. */
    public val split: Boolean =
        merits.isNotEmpty() &&
            (merits.max() - merits.min() >= t.splitRange || (merits.min() < t.meritAcceptMin && merits.max() >= t.meritAcceptMin))

    /** A reviewer changed their merit score after discussion opened. */
    public val moved: Boolean =
        reviewers.any { r ->
            r.versions.zipWithNext().any { (a, b) -> b.at >= ph.discussionOpen && a.merit != null && b.merit != null && a.merit != b.merit }
        }

    /** Non-response comments since discussion opened. */
    public val discussion: List<CommentView> = p.comments.filter { !it.isResponse && it.at >= ph.discussionOpen }
    public val lastActivity: Instant? = (p.comments.map { it.at } + p.reviews.mapNotNull { it.modifiedAt }).maxOrNull()
    public val toDeadline: Duration = Duration.between(now, ph.decisionsDue)

    /** True when [since] is strictly more than [days] days before now. */
    public fun olderThan(since: Instant, days: Long): Boolean = Duration.between(since, now) > Duration.ofDays(days)

    public fun scores(): String = merits.sorted().joinToString("/")
}

public object Discussion {
    /** One rule: a name, and a function that returns the reason text when it fires. The weight comes from the thresholds. */
    public class Rule(public val name: String, public val check: (DiscussionContext) -> String?)

    public fun reviewFlagged(c: DiscussionContext): String? {
        val flagged = c.p.reviews.filter { r -> r.ratings.any { it == "disrespectful" || it == "wrong" } }
        return if (flagged.isEmpty()) null else "${flagged.size} review(s) rated disrespectful or wrong"
    }

    public fun missingReviews(c: DiscussionContext): String? =
        if (c.now > c.ph.reviewDue && c.complete.size < c.t.reviewsRequired) "${c.complete.size} of ${c.t.reviewsRequired} reviews complete" else null

    public fun split(c: DiscussionContext): String? = if (c.split) "scores ${c.scores()}" else null

    public fun unresolvedSplit(c: DiscussionContext): String? =
        if (c.split && !c.moved && c.inDiscussion && c.olderThan(c.ph.discussionOpen, c.t.unresolvedDays)) {
            "scores ${c.scores()}; no movement since discussion opened ${c.discussionDays} days ago"
        } else {
            null
        }

    public fun silentDiscussion(c: DiscussionContext): String? =
        if (c.inDiscussion && c.discussion.isEmpty()) "no comments since discussion opened ${c.discussionDays} days ago" else null

    public fun goneQuiet(c: DiscussionContext): String? {
        if (!c.inDiscussion) return null
        val last = c.lastActivity ?: return null
        return if (c.olderThan(last, c.t.staleDays)) "no activity for ${Duration.between(last, c.now).toDays()} days (threshold ${c.t.staleDays})" else null
    }

    public fun acNoComment(c: DiscussionContext): String? =
        if (c.inDiscussion && c.discussion.none { it.byAc }) "no AC comment since discussion opened ${c.discussionDays} days ago" else null

    public fun championMissing(c: DiscussionContext): String? {
        if (!c.inDiscussion) return null
        val top = c.merits.maxOrNull() ?: return null
        if (top < c.t.meritAcceptMin) return null
        val champions = c.complete.filter { it.merit == top }.mapNotNull { it.email?.lowercase() }.toSet()
        return if (c.p.comments.none { !it.isResponse && it.email?.lowercase() in champions }) "no comment from the reviewer(s) who scored $top" else null
    }

    public fun lowExpertise(c: DiscussionContext): String? =
        if (c.complete.isNotEmpty() && c.complete.none { (it.expertise ?: 0) >= c.t.expertiseOkMin }) {
            "no review with expertise ≥ ${c.t.expertiseOkMin} (best ${c.complete.maxOf { it.expertise ?: 0 }})"
        } else {
            null
        }

    public fun thinReviews(c: DiscussionContext): String? {
        fun shortVague(r: ReviewView) = r.ratings.count { it == "short" || it == "vague" }
        val thin = c.complete.filter { r -> r.words < c.t.minWords || shortVague(r) >= c.t.ratingRaters }
        return if (thin.isEmpty()) {
            null
        } else {
            thin.joinToString("; ") { r ->
                "review ${r.ordinal ?: ""}".trim() + ": ${r.words} words (floor ${c.t.minWords}), ${shortVague(r)}× short/vague (needs ${c.t.ratingRaters})"
            }
        }
    }

    public fun responseUnaddressed(c: DiscussionContext): String? {
        if (!c.inDiscussion) return null
        val response = c.p.comments.filter { it.isResponse }.maxOfOrNull { it.at } ?: return null
        val emails = c.reviewers.mapNotNull { it.email?.lowercase() }.toSet()
        return if (c.p.comments.none { !it.isResponse && it.email?.lowercase() in emails && it.at > response }) {
            "author response ${Duration.between(response, c.now).toDays()} days ago with no reviewer comment after it"
        } else {
            null
        }
    }

    public fun deadlineNoConsensus(c: DiscussionContext): String? {
        val hours = c.toDeadline.toHours()
        return if (hours < c.t.deadlineDays * 24 && (c.split || (c.inDiscussion && c.discussion.isEmpty()))) {
            "$hours hours to decisions (window ${c.t.deadlineDays} days), no decision, ${if (c.split) "split" else "silent"}"
        } else {
            null
        }
    }

    /** In the order of spec §5c; REVIEW_FLAGGED runs for decided papers too. */
    public val RULES: List<Rule> =
        listOf(
            Rule("MISSING_REVIEWS", ::missingReviews),
            Rule("SPLIT", ::split),
            Rule("UNRESOLVED_SPLIT", ::unresolvedSplit),
            Rule("SILENT_DISCUSSION", ::silentDiscussion),
            Rule("GONE_QUIET", ::goneQuiet),
            Rule("AC_ABSENT", ::acNoComment),
            Rule("CHAMPION_MISSING", ::championMissing),
            Rule("LOW_EXPERTISE", ::lowExpertise),
            Rule("THIN_REVIEWS", ::thinReviews),
            Rule("RESPONSE_UNADDRESSED", ::responseUnaddressed),
            Rule("REVIEW_FLAGGED", ::reviewFlagged),
            Rule("DEADLINE_NO_CONSENSUS", ::deadlineNoConsensus),
        )

    public fun reasons(p: PaperView, ph: Phases, now: Instant, t: Thresholds = Thresholds()): List<Reason> {
        val c = DiscussionContext(p, ph, now, t)
        return RULES.filter { !p.decided || it.name == "REVIEW_FLAGGED" }.mapNotNull { r ->
            r.check(c)?.let { Reason(r.name, t.weights.getValue(r.name), it) }
        }
    }

    public fun severity(reasons: List<Reason>): Int = reasons.sumOf { it.weight }

    public fun stage(p: PaperView, ph: Phases, now: Instant): PaperStage =
        when {
            p.decided -> PaperStage.DECIDED
            now >= ph.discussionOpen -> PaperStage.IN_DISCUSSION
            now > ph.reviewDue -> PaperStage.BETWEEN
            else -> PaperStage.AWAITING_REVIEWS
        }
}
