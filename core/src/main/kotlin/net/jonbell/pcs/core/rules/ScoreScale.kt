package net.jonbell.pcs.core.rules

/**
 * How the review form's overall-merit values read on the model's seven-point scale (`PCS_SCORE_MAP`,
 * spec §4.1). Q15 asks whether a review is negative; this says which merit value is which score.
 * A merit value the map doesn't name is neither negative nor positive: a paper with one is never a candidate.
 */
public data class ScoreScale(val byMerit: Map<Int, Score>) {
    public fun of(merit: Int?): Score? = merit?.let(byMerit::get)

    /** The lowest merit value that reads as [s], for writing it back (tests and seeders). */
    public fun meritOf(s: Score): Int? = byMerit.entries.filter { it.value == s }.minOfOrNull { it.key }

    public companion object {
        /** HotCRP's default "Overall merit": Reject, Weak reject, Weak accept, Accept, Strong accept. */
        public val HOTCRP_DEFAULT: ScoreScale =
            ScoreScale(mapOf(1 to Score.REJECT, 2 to Score.WEAK_REJECT, 3 to Score.WEAK_ACCEPT, 4 to Score.ACCEPT, 5 to Score.STRONG_ACCEPT))

        /** `1:reject,2:weak-reject,3:borderline,...`; throws [IllegalArgumentException] naming the bad pair. */
        public fun parse(s: String): ScoreScale =
            ScoreScale(
                s.split(",").filter { it.isNotBlank() }.associate { pair ->
                    val parts = pair.trim().split(":")
                    require(parts.size == 2) { "expected <merit>:<score> pairs: $pair" }
                    val merit = parts[0].trim().toIntOrNull() ?: throw IllegalArgumentException("not a merit value: ${parts[0]}")
                    val score =
                        Score.ofKey(parts[1].trim()) ?: throw IllegalArgumentException("unknown score ${parts[1]}; one of ${Score.entries.map { it.key }}")
                    merit to score
                },
            )
    }
}
