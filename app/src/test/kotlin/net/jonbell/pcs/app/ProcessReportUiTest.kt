package net.jonbell.pcs.app

import androidx.compose.ui.test.ExperimentalTestApi
import net.jonbell.pcs.app.testing.AppDriver
import net.jonbell.pcs.app.testing.MapKeychain
import net.jonbell.pcs.app.testing.RecordingOpener
import net.jonbell.pcs.app.testing.ViewReader
import net.jonbell.pcs.app.testing.runUi
import net.jonbell.pcs.core.secrets.Accounts
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import net.jonbell.pcs.testing.MirrorFixture
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

/** The Process report tab over a mirror built by hand (no harness): the sections show, and the two actions write files or say why not. */
@Tag("ui")
@Family("T12")
@OptIn(ExperimentalTestApi::class)
class ProcessReportUiTest {
    private fun conference(dir: Path, extra: String): Shell {
        val answers = Files.writeString(dir.resolve("answers.txt"), "Q15 = reject-or-weak\nQ16 = bump-window\n")
        val kc = MapKeychain().also { it.write(Accounts.dbKey("pr"), "test-only-key") }
        MirrorFixture.build(dir.resolve("pr.db"), "test-only-key") {
            paper(1)
            review(1, "ra", Triple(10L, 3, "complete"))
            review(1, "rb", Triple(11L, 2, "complete"))
            comment(1, "ra", 20)
        }.close()
        Files.writeString(
            dir.resolve("pr.conf"),
            "PCS_HOTCRP_URL=http://127.0.0.1:1\nPCS_ANSWERS=$answers\nPCS_DB_PATH=${dir.resolve("pr.db")}\nPCS_TZ=UTC\nPCS_NOW=2030-02-26T12:00\n$extra\n",
        )
        return Shell(mapOf("PCS_CONFERENCES" to dir.toString()), { kc }, RecordingOpener(), screenshotMode = true)
    }

    private fun run(dir: Path, extra: String, press: String): String {
        System.setProperty("pcs.exportDir", dir.resolve("exports").toString())
        val shell = conference(dir, extra)
        var status = ""
        try {
            runUi {
                setContent { PcsApp(shell) }
                val driver = AppDriver(this)
                val view = ViewReader(this)
                driver.waitFor(Tags.PICKER)
                driver.openConference("pr")
                driver.tab(TabName.ProcessReport)
                driver.waitFor(ProcessReportTags.SCREEN)
                listOf("overview", "nominations", "screening", "assignment", "progress", "accountability", "early-reject", "discussion").forEach {
                    waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.exists(ProcessReportTags.section(it)) }
                }
                driver.click(press)
                driver.waitFor(ProcessReportTags.STATUS)
                status = view.text(ProcessReportTags.STATUS)
            }
        } finally {
            System.clearProperty("pcs.exportDir")
        }
        return status
    }

    @Test
    @Covers("prop:C3")
    fun `saving the report writes Markdown and HTML, and the export without a key writes nothing and says why`(
        @TempDir dir: Path,
    ) {
        val a = Files.createDirectories(dir.resolve("a"))
        val saved = run(a, "", ProcessReportTags.SAVE)
        assertTrue(saved.startsWith("Saved process-report.md, process-report.html"), saved)
        val out = a.resolve("exports/pr")
        assertTrue(Files.readString(out.resolve("process-report.md")).contains("## Reviewing progress"))
        assertTrue(Files.exists(out.resolve("process-report.html")))

        val b = Files.createDirectories(dir.resolve("b"))
        val none = run(b, "", ProcessReportTags.EXPORT)
        assertTrue(none.startsWith("No pseudonym key"), none)
        assertFalse(Files.exists(b.resolve("exports")), "nothing written without a key")

        val c = Files.createDirectories(dir.resolve("c"))
        val done = run(c, "PCS_PSEUDONYM_KEY=ui-test-key-0123456789", ProcessReportTags.EXPORT)
        assertEquals("Exported 4 pseudonymous tables to ${c.resolve("exports/pr")}", done)
        val reviews = Files.readString(c.resolve("exports/pr/reviews.csv"))
        assertFalse("example.org" in reviews || "ra@" in reviews, "no email in the export")
        assertEquals(3, reviews.lines().filter { it.isNotBlank() }.size, "a header and two reviews")
    }
}
