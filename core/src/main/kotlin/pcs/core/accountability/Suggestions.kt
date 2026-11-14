package pcs.core.accountability

import java.time.Instant

/*
 * Accountability-request suggestions (AR3): the heuristic signals read review metadata and structure only, never text.
 * The type below is all the signal code may see. It has no field that holds what a reviewer wrote: only counts, scores,
 * which form fields have *some* text, rating names, and times. `AccountabilityLintTest` checks the type and the loader.
 */

/** What one review looks like to the heuristics: metadata and structure. */
public data class ReviewMeta(
    val pid: Long,
    val rid: Long,
    val ordinal: String?,
    val reviewer: String,
    val group: String,
    val complete: Boolean,
    val words: Int,
    val merit: Int?,
    /** The merits of the paper's other complete reviews, for the score-far-from-the-rest signal. */
    val peerMerits: List<Int>,
    /** The ids of the form fields that hold any text (never what the text says). */
    val filledFields: Set<String>,
    val ratings: List<String>,
    val firstCompleteAt: Instant?,
)

public data class SignalConfig(
    val minWords: Int = 150,
    val ratingRaters: Int = 2,
    val meritAcceptMin: Int = 3,
    val outlierGap: Int = 2,
    /** The review form's weakness field; null if the venue's form has none, which turns that signal off. */
    val weaknessField: String? = null,
    val requiredFields: Set<String> = emptySet(),
    val reviewDue: Instant? = null,
)

public data class Fired(val signal: String, val reason: String)

public object Suggestions {
    public val SIGNALS: List<String> = listOf("thin", "rated", "negative-no-weakness", "outlier", "empty-field", "late")

    /** The signals that fire on [r], each with a reason that quotes the numbers. Pure in its inputs. */
    public fun signals(r: ReviewMeta, c: SignalConfig): List<Fired> {
        if (!r.complete) return emptyList()
        val out = mutableListOf<Fired>()
        if (r.words < c.minWords) out += Fired("thin", "${r.words} words, below the depth floor of ${c.minWords}")
        val flagged = r.ratings.count { it == "short" || it == "vague" }
        if (flagged >= c.ratingRaters) out += Fired("rated", "$flagged co-reviewers rated it short or vague")
        val w = c.weaknessField
        if (w != null && r.merit != null && r.merit < c.meritAcceptMin && w !in r.filledFields) {
            out += Fired("negative-no-weakness", "merit ${r.merit} is below ${c.meritAcceptMin} and the $w field is empty")
        }
        if (r.merit != null && r.peerMerits.isNotEmpty()) {
            val sorted = r.peerMerits.sorted()
            val median = sorted[sorted.size / 2]
            if (kotlin.math.abs(r.merit - median) >= c.outlierGap && r.words < c.minWords * 2) {
                out += Fired("outlier", "merit ${r.merit} against a median of $median, with ${r.words} words")
            }
        }
        val missing = c.requiredFields.filter { it !in r.filledFields }
        if (missing.isNotEmpty()) out += Fired("empty-field", "required field(s) empty: ${missing.sorted().joinToString()}")
        val due = c.reviewDue
        if (due != null && r.firstCompleteAt != null && r.firstCompleteAt.isAfter(due)) {
            out += Fired("late", "submitted ${java.time.Duration.between(due, r.firstCompleteAt).toDays()} day(s) after the deadline")
        }
        return out
    }

    /** The criteria whose signals fired, in the list's order (AR1: only criteria on the list). */
    public fun criteriaFor(fired: List<Fired>, list: List<Criterion>): List<Int> =
        list.filter { cr -> fired.any { it.signal in cr.signals } }.map { it.id }
}
