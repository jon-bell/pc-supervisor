package pcs.app.testing

import androidx.compose.ui.semantics.SemanticsNode
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.semantics.getOrNull
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsMatcher
import pcs.app.TableTags

/** What a table shows: the count line, the visible column ids with their titles, and each row's cells by column id. */
data class TableView(val count: String, val headers: List<Pair<String, String>>, val rows: List<Pair<String, Map<String, String>>>) {
    val columnIds: List<String> get() = headers.map { it.first }
    val keys: List<String> get() = rows.map { it.first }

    fun cell(key: String, column: String): String? = rows.firstOrNull { it.first == key }?.second?.get(column)
}

/** What the settings screen shows: each question's status, and what each unresolved one blocks. */
data class SettingsView(val summary: String, val status: Map<String, String>, val blocks: Map<String, Set<String>>, val errors: List<String>)

/** What a card screen shows. */
data class CardView(val text: String, val deps: Map<String, String>, val outcome: String?, val blockedBy: String?, val possible: List<String>)

/**
 * The view reader (PLAN §A4): each screen read back from the semantics tree into a structured
 * observation. Tests compare it with the expected observation in both directions, so an extra or a
 * missing row fails alike. It reads only what is composed, so tables are checked for what the
 * window shows; the count line covers the rest.
 */
@OptIn(ExperimentalTestApi::class)
class ViewReader(private val ui: ComposeUiTest) {
    companion object {
        fun textOf(n: SemanticsNode): String =
            n.config.getOrNull(SemanticsProperties.Text)?.joinToString("") { it.text }
                ?: n.config.getOrNull(SemanticsProperties.EditableText)?.text
                ?: ""

        fun tagOf(n: SemanticsNode): String? = n.config.getOrNull(SemanticsProperties.TestTag)
    }

    private fun withTag(prefix: String? = null, exact: String? = null): List<SemanticsNode> =
        ui.onAllNodes(
            SemanticsMatcher("test tag ${exact ?: "$prefix*"}") { n ->
                tagOf(n)?.let { t ->
                    if (exact !=
                        null
                    ) {
                        t == exact
                    } else {
                        t.startsWith(prefix!!)
                    }
                } == true
            },
            useUnmergedTree = true,
        ).fetchSemanticsNodes()

    fun exists(tag: String): Boolean = withTag(exact = tag).isNotEmpty()

    fun text(tag: String): String = withTag(exact = tag).singleOrNull()?.let(::textOf) ?: error("no single node tagged $tag")

    fun textOrNull(tag: String): String? = withTag(exact = tag).singleOrNull()?.let(::textOf)

    /** The tags under [prefix], with the prefix removed, in screen order (top to bottom, then left to right). */
    fun tagsWith(prefix: String): List<String> =
        withTag(prefix).sortedWith(compareBy({ it.boundsInRoot.top }, { it.boundsInRoot.left })).mapNotNull { tagOf(it)?.removePrefix(prefix) }

    fun table(): TableView {
        val headers =
            withTag("header-").sortedBy { it.boundsInRoot.left }.map { tagOf(it)!!.removePrefix("header-") to textOf(it).removeSuffix(" ▲").removeSuffix(" ▼") }
        val keys = withTag("row-").filter { tagOf(it) != TableTags.COUNT }.sortedBy { it.boundsInRoot.top }.map { tagOf(it)!!.removePrefix("row-") }
        val rows =
            keys.map { k ->
                k to headers.mapNotNull { (id, _) -> textOrNull(TableTags.cell(k, id))?.let { id to it } }.toMap()
            }
        return TableView(text(TableTags.COUNT), headers, rows)
    }

    fun settings(): SettingsView {
        val questions = tagsWith("question-")
        val status = questions.associateWith { text("status-$it") }
        val blocks =
            questions.associateWith { q ->
                tagsWith("blocked-$q-").toSet()
            }.filterValues { it.isNotEmpty() }
        return SettingsView(text("answers-summary"), status, blocks, withTag(exact = "answers-error").map(::textOf))
    }

    fun card(): CardView =
        CardView(
            text("card-text"),
            tagsWith("card-dep-").associateWith { text("card-dep-$it") },
            textOrNull("card-outcome"),
            textOrNull("card-blocked"),
            tagsWith("card-possible-").map { text("card-possible-$it") },
        )
}
