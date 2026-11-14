package pcs.app

import androidx.compose.ui.test.ExperimentalTestApi
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import pcs.app.testing.AppDriver
import pcs.app.testing.MapKeychain
import pcs.app.testing.RecordingOpener
import pcs.app.testing.ViewReader
import pcs.app.testing.runUi
import pcs.app.testing.screenshot
import pcs.core.secrets.Accounts
import pcs.core.store.Store
import pcs.testing.AccFixture
import pcs.testing.Covers
import pcs.testing.Family
import java.nio.file.Files
import java.nio.file.Path
import java.time.Duration
import java.time.Instant

/**
 * The reviewing and accountability screen over a mirror built by hand (no harness). The review deadline is 2030-03-01 00:00 UTC.
 * What each section lists comes from the fixture's table below, never from the app's own computation: who is outstanding and
 * late, which junior and nominee reviews are thin, which suggestions the metadata gives, when a reminder and a "no reply" become
 * available (card C3), and that a dismissal changes nothing on the engagement record (card C4).
 */
@Tag("ui")
@Family("T12")
@OptIn(ExperimentalTestApi::class)
class AccountabilityUiTest {
    private val due = Instant.parse("2030-03-01T00:00:00Z")

    private fun at(h: Long) = due.plus(Duration.ofHours(h))

    private val history: AccFixture.() -> Unit = {
        person("sen@example.org", "Sam Senior")
        person("jun@example.org", "Jo Junior", tags = listOf("junior"))
        person("nom@example.org", "Nia Nominee", tags = listOf("junior", "nominee"))
        person("ac@example.org", "Alex AC")
        paper(1)
        paper(2)
        review(1, "ac@example.org", rtype = 5)
        review(1, "sen@example.org", ordinal = "A", words = 400)
        review(1, "jun@example.org", ordinal = "B", words = 60, merit = 1)
        review(1, "nom@example.org", ordinal = "C", status = "draft", firstCompleteAt = null)
        review(2, "ac@example.org", rtype = 5)
        review(2, "sen@example.org", ordinal = "A", words = 500, merit = 4)
        review(2, "jun@example.org", ordinal = "B", words = 200, ratings = listOf("short", "vague"))
        review(2, "nom@example.org", ordinal = "C", words = 90)
    }

    private fun conference(dir: Path, now: Instant, extra: AccFixture.() -> Unit): Shell {
        val answers = Files.writeString(dir.resolve("answers.txt"), "Q20 = yes\nQ11 = reject-own-papers\nQ21 = this-conference\n")
        val kc = MapKeychain().also { it.write(Accounts.dbKey("acc"), "test-only-key") }
        val db = dir.resolve("acc.db")
        if (!Files.exists(db)) {
            Store.open(db, "test-only-key").also {
                AccFixture(it).history()
                AccFixture(it).extra()
            }.close()
        }
        Files.writeString(
            dir.resolve("acc.conf"),
            "PCS_HOTCRP_URL=http://127.0.0.1:1\nPCS_ANSWERS=$answers\nPCS_DB_PATH=$db\nPCS_TZ=UTC\nPCS_NOW=${now.toString().removeSuffix("Z")}\n" +
                "PCS_PHASE_REVIEW_DUE=2030-03-01T00:00\nPCS_TIER_TAGS=junior=junior,nominee=nominee\n" +
                "PCS_CRITERION_1=backs each weakness with evidence [thin]\nPCS_CRITERION_2=tells the authors what would change the reviewer's mind [thin,rated]\n",
        )
        return Shell(mapOf("PCS_CONFERENCES" to dir.toString(), "PCS_HOTCRP_TOKEN" to "test-only-token"), { kc }, RecordingOpener(), screenshotMode = true)
    }

    private fun session(
        dir: Path,
        now: Instant,
        extra: AccFixture.() -> Unit = {
        },
        block: (AppDriver, ViewReader, androidx.compose.ui.test.ComposeUiTest) -> Unit,
    ) {
        val shell = conference(dir, now, extra)
        runUi {
            setContent { PcsApp(shell) }
            val driver = AppDriver(this)
            val view = ViewReader(this)
            driver.waitFor(Tags.PICKER)
            driver.openConference("acc")
            driver.tab(TabName.Accountability)
            driver.waitFor(AccTags.section("progress"))
            block(driver, view, this)
        }
    }

    private fun section(d: AppDriver, name: String) = d.click(AccTags.section(name))

