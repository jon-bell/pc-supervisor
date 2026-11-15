package net.jonbell.pcs.core.triage

import net.jonbell.pcs.core.readings.Q4
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.exec
import net.jonbell.pcs.core.store.query
import net.jonbell.pcs.core.time.Clock

/** The three answers of the Q4 form. */
public enum class YesNo(public val key: String) {
    YES("yes"),
    NO("no"),
    UNSURE("unsure"),
    ;

    public companion object {
        public fun of(k: String): YesNo = entries.firstOrNull { it.key == k } ?: throw IllegalArgumentException("not yes, no or unsure: $k")
    }
}

/** One reviewer's answers about the triage of one paper (concepts TriageFeedback): was the flag right, was anything missed, would they have referred it. */
public data class FeedbackAnswer(
    val pid: Long,
    val reviewer: String,
    val flagRight: YesNo,
    val missed: YesNo,
    val wouldRefer: YesNo,
    val note: String? = null,
)

/** A reviewer who may be shown a paper's screening record and has not been asked, or has not answered. */
public data class FeedbackOwed(val pid: Long, val reviewer: String, val answered: Boolean)

/**
 * TriageFeedback under Q4 (spec §10.4 B, S12). Under "after their own review" a reviewer sees a paper's screening record once their
 * own review of it is submitted, and is asked for feedback. The answers are collected for the evaluation of the screening (agent.md §8)
 * and are never an input to the plan, to a paper's status, or to a notice: [TriagePlan] does not read this table.
 */
public object TriageFeedback {
    /** S12's reveal rule. A submitted review is the condition under "after their own review"; the other two readings ignore it. */
    public fun mayReveal(q4: Q4, ownReviewSubmitted: Boolean): Boolean =
        when (q4) {
            Q4.NEVER -> false
            Q4.AFTER_OWN_REVIEW -> ownReviewSubmitted
            Q4.ALWAYS -> true
        }

    /** The reviewers owed the form (Q4 = after their own review): a complete normal-round review on a paper that has a screening record. */
    public fun owed(store: Store, q4: Q4, rows: List<TriageRow>): List<FeedbackOwed> {
        if (q4 != Q4.AFTER_OWN_REVIEW) return emptyList()
        val recorded = rows.filter { it.status != TriageStatus.REMOVED && (it.flagged || it.facts?.choice != null) }.map { it.pid }.toSet()
        val answered = answers(store).map { it.pid to it.reviewer.lowercase() }.toSet()
        return store.conn.query(
            "SELECT pid, lower(email) FROM review WHERE gone_at IS NULL AND email IS NOT NULL AND rtype <> 5 AND coalesce(round,'') <> 'screen' AND status = 'complete' ORDER BY pid, email",
        ) { it.getLong(1) to it.getString(2) }.filter { it.first in recorded }.map { (pid, who) -> FeedbackOwed(pid, who, (pid to who) in answered) }
    }

    public fun record(store: Store, clock: Clock, a: FeedbackAnswer) {
        store.conn.exec(
            "INSERT INTO triage_feedback(pid,reviewer,flag_right,missed,would_refer,note,recorded_at) VALUES(?,?,?,?,?,?,?) " +
                "ON CONFLICT(pid,reviewer) DO UPDATE SET flag_right=excluded.flag_right, missed=excluded.missed, would_refer=excluded.would_refer, note=excluded.note, recorded_at=excluded.recorded_at",
            a.pid,
            a.reviewer.lowercase(),
            a.flagRight.key,
            a.missed.key,
            a.wouldRefer.key,
            a.note,
            clock.now().epochSecond,
        )
    }

    public fun answers(store: Store): List<FeedbackAnswer> =
        store.conn.query("SELECT pid, reviewer, flag_right, missed, would_refer, note FROM triage_feedback ORDER BY pid, reviewer") {
            FeedbackAnswer(it.getLong(1), it.getString(2), YesNo.of(it.getString(3)), YesNo.of(it.getString(4)), YesNo.of(it.getString(5)), it.getString(6))
        }

    /** The feedback rate S12 says is monitored: answered over owed, and what the answers say about the flags. */
    public data class Summary(val owed: Int, val answered: Int, val flagRight: Int, val flagWrong: Int, val missed: Int) {
        val rate: Double get() = if (owed == 0) 0.0 else answered.toDouble() / owed
    }

    public fun summary(store: Store, q4: Q4, rows: List<TriageRow>): Summary {
        val o = owed(store, q4, rows)
        val a = answers(store)
        return Summary(
            o.size,
            o.count { it.answered },
            a.count { it.flagRight == YesNo.YES },
            a.count { it.flagRight == YesNo.NO },
            a.count {
                it.missed ==
                    YesNo.YES
            },
        )
    }

    /** The mail a chair sends to a reviewer who is owed the form: the record is in HotCRP (the comment), the questions are here. */
    public fun requestText(): String =
        "Hello,\n\nThank you for submitting your review of paper #%NUMBER%, \"%TITLE%\". You can now read its screening record in the comments " +
            "(the first comment). Three short questions, which help us judge the screening and which never change what happens to this paper:\n" +
            "1. Was the flag right (yes, no, unsure)?\n2. Did the screening miss anything (yes, no, unsure)?\n" +
            "3. Would you have referred the paper (yes, no, unsure)?\n" +
            "Reply to this message with your answers.\n"
}
