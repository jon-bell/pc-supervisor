package net.jonbell.pcs.agent.eval

import kotlinx.serialization.Serializable
import kotlin.math.sqrt
import kotlin.random.Random

/** A point estimate with a 95 percent confidence interval. [n] is what the interval rests on (items, flags, or calls). */
@Serializable
data class Interval(val est: Double, val lo: Double, val hi: Double, val n: Int) {
    fun fmt(digits: Int = 2): String = if (n == 0) "n/a" else "%.${digits}f [%.${digits}f, %.${digits}f]".format(est, lo, hi)

    /** True when the two intervals do not overlap: the difference is not within the noise of the sample. */
    fun separatedFrom(o: Interval): Boolean = n > 0 && o.n > 0 && (lo > o.hi || hi < o.lo)

    companion object {
        val NONE = Interval(0.0, 0.0, 0.0, 0)
    }
}

/** The intervals used by the shootout (agent.md 7.3). Everything is deterministic: bootstraps use a fixed seed. */
object Stats {
    private const val Z = 1.959964

    /** Wilson score interval for k successes in n trials. Well behaved at 0 and n, which small corpora hit often. */
    fun wilson(k: Int, n: Int): Interval {
        if (n == 0) return Interval.NONE
        val p = k.toDouble() / n
        val z2 = Z * Z
        val denom = 1 + z2 / n
        val centre = (p + z2 / (2 * n)) / denom
        val half = Z * sqrt(p * (1 - p) / n + z2 / (4.0 * n * n)) / denom
        return Interval(p, maxOf(0.0, centre - half), minOf(1.0, centre + half), n)
    }

    /** Percentile bootstrap of [statistic] over resampled index sets, one set per group so that groups (positives, negatives) keep their sizes. */
    fun bootstrap(groupSizes: List<Int>, resamples: Int = 2000, seed: Long = 7L, statistic: (List<IntArray>) -> Double): Interval {
        if (groupSizes.any { it == 0 }) return Interval.NONE
        val r = Random(seed)
        val point = statistic(groupSizes.map { IntArray(it) { i -> i } })
        val xs =
            DoubleArray(resamples) {
                statistic(groupSizes.map { n -> IntArray(n) { r.nextInt(n) } })
            }.sorted()
        return Interval(point, xs[(0.025 * (resamples - 1)).toInt()], xs[(0.975 * (resamples - 1)).toInt()], groupSizes.sum())
    }

    /** Mean of [xs] with a bootstrap interval. */
    fun mean(xs: List<Double>, resamples: Int = 2000, seed: Long = 11L): Interval {
        if (xs.isEmpty()) return Interval.NONE
        return bootstrap(listOf(xs.size), resamples, seed) { g -> g[0].sumOf { xs[it] } / xs.size }.copy(n = xs.size)
    }
}
