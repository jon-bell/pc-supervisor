package net.jonbell.pcs.core.assignment

import kotlin.math.roundToInt

/*
 * Affinity (concepts Affinity, spec §10.5): scores from several sources, each normalized onto one integer
 * scale of 0 to 100, then blended by weight. A source that has no value for an edge simply doesn't vote on it.
 * Sources in priority order: the `tpms-scores` import; local openreview-expertise scores; HotCRP's own
 * preferences, expertise and topic scores. Only the first is importable today; the others plug in as [AffinitySource]s.
 */

/** One source's raw values by (paper, person), with the range it is on. [weight] is `PCS_AFFINITY_WEIGHT_<NAME>`. */
public data class AffinitySource(val name: String, val weight: Double, val lo: Double, val hi: Double, val values: Map<Pair<Long, Long>, Double>) {
    init {
        require(hi > lo) { "$name: an empty range" }
        require(weight > 0) { "$name: weight must be positive" }
    }

    /** The value on the common 0 to 100 scale, clamped. */
    public fun normalized(v: Double): Double = ((v - lo) / (hi - lo)).coerceIn(0.0, 1.0) * 100.0

    public companion object {
        /** TPMS scores are floats in 0 to 1. */
        public fun tpms(values: Map<Pair<Long, Long>, Double>, weight: Double = 3.0): AffinitySource = AffinitySource("tpms-scores", weight, 0.0, 1.0, values)

        /** HotCRP review preferences run from -20 to 20 (expertise comes as X, Y, Z elsewhere). */
        public fun hotcrpPreferences(values: Map<Pair<Long, Long>, Double>, weight: Double = 1.0): AffinitySource =
            AffinitySource("hotcrp-preferences", weight, -20.0, 20.0, values)
    }
}

public object Affinity {
    /** Blend [sources] into one integer per edge: the weighted mean of the normalized values the edge has. */
    public fun combine(sources: List<AffinitySource>): Map<Pair<Long, Long>, Int> {
        val keys = sources.flatMap { it.values.keys }.toSet()
        return keys.associateWith { k ->
            var num = 0.0
            var den = 0.0
            for (s in sources) {
                val v = s.values[k] ?: continue
                num += s.weight * s.normalized(v)
                den += s.weight
            }
            (num / den).roundToInt()
        }
    }

    /** How many edges each source supplied, for the report's affinity coverage. */
    public fun coverage(sources: List<AffinitySource>): Map<String, Int> = sources.associate { it.name to it.values.size }
}
