package net.jonbell.pcs.app

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import net.jonbell.pcs.app.testing.AppDriver
import net.jonbell.pcs.app.testing.Fixtures
import net.jonbell.pcs.app.testing.MapKeychain
import net.jonbell.pcs.app.testing.RecordingOpener
import net.jonbell.pcs.app.testing.ViewReader
import net.jonbell.pcs.app.testing.runUi
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.Tables
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import net.jonbell.pcs.testing.Measurements
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

/**
 * T9, PLAN M19: render and filter times of the main tables on the store the runner's `ScaleTest` left behind (4,000 papers). Measured
 * in-process on the semantics clock: the time from the click that opens a tab to the full row count on screen, and the time of each
 * keystroke of a filter from the input to an idle UI. No screenshot is involved. Each run is a fresh window (the first one is cold), and a
 * filter sample is the slowest keystroke of one typed query. Records go next to the runner's, for `lake exe check-evidence`.
 */
@Tag("scale")
@Family("T9")
@Covers("prop:Q1")
@OptIn(ExperimentalTestApi::class)
class ScaleUiTest {
    private val repo: Path = Path.of(System.getProperty("pcs.repoRoot"))
    private val scaleDir: Path = Path.of(System.getProperty("pcs.scaleDir"))
    private val key = "scale-only-not-secret"

    private fun ms(from: Long) = (System.nanoTime() - from) / 1_000_000

    @Test
    fun `render and filter times of the papers and reviews tables`() {
        val db = scaleDir.resolve("scale.db")
        assertTrue(Files.exists(db), "run the runner's scaleTest first: no store at $db")
        val (papers, reviews) = Store.open(db, key).use { Tables.papers(it).size to Tables.reviews(it).size }
        val conferences = scaleDir.resolve("ui-conferences").also { Files.createDirectories(it) }
        Files.writeString(
            conferences.resolve("scale.conf"),
            "PCS_HOTCRP_URL=http://127.0.0.1:1\nPCS_ANSWERS=${Fixtures.completeAnswers}\nPCS_DB_PATH=$db\nPCS_TZ=UTC\nPCS_NOW=2030-02-26T12:00:00\n",
        )
        val budgets = Measurements.budgets(repo)
        val runs = System.getenv("PCS_SCALE_RUNS")?.toIntOrNull() ?: budgets.runs
        val samples =
            linkedMapOf(
                "table.papers.render" to mutableListOf<Long>(),
                "table.papers.filter" to mutableListOf(),
                "table.reviews.render" to mutableListOf(),
                "table.reviews.filter" to mutableListOf(),
            )
        val keystrokes = linkedMapOf<String, MutableList<Long>>("papers" to mutableListOf(), "reviews" to mutableListOf())
        repeat(runs) { run ->
            val shell = Shell(mapOf("PCS_CONFERENCES" to conferences.toString(), "PCS_DB_KEY" to key), { MapKeychain() }, RecordingOpener())
            runUi {
                setContent { PcsApp(shell) }
                val driver = AppDriver(this)
                val view = ViewReader(this)
                driver.waitFor(Tags.PICKER)

                fun typeQuery(table: String, query: String) {
                    driver.waitFor(TableTags.FILTER)
                    val per = mutableListOf<Long>()
                    for (ch in query) {
                        val t0 = System.nanoTime()
                        onNodeWithTag(TableTags.FILTER).performTextInput(ch.toString())
                        waitForIdle()
                        per += ms(t0)
                    }
                    keystrokes.getValue(table) += per
                    samples.getValue("table.$table.filter") += per.max()
                    onNodeWithTag(TableTags.FILTER).performTextClearance()
                    waitForIdle()
                }

                // the Papers tab is the one a conference opens on
                var t0 = System.nanoTime()
                driver.openConference("scale")
                waitUntil(timeoutMillis = 300_000) {
                    onAllNodes(hasTestTag(TableTags.COUNT)).fetchSemanticsNodes().isNotEmpty() &&
                        view.text(TableTags.COUNT) == "$papers papers"
                }
                waitForIdle()
                samples.getValue("table.papers.render") += ms(t0)
                typeQuery("papers", "synthetic paper 17")

                t0 = System.nanoTime()
                driver.tab(TabName.Reviews)
                waitUntil(timeoutMillis = 300_000) {
                    onAllNodes(hasTestTag(TableTags.COUNT)).fetchSemanticsNodes().isNotEmpty() &&
                        view.text(TableTags.COUNT) == "$reviews reviews"
                }
                waitForIdle()
                samples.getValue("table.reviews.render") += ms(t0)
                typeQuery("reviews", "sen1 complete")
            }
            println("scale ui: run ${run + 1}: ${samples.mapValues { it.value.last() }}")
        }
        val env = Measurements.environment(mapOf("display" to (System.getenv("DISPLAY") ?: "none"), "windowPx" to "1280x1400, density 1.0"))
        val prov = Measurements.provenance(repo)
        for ((metric, s) in samples) {
            val table = metric.removePrefix("table.").substringBefore('.')
            Measurements.record(
                scaleDir.resolve("records"),
                metric,
                budgets[metric],
                s,
                budgets.runs,
                Measurements.jsonOf(
                    mapOf(
                        "scenario" to "scale (seed/Generated.SCALE, fixed seed 20301), the store of the runner's ScaleTest",
                        "rows" to if (table == "papers") papers else reviews,
                        "runs" to runs,
                        "unit" to
                            if (metric.endsWith(
                                    "render",
                                )
                            ) {
                                "click on the tab to the full row count on screen"
                            } else {
                                "slowest keystroke of one typed query, input to idle UI"
                            },
                        "medianKeystrokeMs" to keystrokes.getValue(table).sorted().let { it[it.size / 2] },
                        "keystrokesMeasured" to keystrokes.getValue(table).size,
                    ),
                ),
                listOf("prop:Q1"),
                env,
                prov,
            )
            println("scale ui: $metric samples=$s budget=${budgets[metric].ms} ms")
        }
    }
}
