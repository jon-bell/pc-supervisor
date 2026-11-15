package net.jonbell.pcs.seed

/**
 * A seed scenario (PLAN M2): PC members, papers, assignments, and a timeline of events at day
 * offsets from a named phase date. Everything is synthetic, with invented names at example.org.
 */
data class PcUser(val email: String, val first: String, val last: String, val tags: List<String> = emptyList(), val roles: String = "pc")

data class Paper(val pid: Int, val title: String, val authors: List<String>)

/** HotCRP assignment actions: metareview | primary | secondary | pcreview. */
data class Assign(val pid: Int, val action: String, val email: String)

/** A time: `days` (fractional allowed) after the phase date `phase` (e.g. DISCUSSION_OPEN). */
data class At(val phase: String, val days: Double) {
    companion object {
        fun disc(days: Double) = At("DISCUSSION_OPEN", days)

        fun disc(days: Int) = At("DISCUSSION_OPEN", days.toDouble())
    }
}

sealed interface Event {
    val at: At
}

data class SubmitReview(val pid: Int, val reviewer: String, val merit: Int, val expertise: Int, val words: Int, override val at: At) : Event

data class ChangeScore(val pid: Int, val reviewer: String, val merit: Int, override val at: At) : Event

data class PostComment(val pid: Int, val author: String, val text: String, override val at: At, val response: Boolean = false) : Event

/** A rating of `reviewer`'s review on `pid` by `rater` (a co-reviewer who has submitted, or the metareviewer). */
data class Rate(val pid: Int, val reviewer: String, val rater: String, val flags: List<String>, override val at: At) : Event

data class SetDecision(val pid: Int, val decision: String, override val at: At) : Event

/** A hidden or ordinary tag added to a paper by the chair (the seeder's chair token). */
data class AddTag(val pid: Int, val tag: String, override val at: At) : Event

data class Scenario(
    val name: String,
    val pc: List<PcUser>,
    val papers: List<Paper>,
    val assignments: List<Assign>,
    val events: List<Event>,
)
