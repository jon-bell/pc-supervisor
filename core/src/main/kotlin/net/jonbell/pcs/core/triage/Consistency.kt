package net.jonbell.pcs.core.triage

import net.jonbell.pcs.core.rules.TriageChoice
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.query

/** One AC's triage counts over the papers they are the metareviewer of. */
public data class AcRates(val ac: String, val papers: Int, val flagged: Int, val triaged: Int, val referred: Int, val kept: Int, val removed: Int) {
    private fun rate(n: Int) = if (papers == 0) 0.0 else n.toDouble() / papers

    val flagRate: Double get() = rate(flagged)
    val referralRate: Double get() = rate(referred)
    val removalRate: Double get() = rate(removed)
}

/** Five-number summary of a rate across ACs. */
public data class Spread(val n: Int, val min: Double, val q1: Double, val median: Double, val q3: Double, val max: Double) {
    val iqr: Double get() = q3 - q1

    public companion object {
        private fun quantile(sorted: List<Double>, p: Double): Double {
            val x = p * (sorted.size - 1)
            val lo = x.toInt()
            val hi = minOf(lo + 1, sorted.size - 1)
            return sorted[lo] + (x - lo) * (sorted[hi] - sorted[lo])
        }

        public fun of(values: List<Double>): Spread? {
            if (values.isEmpty()) return null
            val s = values.sorted()
            return Spread(s.size, s.first(), quantile(s, 0.25), quantile(s, 0.5), quantile(s, 0.75), s.last())
        }
    }
}

/** `prop:M1`: an AC whose referral or removal rate falls outside the band the other ACs form. Chairs are told; nothing else follows from it. */
public data class BandAlert(val ac: String, val metric: String, val rate: Double, val low: Double, val high: Double)

public data class ConsistencyView(
    /** Alphabetical, deliberately: this is a distribution, not a ranking (spec §7). */
    val perAc: List<AcRates>,
    val flag: Spread?,
    val referral: Spread?,
    val removal: Spread?,
    /** Counts of ACs per rate decile [0, 0.1), ..., [0.9, 1.0], for the three rates. */
    val histograms: Map<String, List<Int>>,
    val alerts: List<BandAlert>,
    val note: String?,
)

public object Consistency {
    /** The fence the band uses: Tukey's, widened by [minDelta] so that a tiny departure in a quiet population is not an alert. */
    public const val FENCE_K: Double = 1.5
    public const val MIN_DELTA: Double = 0.05

    /** ACs with fewer papers than this are shown but not compared. */
    public const val MIN_PAPERS: Int = 5

    /** Fewer ACs than this form no band. */
    public const val MIN_ACS: Int = 4

    public fun rates(store: Store, rows: List<TriageRow>): List<AcRates> {
        val byPid = rows.associateBy { it.pid }
        return store.conn.query("SELECT pid, lower(email) FROM review WHERE rtype = 5 AND gone_at IS NULL AND email IS NOT NULL") {
            it.getLong(1) to
                it.getString(2)
        }
            .groupBy({ it.second }, { it.first }).map { (ac, pids) ->
                val rs = pids.mapNotNull { byPid[it] }
                AcRates(
                    ac = ac,
                    papers = pids.size,
                    flagged = rs.count { it.flagged },
                    triaged = rs.count { it.facts?.choice != null },
                    referred = rs.count { it.facts?.choice is TriageChoice.Refer },
                    kept = rs.count { it.facts?.choice is TriageChoice.Keep },
                    removed = rs.count { it.status == TriageStatus.REMOVED },
                )
            }.sortedBy { it.ac }
    }

    /** The out-of-band ACs for one metric. */
    public fun bandAlerts(perAc: List<AcRates>, minPapers: Int = MIN_PAPERS, minAcs: Int = MIN_ACS): List<BandAlert> {
        val eligible = perAc.filter { it.papers >= minPapers }
        if (eligible.size < minAcs) return emptyList()
        return listOf<
            Pair<
                String,
                (
                    AcRates,
                ) -> Double,
            >,
        >("referral rate" to { it.referralRate }, "desk-reject rate" to { it.removalRate }).flatMap { (name, f) ->
            val s = Spread.of(eligible.map(f))!!
            val lo = s.q1 - FENCE_K * s.iqr - MIN_DELTA
            val hi = s.q3 + FENCE_K * s.iqr + MIN_DELTA
            eligible.filter { f(it) < lo || f(it) > hi }.map { BandAlert(it.ac, name, f(it), lo, hi) }
        }
    }

    public fun view(store: Store, rows: List<TriageRow>): ConsistencyView {
        val per = rates(store, rows)
        val eligible = per.filter { it.papers >= MIN_PAPERS }

        fun hist(f: (AcRates) -> Double) = IntArray(10).also { b -> eligible.forEach { b[minOf((f(it) * 10).toInt(), 9)]++ } }.toList()
        return ConsistencyView(
            perAc = per,
            flag = Spread.of(eligible.map { it.flagRate }),
            referral = Spread.of(eligible.map { it.referralRate }),
            removal = Spread.of(eligible.map { it.removalRate }),
            histograms = mapOf("flag rate" to hist { it.flagRate }, "referral rate" to hist { it.referralRate }, "desk-reject rate" to hist { it.removalRate }),
            alerts = bandAlerts(per),
            note =
                "Topic areas are not in the mirror (HotCRP's topics are not synced), so rates are per AC only. " +
                    "ACs with fewer than $MIN_PAPERS papers are listed but not compared.",
        )
    }
}
