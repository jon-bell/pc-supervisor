package net.jonbell.pcs.app

/**
 * One column of a [LazyTable]. [text] is what the cell shows (and what the filter matches);
 * [sort] gives the sort key, or null if the column doesn't sort. [masked] columns hold times that
 * change from run to run and are masked in screenshot mode.
 */
data class Col<T>(
    val id: String,
    val title: String,
    val widthDp: Int,
    val text: (T) -> String,
    val sort: ((T) -> Comparable<*>?)? = null,
    val visibleByDefault: Boolean = true,
    val masked: Boolean = false,
    /** Draws the cell (a sparkline) behind its text, which stays in the semantics tree for the view reader. */
    val chart: (@androidx.compose.runtime.Composable (T) -> Unit)? = null,
)

/** The sort a header click sets: none, then ascending, then descending, then ascending again. */
data class SortState(val column: String, val ascending: Boolean) {
    fun next(clicked: String): SortState = if (column == clicked) copy(ascending = !ascending) else SortState(clicked, true)
}

/** Sorting, filtering and column choice, kept apart from Compose so they can be tested without a window. */
object TableLogic {
    /** Keeps rows where every whitespace-separated term occurs (case-insensitively) in some visible column's text. */
    fun <T> filter(rows: List<T>, columns: List<Col<T>>, query: String): List<T> {
        val terms = query.lowercase().split(Regex("\\s+")).filter { it.isNotEmpty() }
        if (terms.isEmpty()) return rows
        return rows.filter { r ->
            val haystack = columns.joinToString("\u0000") { it.text(r) }.lowercase()
            terms.all { it in haystack }
        }
    }

    /** A stable sort by the column's key, nulls last in either direction. Unsortable or unknown columns leave the order. */
    @Suppress("UNCHECKED_CAST")
    fun <T> sort(rows: List<T>, columns: List<Col<T>>, state: SortState?): List<T> {
        val key = state?.let { s -> columns.firstOrNull { it.id == s.column }?.sort } ?: return rows
        val cmp = Comparator<T> { a, b -> compareValues(key(a) as Comparable<Any>?, key(b) as Comparable<Any>?) }
        val nulls = rows.filter { key(it) == null }
        val sorted = rows.filter { key(it) != null }.sortedWith(if (state.ascending) cmp else cmp.reversed())
        return sorted + nulls
    }
}