    @Test
    @Covers("view:accountability")
    fun `progress by tier, with the nominee view, and the coaching queue`(
        @TempDir dir: Path,
    ) {
        session(dir, at(24)) { d, v, ui ->
            d.waitFor(AccTags.row("progress", "senior"))
            assertEquals("senior: 1 reviewers, 2 assigned, 2 submitted, 0 outstanding, 0 late", v.text(AccTags.row("progress", "senior")))
            assertEquals("junior: 1 reviewers, 2 assigned, 2 submitted, 0 outstanding, 0 late", v.text(AccTags.row("progress", "junior")))
            assertEquals("nominee: 1 reviewers, 2 assigned, 1 submitted, 1 outstanding, 1 late", v.text(AccTags.row("progress", "nominee")))
            assertEquals(listOf("1-nom@example.org"), v.tagsWith("acc-nominee-row-"))
            assertEquals("#1C Nia Nominee: draft, 1 day(s) late", v.text(AccTags.row("nominee", "1-nom@example.org")))
            ui.screenshot("accountability/progress")
            section(d, "coaching")
            d.waitFor(AccTags.row("coaching", "1B"))
            assertEquals(listOf("1B", "2B", "2C"), v.tagsWith("acc-coaching-row-"))
            assertEquals("#1B Jo Junior (junior), 60 words", v.text(AccTags.row("coaching", "1B")))
            ui.screenshot("accountability/coaching")
        }
    }

    @Test
    @Covers("view:accountability", "card:C4", "prop:AR4", "card:C1")
    fun `a suggestion cites the list, a dismissal changes nothing on the record and persists, and a draft names no review text`(
        @TempDir dir: Path,
    ) {
        session(dir, at(24)) { d, v, ui ->
            section(d, "suggestions")
            d.waitFor(AccTags.row("suggestions", "1B"))
            assertEquals(listOf("1B", "2B", "2C"), v.tagsWith("acc-suggestions-row-"))
            assertTrue(v.text(AccTags.row("suggestions", "1B")).endsWith("criteria 1, 2"), v.text(AccTags.row("suggestions", "1B")))
            d.click(AccTags.action("draft", "1B"))
            d.waitFor(AccTags.DRAFT_BODY)
            val body = v.text(AccTags.DRAFT_BODY)
            assertTrue(body.contains("1. backs each weakness with evidence") && body.contains("2. tells the authors") && body.contains("%NUMBER%"), body)
            assertEquals("1", v.text(AccTags.DRAFT_SEARCH))
            ui.screenshot("accountability/draft")
            d.click(AccTags.action("record-sent", "1B"))
            d.waitFor(AccTags.STATUS)
            assertTrue(v.text(AccTags.STATUS).startsWith("Request sent for #1B: drafted Writeback artifact #"), v.text(AccTags.STATUS))
            d.click(AccTags.action("dismiss", "2B"))
            d.waitFor(AccTags.STATUS)
            assertEquals("Dismissed #2B. Nothing was written to HotCRP, and the reviewer's record is unchanged.", v.text(AccTags.STATUS))
            assertFalse(v.exists(AccTags.row("suggestions", "2B")))
            section(d, "engagement")
            assertEquals(emptyList<String>(), v.tagsWith("acc-engagement-row-"), "a dismissal leaves no engagement record")
        }
        // the dismissal is this machine's, and survives a restart
        session(dir, at(25)) { d, v, _ ->
            section(d, "suggestions")
            d.waitFor(AccTags.row("suggestions", "2C"))
            assertFalse(v.exists(AccTags.row("suggestions", "2B")))
        }
    }

