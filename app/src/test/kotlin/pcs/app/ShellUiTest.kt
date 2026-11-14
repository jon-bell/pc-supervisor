package pcs.app

import androidx.compose.ui.test.ExperimentalTestApi
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import pcs.app.testing.AppDriver
import pcs.app.testing.Fixtures
import pcs.app.testing.MapKeychain
import pcs.app.testing.ViewReader
import pcs.app.testing.runUi
import pcs.app.testing.screenshot
import pcs.core.readings.Answers
import pcs.core.readings.ModelExport
import pcs.core.readings.QId
import pcs.core.secrets.KeychainException
import pcs.testing.Covers
import pcs.testing.Family
import java.nio.file.Files
import java.nio.file.Path

/** The shell without a HotCRP: unlock, conference picker, settings. */
@Tag("ui")
@Family("T12")
@OptIn(ExperimentalTestApi::class)
class ShellUiTest {
    /** An answers file with every question settled (the first reading of each; which one doesn't matter here). */
    private fun allAnswered() = QId.entries.map { "${it.code} = ${it.readings.first().key}" }

    @Test
    @Covers("view:unlock", "view:picker")
    fun `a keychain that can't be reached is reported, and trying again opens the picker`(
        @TempDir dir: Path,
    ) {
        Fixtures.conference(dir, "conf-a", "https://conf-a.example.org")
        Files.writeString(dir.resolve("conf-b.conf"), "PCS_ANSWERS=${Fixtures.syntheticAnswers}\n")
        var attempts = 0
        val kc = MapKeychain()
        val shell =
            Shell(
                mapOf("PCS_CONFERENCES" to dir.toString()),
                {
                    if (attempts++ == 0) throw KeychainException("the OS keychain is locked") else kc
                },
                screenshotMode = true,
            )
        runUi {
            setContent { PcsApp(shell) }
            val driver = AppDriver(this)
            val view = ViewReader(this)
            driver.waitFor(Tags.UNLOCK_ERROR)
            assertEquals("the OS keychain is locked", view.text(Tags.UNLOCK_ERROR))
            assertFalse(view.exists(Tags.PICKER), "no conference before the keychain opens")
            screenshot("unlock/keychain-locked")
            driver.retryUnlock()
            driver.waitFor(Tags.PICKER)
            assertEquals(2, attempts)
            assertEquals(listOf("conf-a", "conf-b"), view.tagsWith("conference-").filter { it != "picker" && !it.startsWith("problem-") }.sorted())
            // a conference file with a settings problem lists the problem and can't be opened
            assertTrue(view.text(Tags.problem("conf-b")).startsWith("PCS_HOTCRP_URL"), view.text(Tags.problem("conf-b")))
            assertFalse(view.exists(Tags.problem("conf-a")))
            screenshot("picker/two-conferences")
        }
    }

    @Test
    @Covers("view:settings")
    fun `an unresolved question shows on the settings screen with what it blocks`(
        @TempDir dir: Path,
    ) {
        val file = Files.write(dir.resolve("answers.txt"), allAnswered().filterNot { it.startsWith("Q10 ") })
        val parsed = Answers.read(file)
        assertEquals(listOf(QId.Q10), parsed.unresolved, "the fixture leaves exactly Q10 open")
        Fixtures.conference(dir, "settings-conf", "https://conf-a.example.org", answers = file)
        val shell = Shell(mapOf("PCS_CONFERENCES" to dir.toString()), { MapKeychain() }, screenshotMode = true)
        runUi {
            setContent { PcsApp(shell) }
            val driver = AppDriver(this)
            val view = ViewReader(this)
            driver.waitFor(Tags.PICKER)
            driver.openConference("settings-conf")
            driver.tab(TabName.Settings)
            driver.waitFor("answers-summary")
            val s = view.settings()
            assertEquals(QId.entries.size, s.status.size, "every question is listed")
            assertEquals("unresolved", s.status["Q10"])
            assertEquals(QId.entries.filter { it != QId.Q10 }.toSet(), s.status.filterValues { it != "unresolved" }.keys.map { QId.ofCode(it)!! }.toSet())
            assertEquals("${QId.entries.size - 1} of ${QId.entries.size} questions answered, 1 unresolved", s.summary)
            // card X1 ("a paper names no nominee") turns on Q10 in the model's export; the screen must say so, and only for Q10
            val expectedBlocked = ModelExport.blocked(parsed).single().cards.map { "card-${it.id}" }
            assertTrue("card-X1" in expectedBlocked)
            assertEquals(setOf("Q10"), s.blocks.keys)
            assertTrue(s.blocks.getValue("Q10").containsAll(expectedBlocked.toSet()))
            assertEquals(expectedBlocked.size, s.blocks.getValue("Q10").count { it.startsWith("card-") })
            screenshot("settings/q10-unresolved")
        }
    }

    @Test
    @Covers("view:settings")
    fun `a complete answers file blocks nothing`(
        @TempDir dir: Path,
    ) {
        val file = Files.write(dir.resolve("answers.txt"), allAnswered())
        Fixtures.conference(dir, "complete", "https://conf-a.example.org", answers = file)
        val shell = Shell(mapOf("PCS_CONFERENCES" to dir.toString()), { MapKeychain() }, screenshotMode = true)
        runUi {
            setContent { PcsApp(shell) }
            val driver = AppDriver(this)
            driver.waitFor(Tags.PICKER)
            driver.openConference("complete")
            driver.tab(TabName.Settings)
            driver.waitFor("answers-summary")
            val s = ViewReader(this).settings()
            assertTrue(s.blocks.isEmpty(), "nothing is blocked: ${s.blocks}")
            assertTrue(s.status.values.none { it == "unresolved" })
        }
    }
}
