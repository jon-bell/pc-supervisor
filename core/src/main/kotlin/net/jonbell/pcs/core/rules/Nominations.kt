package net.jonbell.pcs.core.rules

import net.jonbell.pcs.core.readings.Q10
import net.jonbell.pcs.core.readings.Q17
import net.jonbell.pcs.core.readings.Q18
import net.jonbell.pcs.core.readings.Q19
import net.jonbell.pcs.core.readings.Q19b
import net.jonbell.pcs.core.readings.Q6
import net.jonbell.pcs.core.readings.Q8

/*
 * Nominations and obligations (concepts §3.3; model/ReviewProcess/Model.lean). Shares are in
 * sixths of a paper's obligation and obligations in sixths of a review, so halves and thirds
 * are exact.
 */

public const val K: Int = 3

/** Rule `compliance (p)` (concepts §3.8), by its model keys. `flagged-pattern` is not here: a pattern is a signal, not non-compliance. */
public enum class Compliance(public val key: String) {
    OK("ok"),
    MISSING_NOMINEE("missing-nominee"),
    TOO_MANY_NOMINEES("too-many-nominees"),
    UNREGISTERED("unregistered"),
}

public data class Nominee(val who: Long, val share: Int = 0, val accepted: Boolean = true)

public data class PaperNoms(val paper: Long, val nominees: List<Nominee>)

public object Nominations {
    /** What each named nominee owes for one paper, in sixths, or null when Q19 pools the obligation. Declined nominees owe nothing. */
    public fun paperShares(f: Faults, q19: Q19, q19b: Q19b, pn: PaperNoms): List<Pair<Long, Int>>? {
        val acc = pn.nominees.filter { it.accepted }
        val n = pn.nominees.size
        val full = 6 * K
        if (q19 == Q19.SOLVER) return if (n == 1) acc.map { it.who to full } else null

        fun raw(x: Nominee): Int = if (q19 == Q19.EQUAL) (if (n == 0) 0 else full / n) else x.share * K
        val declined = pn.nominees.filter { !it.accepted }.sumOf(::raw)
        val accTotal = acc.sumOf(::raw)
        return acc.map { x ->
            val extra = if (q19b == Q19b.OTHERS_ABSORB && !f.declinedShareToUnnamed && accTotal > 0) declined * raw(x) / accTotal else 0
            x.who to raw(x) + extra
        }
    }

    /** The part of a paper's obligation its named nominees leave unmet (sixths). */
    public fun paperShortfall(f: Faults, q19: Q19, q19b: Q19b, pn: PaperNoms): Int =
        when (val ss = paperShares(f, q19, q19b, pn)) {
            null -> if (pn.nominees.any { it.accepted }) 0 else 6 * K
            else -> 6 * K - minOf(6 * K, ss.sumOf { it.second })
        }

    /** Does a declined share move to someone the authors didn't name? Only under the mutant (V2). */
    public fun movedToUnnamed(f: Faults, q19b: Q19b, pn: PaperNoms): Boolean =
        f.declinedShareToUnnamed && q19b == Q19b.OTHERS_ABSORB && pn.nominees.any { !it.accepted }

    public fun bandMax(t: Tier): Int =
        when (t) {
            Tier.SENIOR -> 15
            Tier.JUNIOR -> 8
        }

    /** Rule `owes`: what person [u] owes across the papers that name them, in sixths; null if every share is pooled. */
    public fun owes(f: Faults, q18: Q18, q19: Q19, q19b: Q19b, tier: Tier, all: List<PaperNoms>, u: Long): Int? {
        val mine = all.filter { pn -> pn.nominees.any { it.who == u && it.accepted } }
        if (mine.isEmpty()) return 0
        val shares = mine.map { pn -> paperShares(f, q19, q19b, pn)?.filter { it.first == u }?.sumOf { it.second } }

        fun sum(): Int? = if (shares.any { it == null }) null else shares.sumOf { it!! }
        return when (if (f.combineIgnoresQ18) Q18.ONCE else q18) {
            Q18.ONCE -> 6 * K
            Q18.PER_PAPER -> 6 * K * mine.size
            Q18.SHARE_WEIGHTED -> sum()
            Q18.CAPPED_AT_BAND -> sum()?.let { minOf(it, 6 * bandMax(tier)) }
        }
    }

    /**
     * Rule `compliance (p)`: the paper names the nominees Q8 allows (declined ones were still named by the
     * authors), each registered with the matching system. [registered] holds the nominees known to be.
     */
    public fun compliance(q8: Q8, pn: PaperNoms, registered: Set<Long>, max: Int = Venue.DEFAULT_NOMINEES_MAX): Compliance {
        val n = pn.nominees.size
        val tooMany =
            when (q8) {
                Q8.ONE -> n > 1
                Q8.UP_TO_N -> n > max
                Q8.AT_LEAST_ONE -> false
            }
        return when {
            n == 0 -> Compliance.MISSING_NOMINEE
            tooMany -> Compliance.TOO_MANY_NOMINEES
            pn.nominees.any { it.who !in registered } -> Compliance.UNREGISTERED
            else -> Compliance.OK
        }
    }

    /** May a paper that fails `compliance` be referred on the ground `nomination-noncompliance` now? Q10, through the desk-reject rule. */
    public fun mayRefer(q10: Q10, warned: Boolean): Boolean =
        DeskReject.groundAdmissible(Q6.entries.first(), q10, Referral(ac = 0, ground = Ground.NOMINATION_NONCOMPLIANCE, warned = warned))

    /**
     * The Q9 signal for one author: a senior with at least [min] nominations whose nominee is always someone else,
     * always a junior. [noms] holds a (nominee, tier) for each nomination, so the same junior nominated from several
     * papers counts once for each (the owner's ruling).
     */
    public fun nominationPattern(
        author: Long,
        authorTier: Tier?,
        noms: List<Pair<Long, Tier?>>,
        min: Int = Venue.DEFAULT_PATTERN_MIN,
    ): Boolean = authorTier == Tier.SENIOR && noms.size >= min && noms.all { (w, t) -> w != author && t == Tier.JUNIOR }

    /**
     * Appointment authority (model `decisionCounts`): a sheet decision counts if its author is an AC of a paper that
     * nominated the candidate, or any AC when nobody nominated them, or a PC chair. [nominating] holds the ACs of each
     * nominating paper (empty: nobody nominated the candidate).
     */
    public fun <T> decisionCounts(nominating: List<Set<T>>, acs: Set<T>, decider: T, isChair: Boolean): Boolean =
        isChair || if (nominating.isEmpty()) decider in acs else nominating.any { decider in it }

    /** What a pattern does by itself: nothing (V3; `Ground` has no such case). */
    public const val PATTERN_CONSEQUENCE: String = "no consequence by itself"

    /** Q17: the most papers one author may be on, or null with no cap. */
    public fun submissionCap(q17: Q17): Int? =
        when (q17) {
            Q17.NONE -> null
            Q17.N_9 -> 9
        }

    /** How many of an author's [n] papers are over the cap. */
    public fun papersOverCap(q17: Q17, n: Int): Int = submissionCap(q17)?.let { maxOf(0, n - it) } ?: 0

    /** Sixths of a review, shown as reviews. */
    public fun showSixths(n: Int): String = if (n % 6 == 0) "${n / 6}" else "${n / 6} ${n % 6}/6"
}
