package net.jonbell.pcs.app

import androidx.compose.ui.test.ExperimentalTestApi
import net.jonbell.pcs.app.testing.AppDriver
import net.jonbell.pcs.app.testing.MapKeychain
import net.jonbell.pcs.app.testing.RecordingOpener
import net.jonbell.pcs.app.testing.ViewReader
import net.jonbell.pcs.app.testing.runUi
import net.jonbell.pcs.app.testing.screenshot
import net.jonbell.pcs.core.imports.ImportKind
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.secrets.Accounts
import net.jonbell.pcs.core.time.Clock
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
import java.time.Instant

/**
 * The assignment screen over a mirror built by hand (no harness): three papers, three seniors and a junior on the PC, paper 2 in
 * conflict with two of the seniors. What the screen lists comes from the fixture's table (which paper cannot meet its composition and why,
 * how many CSV rows the plan has), never from the app's own computation.
 */
@Tag("ui")
@Family("T12")
@OptIn(ExperimentalTestApi::class)
class AssignmentUiTest {
    private fun conference(dir: Path, answers: String, withScores: Boolean = true, juniors: List<String> = listOf("j1"), extraConf: String = ""): Shell {
        val kc = MapKeychain().also { it.write(Accounts.dbKey("asg"), "test-only-key") }
        MirrorFixture.build(dir.resolve("asg.db"), "test-only-key") {
            (1L..3).forEach { paper(it, title = "Synthetic paper $it") }
            val people = listOf("s1", "s2", "s3") + juniors
            people.forEach { e ->
                store.conn.createStatement().use {
                    it.executeUpdate("INSERT INTO person(email,name,roles,tags,first_seen_at,last_seen_at) VALUES('$e@example.org','$e','[]','[]',0,0)")
                }
            }
            store.conn.createStatement().use { it.executeUpdate("UPDATE paper SET pc_conflicts = '{\"s1@example.org\":1,\"s2@example.org\":1}' WHERE pid = 2") }
            // the AC of paper 1 and the sheet that makes j1 a junior (an unauthorised decision would be treated as pending)
            store.conn.createStatement().use {
                it.executeUpdate(
                    "INSERT INTO review(rid,pid,email,rtype,status,scores,word_count,ratings,first_seen_at,last_seen_at) VALUES(900,1,'ac@example.org',5,'draft','{}',0,'[]',0,0)",
                )
            }
            val clock = Clock { Instant.parse("2030-01-01T00:00:00Z") }
            Imports(store, clock).import(
                ImportKind.APPOINTMENTS,
                (
                    "email,origin,nominated_by,area,ac_email,decision,tier,consent,on_pc_at\n" +
                        juniors.joinToString("") { "$it@example.org,invited,,x,ac@example.org,accept,junior,yes,\n" }
                ).toByteArray(),
                "sheet.csv",
            )
            if (withScores) {
                val csv =
                    "paper,email,score\n" +
                        (1..3).flatMap { p -> people.mapIndexed { i, e -> "$p,$e@example.org,${"%.2f".format(0.9 - 0.05 * i)}" } }.joinToString("\n") +
                        "\n"
                Imports(store, clock).import(ImportKind.TPMS_SCORES, csv.toByteArray(), "scores.csv")
            }
        }.close()
        val a = Files.writeString(dir.resolve("answers.txt"), answers)
        Files.writeString(
            dir.resolve("asg.conf"),
            "PCS_HOTCRP_URL=http://127.0.0.1:1\nPCS_ANSWERS=$a\nPCS_DB_PATH=${dir.resolve(
                "asg.db",
            )}\nPCS_TZ=UTC\nPCS_NOW=2030-02-02T01:00\nPCS_LOAD_SENIOR_MAX=3\nPCS_LOAD_JUNIOR_MAX=3\n$extraConf",
        )
        return Shell(mapOf("PCS_CONFERENCES" to dir.toString()), { kc }, RecordingOpener(), screenshotMode = true)
    }

    @Test
    @Covers("view:assignment", "prop:A1", "prop:A2", "prop:V1")
    fun `the plan per paper, the reason one is short, and the CSV`(
        @TempDir dir: Path,
    ) {
        val shell = conference(dir, "Q13 = one-junior\nQ14 = tier-decides\n")
        runUi {
            setContent { PcsApp(shell) }
            val driver = AppDriver(this)
            val view = ViewReader(this)
            driver.waitFor(Tags.PICKER)
            driver.openConference("asg")
            driver.tab(TabName.Assignment)
            driver.waitFor(AssignmentTags.SUMMARY)
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.exists(TableTags.COUNT) }
            val t = view.table()
            assertEquals(listOf("pid", "status", "seniors", "others", "reason"), t.columnIds)
            assertEquals(listOf("1", "2", "3"), t.keys)
            // the fixture's table: paper 2 has one senior it can use (s3), so it is short by one; the others are composed
            assertEquals(mapOf("1" to "composed", "2" to "short", "3" to "composed"), t.keys.associateWith { t.cell(it, "status")!! })
            assertTrue("2 conflicted" in t.cell("2", "reason")!!, t.cell("2", "reason"))
            assertEquals("", t.cell("1", "reason"))
            assertFalse("s1@example.org" in t.cell("2", "seniors")!! || "s2@example.org" in t.cell("2", "seniors")!!, "a conflicted senior is never planned")
            assertEquals(
                "2 of 3 papers meet their composition; senior seats unfilled 1, other seats unfilled 0; 0 edges forbidden by repair; 8 CSV rows",
                view.text(AssignmentTags.SUMMARY),
            )
            val csv = view.text(AssignmentTags.CSV).lines().filter { it.isNotEmpty() }
            assertEquals("paper,action,email", csv.first())
            assertEquals(8, csv.size - 1)
            assertEquals(listOf(3, 2, 3), (1..3).map { p -> csv.drop(1).count { it.startsWith("$p,") } }, "rows per paper")
            assertTrue(csv.drop(1).none { it.startsWith("2,") && ("s1@" in it || "s2@" in it) })
            assertTrue(view.text(AssignmentTags.SIGNALS).startsWith("none") || view.text(AssignmentTags.SIGNALS).contains("#2"))
            screenshot("assignment/plan")
        }
    }

    @Test
    @Covers("view:assignment", "rule:composition", "q:Q13=zero-to-two-juniors")
    fun `the chair chooses who takes the optional seats, and the plan follows (PCS_JUNIOR_SEATS)`(
        @TempDir dir: Path,
    ) {
        // two PC juniors, three papers, seniors s1 to s3 (paper 2 has only s3): fill gives each paper two juniors, 4 + 3 + 4 CSV rows;
        // when-short stops at three reviewers, 3 + 3 + 3; the juniors are not reciprocal nominees, so reciprocal-only is when-short here
        val shell = conference(dir, "Q13 = zero-to-two-juniors\nQ14 = tier-decides\n", juniors = listOf("j1", "j2"), extraConf = "PCS_JUNIOR_SEATS=fill\n")
        runUi {
            setContent { PcsApp(shell) }
            val driver = AppDriver(this)
            val view = ViewReader(this)
            driver.waitFor(Tags.PICKER)
            driver.openConference("asg")
            driver.tab(TabName.Assignment)
            driver.waitFor(AssignmentTags.SUMMARY)

            fun rows() = Regex("(\\d+) CSV rows").find(view.text(AssignmentTags.SUMMARY))!!.groupValues[1].toInt()

            fun choose(key: String, expectRows: Int) {
                driver.click(AssignmentTags.seatsButton(key))
                waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) {
                    view.exists(AssignmentTags.SUMMARY) &&
                        view.text(AssignmentTags.SEATS_NOTE).startsWith("Selected: $key.")
                }
                waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.exists(AssignmentTags.SUMMARY) && rows() == expectRows }
                assertEquals(expectRows, rows(), key)
            }
            assertTrue(view.text(AssignmentTags.SEATS_NOTE).startsWith("Selected: fill."), "the setting is the starting point")
            assertEquals(11, rows())
            choose("when-short", 9)
            choose("reciprocal-only", 9)
            choose("fill", 11)
            screenshot("assignment/junior-seats")
        }
    }

    @Test
    @Covers("view:assignment")
    fun `the setting is the starting mode of the Assignment tab`(
        @TempDir dir: Path,
    ) {
        val shell =
            conference(dir, "Q13 = zero-to-two-juniors\nQ14 = tier-decides\n", juniors = listOf("j1", "j2"), extraConf = "PCS_JUNIOR_SEATS=when-short\n")
        runUi {
            setContent { PcsApp(shell) }
            val driver = AppDriver(this)
            val view = ViewReader(this)
            driver.waitFor(Tags.PICKER)
            driver.openConference("asg")
            driver.tab(TabName.Assignment)
            driver.waitFor(AssignmentTags.SUMMARY)
            assertTrue(view.text(AssignmentTags.SEATS_NOTE).startsWith("Selected: when-short."))
            assertTrue("9 CSV rows" in view.text(AssignmentTags.SUMMARY), view.text(AssignmentTags.SUMMARY))
        }
    }

    @Test
    @Covers("view:assignment")
    fun `an unresolved Q14 and a missing affinity import block the screen and say why`(
        @TempDir dir: Path,
    ) {
        val shell = conference(dir, "Q13 = one-junior\n", withScores = false)
        runUi {
            setContent { PcsApp(shell) }
            val driver = AppDriver(this)
            val view = ViewReader(this)
            driver.waitFor(Tags.PICKER)
            driver.openConference("asg")
            driver.tab(TabName.Assignment)
            driver.waitFor(AssignmentTags.BLOCKED)
            val text = view.text(AssignmentTags.BLOCKED)
            assertTrue(text.contains("Q14"), text)
            assertFalse(view.exists(AssignmentTags.SUMMARY), "no plan is shown while a question it turns on is open")
        }
    }
}
