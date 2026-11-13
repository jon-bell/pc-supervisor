package pcs.core.rules

import pcs.core.readings.Q18
import pcs.core.readings.Q19
import pcs.core.readings.Q19b

/*
 * Nominations and obligations (concepts §3.3; model/ReviewProcess/Model.lean). Shares are in
 * sixths of a paper's obligation and obligations in sixths of a review, so halves and thirds
 * are exact.
 */

public const val K: Int = 3

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

    /** Sixths of a review, shown as reviews. */
    public fun showSixths(n: Int): String = if (n % 6 == 0) "${n / 6}" else "${n / 6} ${n % 6}/6"
}
