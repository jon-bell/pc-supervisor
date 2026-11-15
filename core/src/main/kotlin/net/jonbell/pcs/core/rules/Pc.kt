package net.jonbell.pcs.core.rules

import net.jonbell.pcs.core.readings.Q13
import net.jonbell.pcs.core.readings.Q14

// Eligibility and composition (concepts §3.8; model/ReviewProcess/Model.lean).

public data class Member(
    val who: Long,
    /** The AC's classification; null if not classified. */
    val tier: Tier?,
    val nominee: Boolean = false,
    val accepted: Boolean = true,
    val consented: Boolean = true,
)

public data class PaperFacts(val authors: List<Long> = emptyList(), val conflicts: List<Long> = emptyList())

public object Pc {
    /** Rule `eligible` (V1). */
    public fun eligible(f: Faults, m: Member, pf: PaperFacts): Boolean =
        m.tier != null && (f.assignUnaccepted || (m.accepted && m.consented)) && m.who !in pf.authors && m.who !in pf.conflicts

    public fun fillsSenior(q14: Q14, m: Member): Boolean = m.tier == Tier.SENIOR && (q14 == Q14.TIER_DECIDES || !m.nominee)

    public fun fillsThird(q13: Q13, q14: Q14, m: Member): Boolean =
        !fillsSenior(q14, m) &&
            when (q13) {
                Q13.ONE_JUNIOR_OR_NOMINEE -> m.nominee || m.tier == Tier.JUNIOR
                // a reciprocal nominee is a junior like any other (the owner's ruling on Q13)
                Q13.ZERO_TO_TWO_JUNIORS -> m.tier == Tier.JUNIOR
                else -> m.tier == Tier.JUNIOR && (q14 == Q14.TIER_DECIDES || !m.nominee)
            }

    /** Slots beyond the senior ones that the solver must fill; "zero to two" requires none. */
    public fun thirdSlots(q13: Q13): Int = if (q13 == Q13.ZERO_TO_TWO_JUNIORS) 0 else 1

    /**
     * Slots beyond the senior ones that the solver may fill. Under "zero to two juniors" juniors may sit in the first pass
     * beside the seniors or arrive as reciprocal reviewers; both count toward the cap of two (the owner's ruling).
     */
    public fun thirdCap(q13: Q13): Int = if (q13 == Q13.ZERO_TO_TWO_JUNIORS) 2 else 1

    /** Seats a junior may take to bring a paper with [seniors] seniors and [seated] juniors to [target] reviewers (the venue's `reviewerTarget`), never more than [cap] juniors (`shortRoom`). */
    public fun shortRoom(target: Int, cap: Int, seniors: Int, seated: Int): Int = maxOf(0, minOf(cap, maxOf(0, target - seniors)) - seated)

    /**
     * The optional seats a junior may take on a paper under Q13's "zero to two juniors", by the venue's [JuniorSeats]: [cap] is the most juniors a paper
     * takes ([thirdCap]), [seniors] the senior reviewers it has, [seated] the juniors already on it, [nominee] whether this junior is a reciprocal
     * nominee, [target] the venue's reviewer target (the model's `juniorRoom`).
     */
    public fun juniorRoom(mode: JuniorSeats, target: Int, nominee: Boolean, cap: Int, seniors: Int, seated: Int): Int =
        when {
            mode == JuniorSeats.FILL || (mode == JuniorSeats.RECIPROCAL_ONLY && nominee) -> maxOf(0, cap - seated)
            else -> shortRoom(target, cap, seniors, seated)
        }

    /** Rule `composition`: do these reviewers meet Q13 and Q14? */
    public fun compositionOk(q13: Q13, q14: Q14, seats: List<Member>): Boolean {
        val seniors = seats.filter { fillsSenior(q14, it) }
        val others = seats.filterNot { fillsSenior(q14, it) }
        val juniors = others.filter { it.tier == Tier.JUNIOR && (q14 == Q14.TIER_DECIDES || !it.nominee || q13 == Q13.ZERO_TO_TWO_JUNIORS) }
        val nomineeOrJunior = others.filter { it.nominee || it.tier == Tier.JUNIOR }
        return seniors.size >= 2 &&
            when (q13) {
                Q13.ONE_JUNIOR -> others.size == 1 && juniors.size == 1
                Q13.ONE_OR_TWO_JUNIORS -> juniors.size == others.size && others.size in 1..2
                Q13.ZERO_TO_TWO_JUNIORS -> juniors.size == others.size && others.size <= 2
                Q13.ONE_JUNIOR_OR_NOMINEE -> others.size == 1 && nomineeOrJunior.size == 1
            }
    }

    /** Reciprocal 2-cycles among (reviewer, paper) edges; with the K = 1 mutant only self-review is checked. */
    public fun twoCycles(f: Faults, edges: List<Pair<Long, Long>>, authorOf: (Long) -> List<Long>): Int {
        if (f.cycleK1) return 0
        return edges.flatMap { (u, b) ->
            edges.filter { (v, a) -> a != b && u in authorOf(a) && v in authorOf(b) }.map { (_, a) -> minOf(a, b) to maxOf(a, b) }
        }.distinct().size
    }
}
