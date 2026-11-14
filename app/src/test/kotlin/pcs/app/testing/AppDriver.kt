package pcs.app.testing

import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.click
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.isRoot
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performMouseInput
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.waitUntilExactlyOneExists
import pcs.app.TabName
import pcs.app.TableTags
import pcs.app.Tags
import pcs.app.WritebackTags

/**
 * The app driver (PLAN §A4): the chair's actions, performed through test tags on the semantics tree.
 * Nothing here reaches into the app's state; if a chair can't do it with a click or typing, it isn't here.
 */
@OptIn(ExperimentalTestApi::class)
class AppDriver(private val ui: ComposeUiTest) {
    fun click(tag: String) {
        ui.waitUntilExactlyOneExists(hasTestTag(tag), TIMEOUT_MS)
        ui.onNodeWithTag(tag).performClick()
        ui.waitForIdle()
    }

    fun waitFor(tag: String) = ui.waitUntilExactlyOneExists(hasTestTag(tag), TIMEOUT_MS)

    fun retryUnlock() = click(Tags.RETRY)

    fun openConference(id: String) = click(Tags.conference(id))

    fun tab(t: TabName) = click(Tags.tab(t.name))

    /** Presses "Sync now" and waits for the status line to say how it ended. */
    fun syncNow() {
        click(Tags.SYNC_NOW)
        ui.waitUntil(timeoutMillis = TIMEOUT_MS) {
            ui.onAllNodes(hasTestTag(Tags.SYNC_STATUS), useUnmergedTree = true).fetchSemanticsNodes().any { n ->
                ViewReader.textOf(n).let { it.startsWith("Synced") || it.startsWith("Sync failed") }
            }
        }
    }

    fun filter(text: String) {
        waitFor(TableTags.FILTER)
        ui.onNodeWithTag(TableTags.FILTER).performTextInput(text)
        ui.waitForIdle()
    }

    fun clearFilter() {
        waitFor(TableTags.FILTER)
        ui.onNodeWithTag(TableTags.FILTER).performTextClearance()
        ui.waitForIdle()
    }

    fun sortBy(column: String) = click(TableTags.header(column))

    fun openColumnChooser() = click(TableTags.COLUMNS_BUTTON)

    /** A click outside the chooser closes it, as it would for a chair. */
    fun closeColumnChooser() {
        ui.onAllNodes(isRoot()).onLast().performMouseInput { this.click(Offset(WINDOW_WIDTH - 5f, WINDOW_HEIGHT - 5f)) }
        ui.waitForIdle()
    }

    fun toggleColumn(column: String) = click(TableTags.toggle(column))

    fun clickRow(key: String) = click(TableTags.row(key))

    fun copySearch() = click(Tags.COPY_SEARCH)

    fun draftAttention() = click(Tags.DRAFT_ATTENTION)

    fun dryRun() = click(WritebackTags.DRY_RUN)

    fun confirmAndApply() = click(WritebackTags.CONFIRM_APPLY)

    companion object {
        const val TIMEOUT_MS = 90_000L
    }
}
