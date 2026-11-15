package net.jonbell.pcs.cli.eval

import java.math.BigDecimal
import java.math.RoundingMode

/**
 * What the report may show about a cell (PLAN M21, prop:C1). A cell is a count of papers, people or reviews. Owner's ruling 2026-11-15: **zero is
 * shown** (a recall numerator of zero is the failure a chair most needs to see), and only a cell of 1 to [min] minus 1 is suppressed. The rules, all
 * applied before any number is rendered, so no code path can print a small non-zero count:
 *
 * - a count of 1 to `min-1` is shown as `<min`; zero and counts of `min` or more are shown as they are;
 * - a rate shows its numerator only when neither the numerator nor its complement is a small cell (`17 of 40` leaks `23` too; `37 of 40` leaks `3`);
 *   a complement of zero is shown, like any zero;
 * - a confusion group (true positives, false positives, false negatives) shows nothing if any of the three cells is a small cell, because
 *   precision, recall and the two totals would otherwise give it back by subtraction;
 * - counts that are nested (each reading's set contains the one before) are shown only when they differ from every other shown count by zero or by at
 *   least [min]: a difference of 1 to `min-1` is a small cell of its own.
 */
class Disclosure(val min: Int = MIN_CELL) {
    init {
        require(min >= MIN_CELL) { "the smallest cell may not go below $MIN_CELL (asked for $min)" }
    }

    /** A cell of 1 to `min-1`: the only counts that are never shown. */
    fun small(n: Int): Boolean = n in 1 until min

    /** A standalone count: the number, or `<min` for a small cell. */
    fun count(n: Int): String = if (small(n)) "<$min" else n.toString()

    /** True when [n] may be shown as itself (zero, or [min] and over). */
    fun shows(n: Int): Boolean = !small(n)

    /** `42.5% (17 of 40)`, or [SUPPRESSED] when the numerator or its complement is a small cell. */
    fun rate(num: Int, den: Int): String = if (showsRate(num, den)) "${pct(num, den)} ($num of $den)" else SUPPRESSED

    /** True when a rate on [num] of [den] may be shown. */
    fun showsRate(num: Int, den: Int): Boolean = shows(num) && shows(den - num)

    /** A mean over [n] items: [SUPPRESSED] for a small [n], `n/a` over none. */
    fun mean(total: BigDecimal, n: Int, digits: Int = 4): String =
        when {
            small(n) -> SUPPRESSED
            n == 0 -> "n/a"
            else -> total.divide(BigDecimal(n), digits, RoundingMode.HALF_UP).toPlainString()
        }

    /** Which of the nested [counts] (each at least the one before) may be shown. */
    fun nested(counts: List<Int>): List<Boolean> {
        val shown = counts.map { shows(it) }.toMutableList()
        var changed = true
        while (changed) {
            changed = false
            val live = counts.indices.filter { shown[it] }
            for (k in 1 until live.size) {
                if (small(counts[live[k]] - counts[live[k - 1]])) {
                    shown[live[k]] = false
                    changed = true
                    break
                }
            }
        }
        return shown
    }

    companion object {
        const val MIN_CELL = 5
        const val SUPPRESSED = "suppressed"

        /** One decimal, half up, with no locale: the same bytes on every machine. */
        fun pct(num: Int, den: Int): String =
            if (den == 0) {
                "n/a"
            } else {
                BigDecimal(num).multiply(BigDecimal(100)).divide(BigDecimal(den), 1, RoundingMode.HALF_UP).toPlainString() + "%"
            }
    }
}

/** Precision, recall and the cells they come from. Nothing is shown unless all three cells are large enough. */
data class Confusion(val tp: Int, val fp: Int, val fn: Int) {
    val flagged: Int get() = tp + fp
    val actual: Int get() = tp + fn

    fun shown(d: Disclosure): Boolean = d.shows(tp) && d.shows(fp) && d.shows(fn)

    fun precision(d: Disclosure): String = if (shown(d)) Disclosure.pct(tp, flagged) else Disclosure.SUPPRESSED

    fun recall(d: Disclosure): String = if (shown(d)) Disclosure.pct(tp, actual) else Disclosure.SUPPRESSED

    fun tpCell(d: Disclosure): String = if (shown(d)) tp.toString() else Disclosure.SUPPRESSED
}
