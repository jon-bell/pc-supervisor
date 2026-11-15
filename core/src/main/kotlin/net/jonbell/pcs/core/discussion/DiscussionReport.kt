package net.jonbell.pcs.core.discussion

import net.jonbell.pcs.core.accountability.OutstandingReview
import net.jonbell.pcs.core.accountability.ProgressRow
import net.jonbell.pcs.core.rules.CommentView
import net.jonbell.pcs.core.rules.Discussion
import net.jonbell.pcs.core.rules.DiscussionContext
import net.jonbell.pcs.core.rules.PaperStage
import net.jonbell.pcs.core.rules.PaperView
import net.jonbell.pcs.core.rules.Phases
import net.jonbell.pcs.core.rules.Reason
import net.jonbell.pcs.core.rules.ReviewView
import net.jonbell.pcs.core.rules.Thresholds
import java.time.Duration
import java.time.Instant

/*
 * The discussion dashboard's numbers (spec §5): per-paper reasons and severity from the rules, per-AC and per-reviewer metrics, the
 * person page, the drawer's timeline, and the overview. Pure: everything is a function of the snapshot view, the phase dates, now and
 * the thresholds. It reads who wrote what and when, and scores; it never reads review or comment text, and it never infers
 * anything about reading, because the mirror cannot see reads (spec §7).
 */

/** What the dashboard reads about the conference. [group] maps an email to senior, junior or nominee. */
public data class DiscussionInput(
    val papers: List<PaperView>,
    val names: Map<String, String>,
    val group: (String) -> String,
    /** Reviews assigned and not complete, from the reviewing-progress report (M16): reused, not recomputed. */
    val outstanding: List<OutstandingReview> = emptyList(),
    val progress: List<ProgressRow> = emptyList(),
)

public data class PersonRef(val email: String, val name: String)

public data class PaperRisk(
    val pid: Long,
    val title: String,
    val acs: List<PersonRef>,
    val scores: List<Int>,
    val reasons: List<Reason>,
    val severity: Int,
    val stage: PaperStage,
    val decided: Boolean,
    val lastActivity: Instant?,
    val hoursToDeadline: Long,
    /** The groups (senior, junior, nominee) of the paper's reviewers. */
    val groups: Set<String>,
)

public data class AcRow(
    val ac: PersonRef,
    val papers: Int,
    val flagged: Int,
    /** Papers with a comment from this AC since discussion opened. */
    val covered: Int,
    val medianHoursToFirstPost: Double?,
    /** Comments that @mention a reviewer of the paper, or were posted while a reviewer had no comments yet (a labeled proxy). */
    val nudges: Int,
    val mentionNudges: Int,
    val stale: Int,
    /** The AC's own reviews (rtype 5) by status. */
    val metareviews: Map<String, Int>,
    /** The AC's comments per day over the last 14 days up to now, oldest first. */
    val activity: List<Int>,
) {
    public val coverage: Double? get() = if (papers == 0) null else covered.toDouble() / papers
}

public data class Ping(val pid: Long, val at: Instant, val by: PersonRef, val ageDays: Long)

