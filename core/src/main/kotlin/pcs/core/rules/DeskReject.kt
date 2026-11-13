package pcs.core.rules

import pcs.core.readings.Q1
import pcs.core.readings.Q10
import pcs.core.readings.Q2
import pcs.core.readings.Q3
import pcs.core.readings.Q6
import pcs.core.readings.Readings

/*
 * Rule `may-remove` for desk rejects (docs/concepts.md §3.8), ported from
 * model/ReviewProcess/Model.lean. Tests: the model's cards (T1) and a differential test
 * against the Lean oracle (T2, `rule:may-remove`). Times are hours.
 */

public enum class Tier { SENIOR, JUNIOR }

public enum class Ground(public val key: String) {
    FORMAT("format"),
    SCOPE("scope"),
    ANONYMITY("anonymity"),
    FABRICATED_REFERENCE("fabricated-reference"),
    MISUSED_CITATION("misused-citation"),
    NO_CONTRIBUTION("no-contribution"),
    NOMINATION_NONCOMPLIANCE("nomination-noncompliance"),
    PROMPT_INJECTION("prompt-injection"),
    ;

    public companion object {
        public fun ofKey(k: String): Ground? = entries.firstOrNull { it.key == k }
    }
}

public enum class Stage(public val key: String) {
    SCREENING("screening"),
    ASSIGNED("assigned"),
    IN_REVIEW("in-review"),
    RELEASED("released"),
    ;

    public companion object {
        public fun ofKey(k: String): Stage? = entries.firstOrNull { it.key == k }
    }
}

public data class Opinion(
    val who: Long,
    val isAc: Boolean = false,
    val tier: Tier? = null,
    val conflicted: Boolean = false,
    val agrees: Boolean = true,
)

public data class Referral(
    val ac: Long,
    val ground: Ground,
    val opinions: List<Opinion> = emptyList(),
    val stage: Stage = Stage.SCREENING,
    val remedyOffered: Boolean = false,
    val remedyDue: Long = 0,
    val cured: Boolean = false,
    val warned: Boolean = false,
    val askedAt: Long = 0,
    val now: Long = 0,
)

public object DeskReject {
    /** Opinions that count: agree, not the referring AC, not conflicted. */
    public fun validOpinions(f: Faults, ref: Referral): List<Opinion> =
        ref.opinions.filter { o -> o.agrees && (f.secondOpinionFromAnyone || (o.who != ref.ac && !o.conflicted)) }

    public fun q2Met(q: Q2, v: List<Opinion>): Boolean =
        when (q) {
            Q2.AC_ALONE -> true
            Q2.AC_PLUS_SENIOR -> v.any { it.tier == Tier.SENIOR }
            Q2.AC_PLUS_AC -> v.any { it.isAc }
            Q2.VOTE -> v.count { it.tier == Tier.SENIOR } >= 2 && v.count { it.tier == Tier.JUNIOR } >= 1
        }

    public fun twoPerson(f: Faults, q2: Q2, ref: Referral): Boolean =
        if (q2 == Q2.AC_ALONE) true else validOpinions(f, ref).let { it.isNotEmpty() && q2Met(q2, it) }

    public fun groundAdmissible(q6: Q6, q10: Q10, ref: Referral): Boolean =
        when (ref.ground) {
            Ground.FABRICATED_REFERENCE -> q6 == Q6.GROUNDS
            Ground.NOMINATION_NONCOMPLIANCE ->
                when (q10) {
                    Q10.DESK_REJECT -> true
                    Q10.WARN_THEN_REJECT -> ref.warned
                    Q10.WARN_ONLY -> false
                }
            else -> true
        }

    public fun stageAllowed(q3: Q3, g: Ground, s: Stage): Boolean =
        when (q3) {
            Q3.BEFORE_ASSIGNMENT -> s == Stage.SCREENING
            Q3.ANONYMITY_UNTIL_RELEASE -> s == Stage.SCREENING || (g == Ground.ANONYMITY && s != Stage.RELEASED)
            Q3.ANY_UNTIL_RELEASE -> s != Stage.RELEASED
            Q3.ANONYMITY_ANY_STAGE -> s == Stage.SCREENING || g == Ground.ANONYMITY
            Q3.ANY_ANY_STAGE -> true
        }

    public fun remedyHonored(q1: Q1, ref: Referral): Boolean =
        if (ref.ground == Ground.ANONYMITY && q1 == Q1.FIX_WINDOW) {
            ref.remedyOffered && ref.now > ref.remedyDue && !ref.cured
        } else {
            true
        }

    /** May the AC keep (not refer) a paper with this ground? Under Q1's "reject at once", an anonymity violation can't be kept. */
    public fun acMayKeep(q1: Q1, g: Ground): Boolean = g != Ground.ANONYMITY || q1 != Q1.REJECT_AT_ONCE

    /**
     * May a chair remove this paper now? `r` must be resolved for Q1, Q2, Q3, Q6 and Q10;
     * an unresolved one is a blocked rule, not a default (concepts §3.1), so callers pass
     * `Readings.base()` only where the model does.
     */
    public fun mayRemove(f: Faults, r: Readings, ref: Referral): Boolean {
        val q1 = requireNotNull(r.q1) { "Q1 unresolved" }
        val q2 = requireNotNull(r.q2) { "Q2 unresolved" }
        val q3 = requireNotNull(r.q3) { "Q3 unresolved" }
        val q6 = requireNotNull(r.q6) { "Q6 unresolved" }
        val q10 = requireNotNull(r.q10) { "Q10 unresolved" }
        val silent = f.silenceRemoves && ref.opinions.isEmpty() && ref.now >= ref.askedAt + 72
        return (twoPerson(f, q2, ref) || silent) &&
            groundAdmissible(q6, q10, ref) &&
            stageAllowed(q3, ref.ground, ref.stage) &&
            remedyHonored(q1, ref)
    }
}