    @Test
    @Covers("view:accountability", "card:C3", "prop:AR5")
    fun `the reminder and no reply become available only after the due date, the reminder and the grace period`(
        @TempDir dir: Path,
    ) {
        val sent = due.epochSecond
        val reminded = at(50).epochSecond
        val extra: AccFixture.() -> Unit = {
            tagSeen(1, "pcs-req-B1", "0", sent)
            tagSeen(1, "pcs-remind-B1", "0", reminded)
            setTags(1, listOf("pcs-req-B1#0", "pcs-remind-B1"))
            tagSeen(2, "pcs-req-C1", "0", sent)
            setTags(2, listOf("pcs-req-C1#0"))
        }
        // +10 h: nothing is late; +60 h: 2C may be reminded; 1B was reminded at +50 h but its grace runs to +96 h
        session(dir.resolve("a").also { Files.createDirectories(it) }, at(10), extra) { d, v, _ ->
            section(d, "requests")
            d.waitFor(AccTags.row("requests", "1B1"))
            assertFalse(v.exists(AccTags.action("remind", "2C1")))
            assertFalse(v.exists(AccTags.action("no_reply", "1B1")))
        }
        session(dir.resolve("b").also { Files.createDirectories(it) }, at(60), extra) { d, v, ui ->
            section(d, "requests")
            d.waitFor(AccTags.row("requests", "2C1"))
            assertTrue(v.exists(AccTags.action("remind", "2C1")), "a reminder is available after the due date")
            assertFalse(v.exists(AccTags.action("remind", "1B1")), "1B was already reminded")
            assertFalse(v.exists(AccTags.action("no_reply", "1B1")), "inside the grace period")
            assertTrue(
                v.text(AccTags.row("requests", "1B1")).contains("no reply can be recorded after 2030-03-05 00:00 UTC"),
                v.text(AccTags.row("requests", "1B1")),
            )
            ui.screenshot("accountability/requests")
        }
        session(dir.resolve("c").also { Files.createDirectories(it) }, at(97), extra) { d, v, _ ->
            section(d, "requests")
            d.waitFor(AccTags.row("requests", "1B1"))
            assertTrue(v.exists(AccTags.action("no_reply", "1B1")), "no reply after the due date, the reminder and the grace period")
            assertFalse(v.exists(AccTags.action("no_reply", "2C1")), "2C was never reminded")
        }
    }

    @Test
    @Covers("view:accountability", "card:C1", "card:C2", "card:C7", "card:X10", "prop:V4")
    fun `the engagement record counts dispositions, and one case lists a nominee's papers`(
        @TempDir dir: Path,
    ) {
        val extra: AccFixture.() -> Unit = {
            tagSeen(1, "pcs-req-B1", "1", 10)
            tagSeen(2, "pcs-req-B1", "3", 10)
            tagSeen(2, "pcs-req-C1", "4", 10)
            setTags(1, listOf("pcs-req-B1#1"))
            setTags(2, listOf("pcs-req-B1#3", "pcs-req-C1#4"))
        }
        session(dir, at(200), extra) { d, v, ui ->
            section(d, "engagement")
            d.waitFor(AccTags.Q21)
            assertEquals("engagement records deleted", v.text(AccTags.Q21))
            assertEquals("Jo Junior (junior): 1 engaged, 1 not engaged, 0 disputed, 0 open", v.text(AccTags.row("engagement", "jun@example.org")))
            assertEquals("Nia Nominee (nominee): 0 engaged, 1 not engaged, 0 disputed, 0 open", v.text(AccTags.row("engagement", "nom@example.org")))
            ui.screenshot("accountability/engagement")
            section(d, "cases")
            // no appointments sheet is imported, so no nominee is accepted and there is no case to open
            assertEquals(emptyList<String>(), v.tagsWith("acc-cases-row-"))
        }
    }

    @Test
    @Covers("view:accountability", "card:X10", "card:X6", "prop:V4")
    fun `one case lists the nominee's papers, opens locally, and an upheld outcome is a Writeback draft for a PC chair`(
        @TempDir dir: Path,
    ) {
        val sheet = "email,origin,nominated_by,area,ac_email,decision,tier,consent,on_pc_at\nnom@example.org,nominee,1;2,db,ac@example.org,accept,junior,yes,\n"
        val extra: AccFixture.() -> Unit = {
            pcs.core.imports.Imports(
                store,
                object : pcs.core.time.Clock {
                    override fun now(): Instant = at(-1000)
                },
            ).import(pcs.core.imports.ImportKind.APPOINTMENTS, sheet.toByteArray(), "sheet.csv")
        }
        session(dir, at(24), extra) { d, v, ui ->
            section(d, "cases")
            d.waitFor(AccTags.row("cases", "1"))
            assertEquals("Case 1: Nia Nominee, status candidate, papers 1, 2", v.text(AccTags.row("cases", "1")))
            assertEquals("May open: yes", v.text(AccTags.row("may-open", "1")))
            assertEquals("Consequence: the nominating papers may be desk rejected, via the two-person path", v.text(AccTags.row("consequence", "1")))
            d.click(AccTags.action("open-case", "1"))
            d.waitFor(AccTags.action("uphold", "1"))
            assertTrue(v.text(AccTags.row("cases", "1")).contains("status open"))
            d.click(AccTags.action("uphold", "1"))
            d.waitFor(AccTags.STATUS)
            assertTrue(v.text(AccTags.STATUS).startsWith("Case 1 upheld: drafted Writeback artifact #"), v.text(AccTags.STATUS))
            ui.screenshot("accountability/cases")
        }
    }
}
