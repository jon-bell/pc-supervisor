package pcs.core.rules

import pcs.core.readings.Q15
import pcs.core.readings.Q16

// Early reject (concepts §3.6; model/ReviewProcess/Model.lean).

public enum class Score(public val rank: Int) { STRONG_REJECT(0), REJECT(1), WEAK_REJECT(2), BORDERLINE(3), WEAK_ACCEPT(4), ACCEPT(5), STRONG_ACCEPT(6) }

public data class ERCase(val scores: List<Score>, val bumped: Boolean = false, val windowClosed: Boolean = false, val acObjects: Boolean = false)

public object EarlyReject {
    public fun negative(q15: Q15, s: Score): Boolean =
        when (q15) {
            Q15.REJECT_ONLY -> s.rank <= 1
            Q15.REJECT_OR_WEAK -> s.rank <= 2
            Q15.BELOW_ACCEPT -> s.rank <= 3
        }

    public fun mayEarlyReject(f: Faults, q15: Q15, q16: Q16, c: ERCase): Boolean =
        c.scores.isNotEmpty() &&
            c.scores.all { negative(q15, it) } &&
            !c.acObjects &&
            (q16 == Q16.NO_WINDOW || ((c.windowClosed || f.earlyRejectBeforeWindowCloses) && !c.bumped))
}