public data class ReviewerRow(
    val person: PersonRef,
    val group: String,
    val reviews: Int,
    val outstanding: Int,
    val late: Int,
    val medianWords: Int?,
    /** In the bottom decile of reviewers by median review length, and below the PC median. */
    val shortest: Boolean,
    val positiveFlags: Int,
    val negativeFlags: Int,
    /** Distinct papers on which a review of theirs drew a negative flag. */
    val negativePapers: Int,
    val coaching: Boolean,
    val inDiscussion: Int,
    val commented: Int,
    val medianResponseHours: Double?,
    val openPings: List<Ping>,
    val movements: Int,
    val silentOnSplit: List<Long>,
) {
    public val participation: Double? get() = if (inDiscussion == 0) null else commented.toDouble() / inDiscussion

    /** Why this person is on an outlier list, with the numbers. Empty when they are not. */
    public val outlierReasons: List<String>
        get() =
            buildList {
                if (silentOnSplit.isNotEmpty()) add("no comments yet on ${silentOnSplit.size} split paper(s): ${silentOnSplit.joinToString { "#$it" }}")
                if (openPings.isNotEmpty()) add("${openPings.size} @mention(s) without a reply, oldest ${openPings.maxOf { it.ageDays }} days")
                if (late > 0) add("$late review(s) outstanding past the deadline")
                if (shortest) add("reviews in the shortest decile (median $medianWords words)")
                if (coaching) add("negative rating flags on $negativePapers papers")
            }
}

public data class PersonPaper(
    val pid: Long,
    val title: String,
    val merit: Int?,
    val expertise: Int?,
    val split: Boolean,
    val lastComment: Instant?,
    val commentedSinceOpen: Boolean,
    val openPings: List<Ping>,
)

public data class PersonPage(val row: ReviewerRow, val papers: List<PersonPaper>)

public enum class EventKind(public val label: String) {
    REVIEW("review"),
    SCORE("score change"),
    COMMENT("comment"),
    MENTION("mention"),
    RESPONSE("author response"),
}

public data class TimelineEvent(
    val at: Instant,
    /** Whole days from discussion opening; negative before it. */
    val day: Long,
    val kind: EventKind,
    val who: String,
    val detail: String,
    /** The time comes from the history backfill, so it is approximate (H3). */
    val approx: Boolean,
)

public data class BurnPoint(val day: Instant, val withoutConsensus: Int?, val target: Double)

public data class Overview(
    val stages: Map<PaperStage, Int>,
    /** Papers by the spread of their merit scores (max minus min), for papers with two or more scores. */
    val spread: Map<Int, Int>,
    val flaggedPerAc: List<Pair<PersonRef, Int>>,
    val burndown: List<BurnPoint>,
    /** Undecided papers that are split now. */
    val openNoConsensus: Int,
    val progress: List<ProgressRow>,
)

public data class DiscussionReport(
    val papers: List<PaperRisk>,
    val acs: List<AcRow>,
    val reviewers: List<ReviewerRow>,
    val overview: Overview,
    val phases: Phases,
    val thresholds: Thresholds,
    val now: Instant,
    private val input: DiscussionInput,
) {
    public fun paper(pid: Long): PaperRisk? = papers.firstOrNull { it.pid == pid }

    public fun timeline(pid: Long): List<TimelineEvent> = DiscussionReports.timeline(input, phases, thresholds, now, pid)

    public fun person(email: String): PersonPage? = DiscussionReports.person(input, phases, thresholds, now, email.lowercase(), reviewers)

    /** Reviewers with at least one outlier reason, by group, most reasons first. */
    public fun outliers(group: String): List<ReviewerRow> =
        reviewers.filter { it.group == group && it.outlierReasons.isNotEmpty() }
            .sortedWith(compareByDescending<ReviewerRow> { it.outlierReasons.size }.thenByDescending { it.silentOnSplit.size }.thenBy { it.person.email })
}

public object DiscussionReports {
    public const val NEGATIVE: String = "short vague needswork narrow wrong"
    private val negative = NEGATIVE.split(' ').toSet()

    private fun median(xs: List<Double>): Double? =
        if (xs.isEmpty()) {
            null
        } else {
            xs.sorted().let { if (it.size % 2 == 1) it[it.size / 2] else (it[it.size / 2 - 1] + it[it.size / 2]) / 2 }
        }

    private fun hours(a: Instant, b: Instant) = Duration.between(a, b).toMinutes() / 60.0

    private fun ref(input: DiscussionInput, email: String) = PersonRef(email, input.names[email] ?: email)

    /** Reviewers of a paper (not its ACs), with a review row. */
    private fun reviewersOf(p: PaperView) = p.reviews.filter { !it.isAc && it.email != null }

    public fun build(input: DiscussionInput, ph: Phases, now: Instant, t: Thresholds = Thresholds()): DiscussionReport {
        val risks =
            input.papers.map { p ->
                val reasons = Discussion.reasons(p, ph, now, t)
                val c = DiscussionContext(p, ph, now, t)
                PaperRisk(
                    p.pid,
                    p.title,
                    p.reviews.filter { it.isAc && it.email != null }.map { ref(input, it.email!!.lowercase()) },
                    c.merits.sorted(),
                    reasons,
                    Discussion.severity(reasons),
                    Discussion.stage(p, ph, now),
                    p.decided,
                    c.lastActivity,
                    c.toDeadline.toHours(),
                    reviewersOf(p).map { input.group(it.email!!.lowercase()) }.toSet(),
                )
            }
        // severity first, then the time to the decisions deadline, then pid so the order is total
        val sorted = risks.sortedWith(compareByDescending<PaperRisk> { it.severity }.thenBy { it.hoursToDeadline }.thenBy { it.pid })
        val reviewers = reviewerRows(input, ph, t, now)
        val acs = acRows(input, ph, t, now, risks)
        return DiscussionReport(sorted, acs, reviewers, overview(input, ph, t, now, risks, acs), ph, t, now, input)
    }

    // ---- per AC (spec §5b)

    private fun acRows(input: DiscussionInput, ph: Phases, t: Thresholds, now: Instant, risks: List<PaperRisk>): List<AcRow> {
        val byPid = risks.associateBy { it.pid }
        val acPapers = mutableMapOf<String, MutableList<Pair<PaperView, ReviewView>>>()
        for (p in input.papers) for (r in p.reviews) if (r.isAc && r.email != null) acPapers.getOrPut(r.email.lowercase()) { mutableListOf() } += p to r
        val dayMs = Duration.ofDays(1)
        return acPapers.map { (email, ps) ->
            var covered = 0
            var nudges = 0
            var mentionNudges = 0
            var stale = 0
            val firstPosts = mutableListOf<Double>()
            val activity = IntArray(14)
            for ((p, _) in ps) {
                val mine = p.comments.filter { !it.isResponse && it.email?.lowercase() == email && it.at >= ph.discussionOpen }.sortedBy { it.at }
                if (mine.isNotEmpty()) covered++
                val reviewerEmails = reviewersOf(p).map { it.email!!.lowercase() }.toSet()
                val landed = reviewersOf(p).mapNotNull { it.completeAt ?: it.modifiedAt }.maxOrNull()
                val start = listOfNotNull(ph.discussionOpen, landed).max()
                if (now >= ph.discussionOpen) mine.firstOrNull()?.let { firstPosts += maxOf(0.0, hours(start, it.at)) }
                for (c in mine) {
                    val mentions = c.mentions.any { it.lowercase() in reviewerEmails }
                    val spoke = p.comments.filter { !it.isResponse && it.at >= ph.discussionOpen && it.at < c.at }.mapNotNull { it.email?.lowercase() }.toSet()
                    val silent = reviewerEmails.any { it !in spoke }
                    if (mentions) mentionNudges++
                    if (mentions || silent) nudges++
                }
                for (c in p.comments.filter { it.email?.lowercase() == email }) {
                    val idx = 13 - Duration.between(c.at, now).dividedBy(dayMs).toInt().coerceAtLeast(0)
                    if (idx in 0..13 && c.at <= now) activity[idx]++
                }
                val last = byPid[p.pid]?.lastActivity
                if (!p.decided && now >= ph.discussionOpen && last != null && Duration.between(last, now) > Duration.ofDays(t.staleDays)) stale++
            }
            AcRow(
                ref(input, email),
                ps.size,
                ps.count { (p, _) -> byPid[p.pid]?.reasons?.isNotEmpty() == true },
                covered,
                median(firstPosts),
                nudges,
                mentionNudges,
                stale,
                ps.groupingBy { (_, r) -> r.status }.eachCount(),
                activity.toList(),
            )
        }.sortedBy { it.ac.name }
    }

    // ---- per reviewer (spec §5a)

    private data class Own(val p: PaperView, val r: ReviewView)

    private fun pings(p: PaperView, ph: Phases, now: Instant, email: String): List<CommentView> =
        p.comments.filter { !it.isResponse && it.at >= ph.discussionOpen && it.email?.lowercase() != email && email in it.mentions.map(String::lowercase) }

    private fun reviewerRows(input: DiscussionInput, ph: Phases, t: Thresholds, now: Instant): List<ReviewerRow> {
        val own = mutableMapOf<String, MutableList<Own>>()
        for (p in input.papers) for (r in reviewersOf(p)) own.getOrPut(r.email!!.lowercase()) { mutableListOf() } += Own(p, r)
        val medians = own.mapValues { (_, os) -> median(os.filter { it.r.complete }.map { it.r.words.toDouble() })?.toInt() }
        val all = medians.values.filterNotNull().sorted()
        val pcMedian = median(all.map { it.toDouble() })
        val cutoff = if (all.isEmpty()) null else all[(Math.ceil(all.size * 0.1).toInt() - 1).coerceAtLeast(0)]
        val inDisc = now >= ph.discussionOpen
        return own.map { (email, os) ->
            val ratings = os.flatMap { o -> o.r.ratings.map { it to o.p.pid } }
            val negPapers = ratings.filter { it.first in negative }.map { it.second }.toSet()
            val live = if (inDisc) os.filter { !it.p.decided } else emptyList()

            fun commented(o: Own) = o.p.comments.any { !it.isResponse && it.email?.lowercase() == email && it.at >= ph.discussionOpen }
            val responseHours = mutableListOf<Double>()
            val open = mutableListOf<Ping>()
            for (o in os) {
                val mine = o.p.comments.filter { !it.isResponse && it.email?.lowercase() == email }.sortedBy { it.at }
                val triggers =
                    o.p.comments.filter { c ->
                        !c.isResponse && c.at >= ph.discussionOpen && c.email?.lowercase() != email && (c.byAc || email in c.mentions.map(String::lowercase))
                    }
                for (c in triggers) {
                    val reply = mine.firstOrNull { it.at > c.at }
                    if (reply != null) responseHours += hours(c.at, reply.at)
                }
                for (c in pings(o.p, ph, now, email)) {
                    val unanswered = mine.none { it.at > c.at }
                    val age = Duration.between(c.at, now)
                    if (unanswered && age > Duration.ofDays(t.pingDays)) open += Ping(o.p.pid, c.at, ref(input, c.email?.lowercase() ?: ""), age.toDays())
                }
            }
            val silent =
                live.filter { o -> DiscussionContext(o.p, ph, now, t).split && !commented(o) && o.r.complete }.map { it.p.pid }.sorted()
            val moves =
                os.sumOf { o ->
                    o.r.versions.zipWithNext().count { (a, b) ->
                        b.at >= ph.discussionOpen &&
                            (
                                (a.merit != b.merit && a.merit != null && b.merit != null) ||
                                    (a.expertise != b.expertise && a.expertise != null && b.expertise != null)
                            )
                    }
                }
            val outstanding = input.outstanding.filter { it.email.lowercase() == email }
            ReviewerRow(
                ref(input, email),
                input.group(email),
                os.size,
                outstanding.size,
                outstanding.count { it.lateDays != null },
                medians[email],
                medians[email]?.let { m -> cutoff != null && pcMedian != null && m <= cutoff && m < pcMedian } == true,
                ratings.count { it.first == "good" },
                ratings.count { it.first in negative },
                negPapers.size,
                negPapers.size >= t.coachPapers,
                live.size,
                live.count(::commented),
                median(responseHours),
                open.sortedBy { it.at },
                moves,
                silent,
            )
        }.sortedBy { it.person.name }
    }

    public fun person(input: DiscussionInput, ph: Phases, t: Thresholds, now: Instant, email: String, rows: List<ReviewerRow>): PersonPage? {
        val row = rows.firstOrNull { it.person.email == email } ?: return null
        val papers =
            input.papers.mapNotNull { p ->
                val r = reviewersOf(p).firstOrNull { it.email!!.lowercase() == email } ?: return@mapNotNull null
                val mine = p.comments.filter { !it.isResponse && it.email?.lowercase() == email }
                val ping = pings(p, ph, now, email).filter { c -> mine.none { it.at > c.at } && Duration.between(c.at, now) > Duration.ofDays(t.pingDays) }
                PersonPaper(
                    p.pid,
                    p.title,
                    r.merit,
                    r.expertise,
                    DiscussionContext(p, ph, now, t).split,
                    mine.maxOfOrNull { it.at },
                    mine.any { it.at >= ph.discussionOpen },
                    ping.map { Ping(p.pid, it.at, ref(input, it.email?.lowercase() ?: ""), Duration.between(it.at, now).toDays()) },
                )
            }.sortedBy { it.pid }
        return PersonPage(row, papers)
    }

    // ---- the drawer's timeline

    public fun timeline(input: DiscussionInput, ph: Phases, t: Thresholds, now: Instant, pid: Long): List<TimelineEvent> {
        val p = input.papers.firstOrNull { it.pid == pid } ?: return emptyList()

        fun day(at: Instant) = Math.floorDiv(Duration.between(ph.discussionOpen, at).toMinutes(), 24 * 60L)

        fun name(e: String?) = e?.let { input.names[it.lowercase()] ?: it } ?: "unknown"
        val out = mutableListOf<TimelineEvent>()
        for (r in p.reviews.filter { !it.isAc }) {
            val label = "review ${r.ordinal ?: ""}".trim()
            (r.completeAt ?: r.modifiedAt)?.takeIf { r.complete }?.let {
                out +=
                    TimelineEvent(
                        it,
                        day(it),
                        EventKind.REVIEW,
                        name(r.email),
                        "$label submitted: merit ${r.merit ?: "?"}, expertise ${r.expertise ?: "?"}, ${r.words} words",
                        false,
                    )
            }
            for ((a, b) in r.versions.zipWithNext()) {
                if (a.merit != b.merit && a.merit != null && b.merit != null) {
                    out +=
                        TimelineEvent(b.at, day(b.at), EventKind.SCORE, name(r.email), "$label merit ${a.merit} → ${b.merit}", b.approx)
                }
                if (a.expertise != b.expertise && a.expertise != null && b.expertise != null) {
                    out += TimelineEvent(b.at, day(b.at), EventKind.SCORE, name(r.email), "$label expertise ${a.expertise} → ${b.expertise}", b.approx)
                }
            }
        }
        for (c in p.comments) {
            val who = name(c.email)
            if (c.isResponse) {
                out += TimelineEvent(c.at, day(c.at), EventKind.RESPONSE, who, "author response, ${c.words} words", false)
                continue
            }
            out += TimelineEvent(c.at, day(c.at), EventKind.COMMENT, who, "${if (c.byAc) "AC comment" else "comment"}, ${c.words} words", false)
            for (m in c.mentions) {
                val replied = p.comments.any { !it.isResponse && it.email?.lowercase() == m.lowercase() && it.at > c.at }
                val state = if (replied) "replied later" else "no reply yet (${Duration.between(c.at, now).toDays()} days)"
                out += TimelineEvent(c.at, day(c.at), EventKind.MENTION, who, "@mentions ${name(m)}: $state", false)
            }
        }
        return out.sortedWith(compareBy({ it.at }, { it.kind.ordinal }))
    }

    // ---- the overview

    private fun overview(input: DiscussionInput, ph: Phases, t: Thresholds, now: Instant, risks: List<PaperRisk>, acs: List<AcRow>): Overview {
        val stages = PaperStage.entries.associateWith { s -> risks.count { it.stage == s } }
        val spread = risks.filter { it.scores.size >= 2 }.groupingBy { it.scores.max() - it.scores.min() }.eachCount().toSortedMap()
        val open = input.papers.count { p -> !p.decided && DiscussionContext(p, ph, now, t).split }
        return Overview(stages, spread, acs.map { it.ac to it.flagged }, burndown(input, ph, t, now), open, input.progress)
    }

    /** Merits of the paper's reviewers at [at]: each review counts from when it landed, with the score of its last version up to [at]. */
    private fun meritsAt(p: PaperView, at: Instant): List<Int> =
        reviewersOf(p).mapNotNull { r ->
            val landed = r.completeAt ?: r.modifiedAt
            if (!r.complete || (landed != null && landed > at)) {
                null
            } else {
                r.versions.lastOrNull { it.at <= at }?.merit ?: r.versions.firstOrNull()?.merit ?: r.merit
            }
        }

    /**
     * Papers without consensus (split scores, the rule of SPLIT) at each day from discussion opening to the decisions deadline,
     * from each review's version history; the line stops at now. The target falls in a straight line from the count at opening to 0 at
     * the deadline. HotCRP records no time for a decision, so a decided paper counts by its scores like any other.
     */
    public fun burndown(input: DiscussionInput, ph: Phases, t: Thresholds, now: Instant): List<BurnPoint> {
        if (!ph.decisionsDue.isAfter(ph.discussionOpen)) return emptyList()

        fun splitAt(at: Instant) =
            input.papers.count { p ->
                val m = meritsAt(p, at)
                m.isNotEmpty() && (m.max() - m.min() >= t.splitRange || (m.min() < t.meritAcceptMin && m.max() >= t.meritAcceptMin))
            }
        val start = splitAt(ph.discussionOpen)
        val total = Duration.between(ph.discussionOpen, ph.decisionsDue).toMinutes().toDouble()
        val points = mutableListOf<BurnPoint>()
        val days = generateSequence(ph.discussionOpen) { it.plus(Duration.ofDays(1)) }.takeWhile { it < ph.decisionsDue }.toList() + ph.decisionsDue
        for (d in days) {
            val frac = Duration.between(ph.discussionOpen, d).toMinutes() / total
            points += BurnPoint(d, if (d <= now) splitAt(d) else null, start * (1 - frac))
        }
        return points
    }
}
