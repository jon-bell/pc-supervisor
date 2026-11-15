package pcs.core.earlyreject

import pcs.core.phases.Window
import pcs.core.readings.Q15
import pcs.core.readings.Q16
import pcs.core.rules.Conventions
import pcs.core.rules.ERCase
import pcs.core.rules.EarlyReject
import pcs.core.rules.Faults
import pcs.core.rules.Score
import pcs.core.rules.ScoreScale
import pcs.core.rules.Trace
import pcs.core.store.Store
import java.time.Duration
import java.time.Instant

/*
 * Early reject (concepts §3.6, spec §10.4 E): the candidates under Q15, computed from the mirror's
 * snapshot at the window's opening, and the Q16 bump window computed from the review versions the
 * mirror recorded after it. The decision whether a candidate may be rejected is the model's
 * (`EarlyReject.mayEarlyReject`); this file only supplies its inputs from the store.
 */

/** The last-word window: it opens at [open]; [close] is null when Q16 gives reviewers no last word. */
public data class ErWindow(val open: Instant, val close: Instant?) {
    public fun closedAt(now: Instant): Boolean = close != null && !now.isBefore(close)

    public companion object {
        /**
         * From the phase dates (`PCS_PHASE_EARLYREJECT_OPEN`, and `_CLOSE` when set, else open + [windowHours]).
         * Null if the window has no opening date.
         */
        public fun of(phases: Map<String, Instant>, q16: Q16, windowHours: Int): ErWindow? {
            val open = phases[Window.EARLY_REJECT.open] ?: return null
            val close =
                when (q16) {
                    Q16.NO_WINDOW -> null
                    Q16.BUMP_WINDOW -> phases[Window.EARLY_REJECT.close] ?: open.plus(Duration.ofHours(windowHours.toLong()))
                }
            return ErWindow(open, close)
        }
    }
}

/** What the plan needs from the configuration and the answers (Q15, Q16). */
public data class ErConfig(
    val q15: Q15,
    val q16: Q16,
    val scale: ScoreScale = ScoreScale.HOTCRP_DEFAULT,
    val meritField: String = "OveMer",
    /** Initial reviews a paper needs before it is considered (`PCS_REVIEWS_REQUIRED`). */
    val reviewsRequired: Int = 3,
)

/** One initial review of a candidate, with what the window did to it. */
public data class ErReviewer(
    val email: String,
    val initial: Score,
    /** The score now (at the plan's instant), or null if the merit value isn't on the scale. */
    val current: Score?,
    /** The reviewer changed the score within the window. */
    val bumped: Boolean,
    /** The reviewer changed the score or commented on the paper within the window. */
    val responded: Boolean,
)

public enum class ErStatus(public val label: String) {
    /** The window is still open and nobody has bumped. */
    WAITING("window open"),

    /** A reviewer changed a score within the window: not a candidate any more (E-1). */
    BUMPED("bumped"),

    /** The paper's AC objects (E-1). */
    OBJECTED("AC objects"),

    /** Every rule is met: a chair may confirm. */
    READY("ready to confirm"),
}

public data class ErCandidate(
    val pid: Long,
    val title: String,
    val reviewers: List<ErReviewer>,
    val acObjects: Boolean,
    val status: ErStatus,
) {
    public val bumpedBy: List<String> get() = reviewers.filter { it.bumped }.map { it.email }
    public val neverResponded: List<String> get() = reviewers.filter { !it.responded }.map { it.email }
    public val initialScores: List<Score> get() = reviewers.map { it.initial }.sortedBy { it.rank }
}

/** The plan at one instant: every candidate with its status, and the lists the chair reads at close (spec §10.4 E). */
public data class ErReport(val window: ErWindow, val now: Instant, val candidates: List<ErCandidate>) {
    public val windowClosed: Boolean get() = window.closedAt(now)
    public val ready: List<ErCandidate> get() = candidates.filter { it.status == ErStatus.READY }
    public val bumped: List<ErCandidate> get() = candidates.filter { it.status == ErStatus.BUMPED }
    public val notBumped: List<ErCandidate> get() = candidates.filter { it.status != ErStatus.BUMPED }
    public val objected: List<ErCandidate> get() = candidates.filter { it.status == ErStatus.OBJECTED }

    /** Reviewers of a candidate who neither changed a score nor commented in the window. */
    public val neverResponded: List<Pair<Long, String>> get() = candidates.flatMap { c -> c.neverResponded.map { c.pid to it } }
}

