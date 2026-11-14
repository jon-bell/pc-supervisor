package pcs.app

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import pcs.testing.Covers

/** Sorting and filtering of the reusable table, without a window. */
@Covers("view:papers")
class TableLogicTest {
    private data class R(val n: Int, val name: String, val score: Int?)

    private val cols =
        listOf(
            Col<R>("n", "#", 40, { it.n.toString() }, { it.n }),
            Col<R>("name", "Name", 100, { it.name }, { it.name.lowercase() }),
            Col<R>("score", "Score", 60, { it.score?.toString().orEmpty() }, { it.score }),
            Col<R>("note", "Note", 60, { "x" }),
        )
    private val rows = listOf(R(1, "beta", 3), R(2, "Alpha", null), R(3, "gamma", 1), R(4, "alpha two", 3))

    @Test
    fun `sorting is stable, case-insensitive where the key says so, and puts missing values last either way`() {
        assertEquals(listOf(2, 4, 1, 3), TableLogic.sort(rows, cols, SortState("name", true)).map { it.n })
        assertEquals(listOf(3, 1, 4, 2), TableLogic.sort(rows, cols, SortState("score", true)).map { it.n })
        assertEquals(listOf(1, 4, 3, 2), TableLogic.sort(rows, cols, SortState("score", false)).map { it.n })
    }

    @Test
    fun `a column without a key, an unknown column, or no sort leaves the order`() {
        val ids = rows.map { it.n }
        assertEquals(ids, TableLogic.sort(rows, cols, SortState("note", true)).map { it.n })
        assertEquals(ids, TableLogic.sort(rows, cols, SortState("nope", true)).map { it.n })
        assertEquals(ids, TableLogic.sort(rows, cols, null).map { it.n })
    }

    @Test
    fun `every term must match some visible column, ignoring case`() {
        assertEquals(listOf(2, 4), TableLogic.filter(rows, cols, "ALPHA").map { it.n })
        assertEquals(listOf(4), TableLogic.filter(rows, cols, "alpha 3").map { it.n })
        assertEquals(listOf(1, 2, 3, 4), TableLogic.filter(rows, cols, "  ").map { it.n })
        // a hidden column's text doesn't match: only the visible columns are searched
        assertEquals(emptyList<Int>(), TableLogic.filter(rows, cols.filter { it.id != "name" }, "alpha").map { it.n })
    }

    @Test
    fun `a header click sorts ascending, then flips, and a different column starts ascending`() {
        val a = SortState("n", false).next("n")
        assertEquals(SortState("n", true), a)
        assertEquals(SortState("n", false), a.next("n"))
        assertEquals(SortState("name", true), a.next("name"))
    }
}
