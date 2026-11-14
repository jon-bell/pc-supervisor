package pcs.core.nominations

import pcs.core.readings.QId
import pcs.core.readings.Readings

/**
 * A result that may turn on an open question (concepts §3.1). When every question it depends on
 * is answered, or every reading of the open ones gives the same result, it is [Decided]. Otherwise
 * it is [Open], and says what each reading of the open questions would give. Nothing is defaulted.
 */
public sealed interface Resolved<out T> {
    public data class Decided<T>(val value: T) : Resolved<T>

    /** The answers leave [by] open and the result differs among their readings; [cases] lists each. */
    public data class Open<T>(val by: List<QId>, val cases: List<Pair<Map<QId, String>, T>>) : Resolved<T>

    /** The one result, or null while it is open. */
    public val decided: T? get() = (this as? Decided<T>)?.value

    public companion object {
        /** Evaluate [f] under every reading of the unresolved members of [qs]; `r` supplies the answered ones. */
        public fun <T> of(r: Readings, qs: List<QId>, f: (Readings) -> T): Resolved<T> {
            val open = qs.filter { r[it] == null }
            var combos: List<Pair<Map<QId, String>, Readings>> = listOf(emptyMap<QId, String>() to r)
            for (q in open) {
                combos = combos.flatMap { (m, rr) -> q.readings.map { v -> (m + (q to v.key)) to rr.with(q, v.key)!! } }
            }
            // a question outside `qs` that is still open takes the model's base reading, as the model's cards do
            val cases = combos.map { (m, rr) -> m to f(rr.base()) }
            val distinct = cases.map { it.second }.distinct()
            return if (distinct.size == 1) Decided(distinct.single()) else Open(open, cases)
        }
    }
}