/**
 * The window has opened but the mirror holds no review snapshot at or before the opening, so the initial scores can't be
 * read: [reviewsToBackfill] reviews have not had their `/reviewhistory` read yet (zero means the history was read and no review
 * existed at the opening).
 */
public data class SnapshotGap(val reviews: Int, val reviewsToBackfill: Int)

public object EarlyRejectPlan {
    /** The gap at [now], or null when the window hasn't opened, nothing has been reviewed, or a snapshot at or before the opening exists. */
    public fun snapshotGap(store: Store, window: ErWindow, now: Instant): SnapshotGap? {
        if (now.isBefore(window.open)) return null
        fun count(sql: String, vararg args: Long): Int =
            store.conn.prepareStatement(sql).use { st ->
                args.forEachIndexed { i, a -> st.setLong(i + 1, a) }
                st.executeQuery().use {
                    it.next()
                    it.getInt(1)
                }
            }
        val reviews = count("SELECT count(*) FROM review WHERE gone_at IS NULL AND rtype <> 5 AND status <> 'empty'")
        if (reviews == 0) return null
        val before =
            count(
                "SELECT count(*) FROM review_version v JOIN review r ON r.rid = v.rid WHERE r.gone_at IS NULL AND r.rtype <> 5 AND v.seen_at <= ?",
                window.open.epochSecond,
            )
        if (before > 0) return null
        val todo =
            count(
                "SELECT count(*) FROM review r LEFT JOIN backfill b ON b.rid = r.rid WHERE b.rid IS NULL AND r.gone_at IS NULL AND r.status <> 'empty'",
            )
        return SnapshotGap(reviews, todo)
    }

    private class Version(val at: Long, val merit: Int?, val complete: Boolean)

    private class ReviewHistory(val pid: Long, val email: String, val versions: MutableList<Version> = mutableListOf())

    private fun histories(store: Store, meritField: String): List<ReviewHistory> {
        val sql =
            """
            SELECT r.pid, r.rid, r.email, v.seen_at, CAST(json_extract(v.scores, '$.' || ?) AS INTEGER), v.status
            FROM review r JOIN review_version v ON v.rid = r.rid JOIN paper p ON p.pid = r.pid
            WHERE r.gone_at IS NULL AND r.rtype <> 5 AND r.email IS NOT NULL AND p.gone_at IS NULL
            ORDER BY r.pid, r.rid, v.seen_at
            """.trimIndent()
        val out = linkedMapOf<Long, ReviewHistory>()
        store.conn.prepareStatement(sql).use { st ->
            st.setString(1, meritField)
            st.executeQuery().use { rs ->
                while (rs.next()) {
                    val h = out.getOrPut(rs.getLong(2)) { ReviewHistory(rs.getLong(1), rs.getString(3)) }
                    h.versions += Version(rs.getLong(4), rs.getObject(5)?.toString()?.toIntOrNull(), rs.getString(6) == "complete")
                }
            }
        }
        return out.values.toList()
    }

    private fun papers(store: Store, includeDecided: Boolean = false): Map<Long, Pair<String, List<String>>> =
        buildMap {
            store.conn.createStatement().use { st ->
                st.executeQuery("SELECT pid, coalesce(title, ''), decision, tags FROM paper WHERE gone_at IS NULL").use { rs ->
                    while (rs.next()) {
                        val decision = rs.getString(3)
                        // a paper that has a decision is not a candidate (HotCRP reports "" or "Unspecified" for none)
                        if (!includeDecided &&
                            decision != null &&
                            decision.isNotBlank() &&
                            !decision.equals("Unspecified", true) &&
                            !decision.equals("None", true)
                        ) {
                            continue
                        }
                        val tags = kotlinx.serialization.json.Json.parseToJsonElement(rs.getString(4)).let { it as kotlinx.serialization.json.JsonArray }
                        put(rs.getLong(1), rs.getString(2) to tags.map { (it as kotlinx.serialization.json.JsonPrimitive).content })
                    }
                }
            }
        }

    /** Who commented on which paper within (open, end): a reviewer's reply counts as a response. */
    private fun commenters(store: Store, open: Instant, end: Instant): Set<Pair<Long, String>> =
        buildSet {
            store.conn.prepareStatement(
                "SELECT pid, email FROM comment WHERE deleted_seen_at IS NULL AND draft = 0 AND email IS NOT NULL AND modified_at > ? AND modified_at < ?",
            ).use { st ->
                st.setLong(1, open.epochSecond)
                st.setLong(2, end.epochSecond)
                st.executeQuery().use { rs -> while (rs.next()) add(rs.getLong(1) to rs.getString(2)) }
            }
        }

