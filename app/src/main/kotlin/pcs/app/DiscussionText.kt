package pcs.app

import pcs.core.rules.PaperStage

/**
 * Every word the discussion screens use for a rule, a stage and a person's state, in one place so the wording rules of spec §7
 * can be tested over it: the app says what it can see ("no comments yet"), never what it would have to guess about a person,
 * because the mirror sees who writes and not who reads.
 */
object DiscussionText {
    /** A short chip label per rule (spec §5c names the rule; the chip says what was seen). */
    val RULE_LABEL: Map<String, String> =
        linkedMapOf(
            "MISSING_REVIEWS" to "Missing reviews",
            "SPLIT" to "Split scores",
            "UNRESOLVED_SPLIT" to "Split, no movement",
            "SILENT_DISCUSSION" to "No comments yet",
            "GONE_QUIET" to "Gone quiet",
            "AC_ABSENT" to "No AC comment yet",
            "CHAMPION_MISSING" to "Top scorer: no comment yet",
            "LOW_EXPERTISE" to "Low expertise",
            "THIN_REVIEWS" to "Thin reviews",
            "RESPONSE_UNADDRESSED" to "Response unanswered",
            "REVIEW_FLAGGED" to "Review flagged",
            "DEADLINE_NO_CONSENSUS" to "Deadline near, no consensus",
        )

    fun rule(name: String): String = RULE_LABEL[name] ?: name

    val STAGE_LABEL: Map<PaperStage, String> =
        mapOf(
            PaperStage.AWAITING_REVIEWS to "Awaiting reviews",
            PaperStage.BETWEEN to "Reviews due, discussion not open",
            PaperStage.IN_DISCUSSION to "In discussion",
            PaperStage.DECIDED to "Decided",
        )

    const val NO_POST_YET = "no post yet"
    const val NO_COMMENT_YET = "no comment yet"
    const val APPROX_NOTE = "A ≈ before a day means the time was rebuilt from HotCRP's review history, not seen by a sync."
    const val NUDGE_NOTE = "Nudges: comments that @mention a reviewer, or posted while a reviewer had no comments yet (a proxy)."
    const val SEE_NOTE = "PC Supervisor sees who writes, not who reads; \"no comments yet\" says nothing about reading."
    const val LOAD_NOTE = "Load: papers held, and how many have a reason chip, so a heavy load reads differently from a quiet one."
}
