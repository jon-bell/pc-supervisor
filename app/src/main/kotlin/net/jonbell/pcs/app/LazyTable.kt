package net.jonbell.pcs.app

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp

/** Test tags of the table component; the view reader (test code) reads the screen back through them. */
object TableTags {
    const val FILTER = "filter"
    const val COUNT = "row-count"
    const val COLUMNS_BUTTON = "columns-button"

    fun header(col: String) = "header-$col"

    fun row(key: String) = "row-$key"

    fun cell(key: String, col: String) = "cell-$key-$col"

    fun toggle(col: String) = "column-toggle-$col"
}

/**
 * The reusable table (PLAN M4): rows are composed lazily, so 4,000 papers cost what the window
 * shows. Click a header to sort, type to filter, use "Columns" to hide or show a column, and click
 * a row to open its HotCRP page in the system browser through [opener]. The rows are plain data,
 * so the caller decides what a row is; the link comes from `core`'s HotCRP links.
 */
@Composable
fun <T> LazyTable(
    tag: String,
    noun: String,
    rows: List<T>,
    key: (T) -> String,
    columns: List<Col<T>>,
    link: (T) -> String,
    opener: UrlOpener,
    modifier: Modifier = Modifier,
    /** Replaces "open the row's HotCRP page", for tables whose rows are things PC Supervisor owns. */
    onRowClick: ((T) -> Unit)? = null,
    /** Actions on the rows as filtered and sorted right now (a copyable search, a tag draft). */
    toolbar: (@Composable (List<T>) -> Unit)? = null,
) {
    var query by rememberSaveable(tag) { mutableStateOf("") }
    var sort by remember(tag) { mutableStateOf<SortState?>(null) }
    var hidden by remember(tag) { mutableStateOf(columns.filter { !it.visibleByDefault }.map { it.id }.toSet()) }
    var chooserOpen by remember(tag) { mutableStateOf(false) }
    val shown = columns.filter { it.id !in hidden }
    val view = remember(rows, shown.map { it.id }, query, sort) { TableLogic.sort(TableLogic.filter(rows, shown, query), shown, sort) }

    Column(modifier.testTag(tag)) {
        Row(
            Modifier.fillMaxWidth().padding(bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Box(Modifier.width(280.dp).background(MaterialTheme.colorScheme.surfaceVariant).padding(8.dp)) {
                if (query.isEmpty()) Text("Filter $noun", color = MaterialTheme.colorScheme.secondary, style = MaterialTheme.typography.bodyMedium)
                BasicTextField(query, {
                    query = it
                }, Modifier.fillMaxWidth().testTag(TableTags.FILTER), singleLine = true, textStyle = MaterialTheme.typography.bodyMedium)
            }
            Box {
                OutlinedButton({ chooserOpen = true }, Modifier.testTag(TableTags.COLUMNS_BUTTON)) { Text("Columns") }
                DropdownMenu(chooserOpen, { chooserOpen = false }) {
                    columns.forEach { c ->
                        Row(
                            Modifier.clickable {
                                hidden =
                                    if (c.id in
                                        hidden
                                    ) {
                                        hidden - c.id
                                    } else {
                                        hidden + c.id
                                    }
                            }.padding(horizontal = 8.dp).testTag(TableTags.toggle(c.id)),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(c.id !in hidden, null)
                            Text(c.title, Modifier.padding(start = 8.dp), style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }
            val count = if (view.size == rows.size) "${rows.size} $noun" else "${view.size} of ${rows.size} $noun"
            Text(count, Modifier.testTag(TableTags.COUNT), style = MaterialTheme.typography.bodyMedium)
            toolbar?.invoke(view)
        }
        Column(Modifier.fillMaxSize().horizontalScroll(rememberScrollState())) {
            Row(Modifier.background(MaterialTheme.colorScheme.surfaceVariant).padding(vertical = 6.dp)) {
                shown.forEach { c ->
                    val arrow = sort?.takeIf { it.column == c.id }?.let { if (it.ascending) " ▲" else " ▼" }.orEmpty()
                    val base = Modifier.width(c.widthDp.dp).padding(horizontal = 8.dp).testTag(TableTags.header(c.id))
                    Text(
                        c.title + arrow,
                        if (c.sort != null) base.clickable { sort = (sort ?: SortState(c.id, false)).next(c.id) } else base,
                        style = MaterialTheme.typography.labelLarge,
                        maxLines = 1,
                    )
                }
            }
            LazyColumn(Modifier.fillMaxSize()) {
                items(view, key = key) { r ->
                    val k = key(r)
                    Row(
                        Modifier.clickable {
                            if (onRowClick != null) onRowClick(r) else opener.open(link(r))
                        }.padding(vertical = 5.dp).testTag(TableTags.row(k)).semantics { contentDescription = link(r) },
                    ) {
                        shown.forEach { c ->
                            val m = Modifier.width(c.widthDp.dp).padding(horizontal = 8.dp)
                            if (c.masked) {
                                MaskedText(c.text(r), TableTags.cell(k, c.id), m, widthDp = c.widthDp - 16)
                            } else if (c.chart != null) {
                                Box(m) {
                                    c.chart.invoke(r)
                                    Text(
                                        c.text(r),
                                        Modifier.testTag(TableTags.cell(k, c.id)),
                                        color = Color.Transparent,
                                        maxLines = 1,
                                        style = MaterialTheme.typography.bodyMedium,
                                    )
                                }
                            } else {
                                Text(c.text(r), m.testTag(TableTags.cell(k, c.id)), maxLines = 1, style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                    HorizontalDivider(color = Color(0xFFE3E6EB))
                }
            }
        }
    }
}