    /** Whether a version seen at [at] belongs to the window: after the opening, by [now], and before the close (a deadline: at it, the window has ended). */
    private fun inWindow(window: ErWindow, now: Instant, at: Long): Boolean =
        at > window.open.epochSecond && at <= now.epochSecond && (window.close == null || at < window.close.epochSecond)

    /** A change within the window: any version in it whose merit differs from the one before. */
    private fun changedIn(h: ReviewHistory, window: ErWindow, now: Instant): Boolean {
        val open = window.open.epochSecond
        var prev = h.versions.lastOrNull { it.at <= open }?.merit
        var changed = false
        for (v in h.versions) {
            if (!inWindow(window, now, v.at)) continue
            if (v.merit != prev) changed = true
            prev = v.merit
        }
        return changed
    }

    /** The scores of paper [pid]'s complete reviews in the snapshot at [at] (each review's latest version seen by then), ascending. Merit values off the scale are left out. */
    public fun scoresAt(store: Store, cfg: ErConfig, pid: Long, at: Instant): List<Score> =
        histories(store, cfg.meritField).filter { it.pid == pid }.mapNotNull { h ->
            h.versions.lastOrNull { it.at <= at.epochSecond }?.takeIf { it.complete }?.let { cfg.scale.of(it.merit) }
        }.sortedBy { it.rank }

    /** Whether paper [pid]'s AC objects (the chair recorded `pcs-er-object`). */
    public fun objects(store: Store, pid: Long): Boolean = papers(store, includeDecided = true)[pid]?.second?.let(::objection) ?: false

    private fun objection(tags: List<String>): Boolean = tags.any { Conventions.decode(0, listOf(it)).any { t -> t is Trace.EarlyObjection } }

    /** The reviewers of paper [pid] (complete at the opening) who changed a score within the window by [now]. */
    public fun bumpedBy(store: Store, cfg: ErConfig, window: ErWindow, now: Instant, pid: Long): Set<String> =
        histories(store, cfg.meritField).filter { it.pid == pid }
            .filter { h -> h.versions.lastOrNull { it.at <= window.open.epochSecond }?.complete == true && changedIn(h, window, now) }
            .map { it.email }.toSet()

    /**
     * The candidates and their status at [now]. A paper is a candidate if, in the snapshot at the window's
     * opening (the latest review versions seen at or before it), it has [ErConfig.reviewsRequired] or more
     * complete reviews and all are negative under Q15. A reviewer bumps if a version seen after the opening
     * and before the window's end has a different merit value from the version before it.
     */
    public fun compute(store: Store, cfg: ErConfig, window: ErWindow, now: Instant, faults: Faults = Faults.NONE): ErReport {
        val open = window.open.epochSecond
        val end = minOf(now, window.close ?: now)
        val papers = papers(store)
        val byPaper = histories(store, cfg.meritField).filter { it.pid in papers }.groupBy { it.pid }
        val commenters = commenters(store, window.open, end)
        val out = mutableListOf<ErCandidate>()
        for ((pid, hs) in byPaper.toSortedMap()) {
            // the snapshot at the opening: each review's latest version at or before it
            val atOpen =
                hs.mapNotNull { h ->
                    val v = h.versions.lastOrNull { it.at <= open } ?: return@mapNotNull null
                    if (!v.complete) null else h to v
                }
            if (atOpen.size < cfg.reviewsRequired) continue
            val initial = atOpen.map { (_, v) -> cfg.scale.of(v.merit) }
            if (initial.any { it == null || !EarlyReject.negative(cfg.q15, it) }) continue
            val reviewers =
                atOpen.mapIndexed { i, (h, v) ->
                    val changed = changedIn(h, window, now)
                    ErReviewer(
                        h.email,
                        initial[i]!!,
                        cfg.scale.of(h.versions.lastOrNull { it.at <= now.epochSecond }?.merit),
                        changed,
                        changed || (pid to h.email) in commenters,
                    )
                }.sortedBy { it.email }
            val objects = objection(papers.getValue(pid).second)
            val bumped = reviewers.any { it.bumped }
            val closed = window.closedAt(now)
            val ready =
                EarlyReject.mayEarlyReject(faults, cfg.q15, cfg.q16, ERCase(reviewers.map { it.initial }, bumped, closed, objects))
            val status =
                when {
                    ready -> ErStatus.READY
                    objects -> ErStatus.OBJECTED
                    bumped -> ErStatus.BUMPED
                    else -> ErStatus.WAITING
                }
            out += ErCandidate(pid, papers.getValue(pid).first, reviewers, objects, status)
        }
        return ErReport(window, now, out)
    }
}
