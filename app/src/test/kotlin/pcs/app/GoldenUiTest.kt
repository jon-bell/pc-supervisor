package pcs.app

import androidx.compose.ui.test.ExperimentalTestApi
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import pcs.app.testing.AppDriver
import pcs.app.testing.Fixtures
import pcs.app.testing.MapKeychain
import pcs.app.testing.RecordingOpener
import pcs.app.testing.ViewReader
import pcs.app.testing.runUi
import pcs.app.testing.screenshot
import pcs.core.hotcrp.HotcrpClient
import pcs.core.hotcrp.PaperRecord
import pcs.core.hotcrp.Review
import pcs.testing.Covers
import pcs.testing.Family
import java.nio.file.Path

/**
 * The app on the harness's synced `golden` scenario (PLAN M4 done-when). Expected observations
 * come from HotCRP itself (the pids, titles, and review ordinals through the API) and from the
 * golden table in PLAN.md (merit of each paper); the app's own tables are never the oracle.
 */
@Tag("ui")
@Tag("harness")
@Family("T12")
@OptIn(ExperimentalTestApi::class)
class GoldenUiTest {
    /** Merit of the complete non-AC reviews, ascending, for the golden rows whose table entry fixes them (PLAN, golden scenario). */
    private val goldenMerits = mapOf(1L to "3 3 4", 3L to "2 4 4", 4L to "2 4 4", 5L to "2 2 2", 6L to "4 4 4", 8L to "3 3 4", 11L to "2 2 2", 12L to "2 4 4")

    private fun hotcrp(): Triple<String, List<PaperRecord>, List<Review>> {
        val (url, token) = Fixtures.harness()
        return HotcrpClient(url, token).use { c ->
            runBlocking {
                val pids = c.paperIds()
                Triple(url.toString(), c.papers(pids), c.reviews(pids))
            }
        }
    }

    @Test
    @Covers("view:papers", "view:reviews")
    fun `the app opens synced golden, shows the paper table, and resolves HotCRP's page for pid 4`(
        @TempDir dir: Path,
    ) {
        val (url, token) = Fixtures.harness()
        val (_, papers, reviews) = hotcrp()
        assertTrue(papers.size >= 13, "golden has at least 13 papers, found ${papers.size}")
        Fixtures.conference(dir, "golden", url.toString())
        val opener = RecordingOpener()
        val shell = Shell(mapOf("PCS_CONFERENCES" to dir.toString(), "PCS_HOTCRP_TOKEN" to token), { MapKeychain() }, opener, screenshotMode = true)
        runUi {
            setContent { PcsApp(shell) }
            val driver = AppDriver(this)
            val view = ViewReader(this)
            driver.waitFor(Tags.PICKER)
            driver.openConference("golden")
            driver.waitFor(Tags.SYNC_NOW)
            assertEquals("never", view.text(Tags.LAST_SYNC), "a new conference has not synced")
            driver.syncNow()
            assertTrue(view.text(Tags.SYNC_STATUS).startsWith("Synced"), view.text(Tags.SYNC_STATUS))
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.text(Tags.LAST_SYNC) != "never" }

            // the paper table, in both directions: every paper HotCRP has is on the screen, and nothing else
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.exists(TableTags.COUNT) && view.text(TableTags.COUNT) == "${papers.size} papers" }
            val byPid = papers.sortedBy { it.pid }
            val t = view.table()
            assertEquals(byPid.map { it.pid.toString() }, t.keys, "rows are the papers, by pid")
            assertEquals(listOf("pid", "title", "status", "acs", "reviews", "merits", "comments", "activity"), t.columnIds, "default columns")
            byPid.forEach { assertEquals(it.title.orEmpty(), t.cell(it.pid.toString(), "title"), "title of pid ${it.pid}") }
            goldenMerits.forEach { (pid, merits) -> assertEquals(merits, t.cell(pid.toString(), "merits"), "merit of pid $pid") }
            assertEquals("2/3", t.cell("2", "reviews"), "pid 2 has two of three reviews in")
            assertEquals("3/3", t.cell("4", "reviews"))
            screenshot("golden/papers")

            // a row opens its HotCRP page in the system browser (the opener records it; no browser starts)
            driver.clickRow("4")
            assertEquals(listOf("$url/paper/4"), opener.opened)

            // filter: papers whose title or any visible column has the word; compare with HotCRP's titles
            val word = byPid.first { it.pid == 4L }.title!!.split(" ").maxBy { it.length }
            driver.filter(word)
            val expected = byPid.filter { p -> p.title.orEmpty().contains(word, ignoreCase = true) }.map { it.pid.toString() }
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.table().keys == expected }
            assertTrue("4" in expected)
            driver.clearFilter()
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.table().keys.size == papers.size }

            // sort by pid: first click ascending, second descending
            driver.sortBy("pid")
            assertEquals(byPid.map { it.pid.toString() }, view.table().keys)
            driver.sortBy("pid")
            assertEquals(byPid.map { it.pid.toString() }.reversed(), view.table().keys)
            assertTrue(view.table().headers.first { it.first == "pid" }.second == "#")

            // column chooser: add Tags, drop Comments
            driver.openColumnChooser()
            driver.toggleColumn("tags")
            driver.toggleColumn("comments")
            driver.closeColumnChooser()
            val columns = view.table().columnIds
            assertTrue("tags" in columns)
            assertFalse("comments" in columns)

            // the review table links to /review/{pid}{ordinal}
            val chosen = reviews.filter { it.ordinal != null }.minWith(compareBy({ it.pid }, { it.ordinal }))
            driver.tab(TabName.Reviews)
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.exists(TableTags.COUNT) && !view.text(TableTags.COUNT).startsWith("0 ") }
            assertEquals("${reviews.size} reviews", view.text(TableTags.COUNT))
            assertTrue(view.table().keys.all { it in reviews.map { r -> r.rid.toString() } }, "every row shown is a review HotCRP has")
            screenshot("golden/reviews")
            opener.opened.clear()
            driver.clickRow(chosen.rid.toString())
            assertEquals(listOf("$url/review/${chosen.pid}${chosen.ordinal}"), opener.opened)
        }
    }
}
