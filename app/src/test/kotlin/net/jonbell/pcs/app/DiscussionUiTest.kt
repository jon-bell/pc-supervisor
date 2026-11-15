package net.jonbell.pcs.app

import androidx.compose.ui.test.ExperimentalTestApi
import kotlinx.coroutines.runBlocking
import net.jonbell.pcs.app.testing.AppDriver
import net.jonbell.pcs.app.testing.Fixtures
import net.jonbell.pcs.app.testing.MapKeychain
import net.jonbell.pcs.app.testing.RecordingOpener
import net.jonbell.pcs.app.testing.ViewReader
import net.jonbell.pcs.app.testing.runUi
import net.jonbell.pcs.app.testing.screenshot
import net.jonbell.pcs.core.hotcrp.HotcrpClient
import net.jonbell.pcs.core.secrets.Accounts
import net.jonbell.pcs.core.store.Backfill
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.Sync
import net.jonbell.pcs.core.time.Clock
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * The discussion dashboard on the harness's `golden` scenario at PCS_NOW 2030-02-26 12:00 (PLAN M18). The mirror is filled the way
 * the app fills it (a sync, then the history read) before the app opens; what the screens must show comes from the golden table in
 * PLAN.md, written out below: which rules fire on which row, the weights of spec §5c, and who holds which paper. The app's own
 * numbers are never the oracle.
 */
@Tag("ui")
@Tag("harness")
@Family("T12")
@OptIn(ExperimentalTestApi::class)
class DiscussionUiTest {
    /** The table's "Fires (exactly)" column. */
    private val fires: Map<Long, Set<String>> =
        mapOf(
            1L to setOf(),
            2L to setOf("MISSING_REVIEWS"),
            3L to setOf("SPLIT"),
            4L to setOf("SPLIT", "UNRESOLVED_SPLIT"),
            5L to setOf("SILENT_DISCUSSION", "AC_ABSENT", "GONE_QUIET"),
            6L to setOf("GONE_QUIET"),
            7L to setOf("AC_ABSENT"),
            8L to setOf("CHAMPION_MISSING"),
            9L to setOf("LOW_EXPERTISE"),
            10L to setOf("THIN_REVIEWS"),
            11L to setOf("RESPONSE_UNADDRESSED"),
            12L to setOf("SPLIT"),
            13L to setOf("REVIEW_FLAGGED"),
        )

    /** Spec §5c's default weights. */
    private val weight =
        mapOf(
            "MISSING_REVIEWS" to 3,
            "SPLIT" to 3,
            "UNRESOLVED_SPLIT" to 2,
            "SILENT_DISCUSSION" to 3,
            "GONE_QUIET" to 2,
            "AC_ABSENT" to 2,
            "CHAMPION_MISSING" to 1,
            "LOW_EXPERTISE" to 2,
            "THIN_REVIEWS" to 1,
            "RESPONSE_UNADDRESSED" to 2,
            "REVIEW_FLAGGED" to 4,
            "DEADLINE_NO_CONSENSUS" to 3,
        )

    /** "People" in the table: who holds which papers. */
    private val acPapers =
        mapOf(
            "ac-busy@example.org" to listOf(1L, 3L, 4L, 8L, 9L, 10L),
            "ac-idle@example.org" to listOf(5L, 7L),
            "ac-normal@example.org" to listOf(2L, 6L, 11L, 12L, 13L),
        )

    /** The order the table gives: severity descending, then pid (every paper has the same decisions deadline). */
    private val expectedOrder =
        fires.entries.sortedWith(
            compareByDescending<Map.Entry<Long, Set<String>>> { e ->
                e.value.sumOf { weight.getValue(it) }
            }.thenBy { it.key },
        ).map { it.key }

    private fun conference(dir: Path): Triple<Shell, String, Path> {
        val (url, token) = Fixtures.harness()
        val db = dir.resolve("golden.db")
        val key = "test-only-key"
        val kc = MapKeychain().also { it.write(Accounts.dbKey("golden"), key) }
        val et = ZoneId.of("America/New_York")
        val clock = Clock.Fixed(LocalDateTime.parse("2030-02-26T12:00").atZone(et).toInstant())
        Store.open(db, key).use { store ->
            runBlocking {
                HotcrpClient(url, token, chunk = 50, strict = false).use { Sync(store, clock).run(it) }
                HotcrpClient(url, token, strict = false).use { Backfill(store, clock).run(it, rps = 50) }
            }
            // /pc carries no per-user tags, and golden has no appointments import, so the tiers the table names (R-silent junior, the laggard
            // a nominee) are set on the mirror's people, which is where the tier lookup reads them
            for ((email, tag) in listOf("r-silent@example.org" to "junior", "n-laggard@example.org" to "nominee")) {
                store.conn.createStatement().use { it.executeUpdate("UPDATE person SET tags = '[\"$tag\"]' WHERE email = '$email'") }
            }
        }
        Files.writeString(
            dir.resolve("golden.conf"),
            "PCS_HOTCRP_URL=$url\nPCS_ANSWERS=${Fixtures.syntheticAnswers}\nPCS_DB_PATH=$db\nPCS_TZ=America/New_York\nPCS_NOW=2030-02-26T12:00\n" +
                "PCS_PHASE_REVIEW_DUE=2030-02-01T23:59\nPCS_PHASE_DISCUSSION_OPEN=2030-02-12T00:00\nPCS_PHASE_DISCUSSION_CLOSE=2030-03-01T23:59\n" +
                "PCS_PHASE_DECISIONS_DUE=2030-03-03T23:59\nPCS_TIER_TAGS=junior=junior,nominee=nominee\n",
        )
        return Triple(
            Shell(mapOf("PCS_CONFERENCES" to dir.toString(), "PCS_HOTCRP_TOKEN" to token), {
                kc
            }, RecordingOpener(), screenshotMode = true),
            url.toString(),
            db,
        )
    }

    private fun run(dir: Path, block: androidx.compose.ui.test.ComposeUiTest.(AppDriver, ViewReader, RecordingOpener, String) -> Unit) {
        val (shell, url, _) = conference(dir)
        runUi {
            setContent { PcsApp(shell) }
            val driver = AppDriver(this)
            val view = ViewReader(this)
            driver.waitFor(Tags.PICKER)
            driver.openConference("golden")
            driver.tab(TabName.Discussion)
            driver.waitFor(DiscTags.TRI_COUNT)
            block(driver, view, shell.opener as RecordingOpener, url)
        }
    }

    private fun androidx.compose.ui.test.ComposeUiTest.pids(view: ViewReader) = view.tagsWith("tri-row-").map { it.toLong() }

    @Test
    @Covers(
        "view:discussion",
        "golden:pid1",
        "golden:pid2",
        "golden:pid3",
        "golden:pid4",
        "golden:pid5",
        "golden:pid6",
        "golden:pid7",
        "golden:pid8",
        "golden:pid9",
        "golden:pid10",
        "golden:pid11",
        "golden:pid12",
        "golden:pid13",
        "prop:H3",
    )
    fun `the triage list shows the table's order and exactly its chips, and paper 1 has none`(
        @TempDir dir: Path,
    ) {
        run(dir) { _, view, _, _ ->
            assertEquals("13 papers", view.text(DiscTags.TRI_COUNT))
            assertEquals(expectedOrder, pids(view), "rows in the order worked out from the table")
            // both directions: every rule a row lists is a chip, and no other chip is there
            for ((pid, rules) in fires) {
                assertEquals(rules, view.tagsWith("tri-chip-$pid-").toSet(), "chips on paper $pid")
                assertEquals(rules.sumOf { weight.getValue(it) }.toString(), view.text(DiscTags.cell(pid, "sev")), "severity of paper $pid")
            }
            assertEquals(emptyList<String>(), view.tagsWith("tri-chip-1-"), "paper 1 is the control: no chips")
            assertEquals(expectedOrder.last(), 1L)
            // H3: the screen says when its facts are from, and no note says the history is missing
            assertTrue(view.exists(DiscTags.AS_OF))
            assertFalse(view.exists(DiscTags.NOTE), "history was read: nothing is flagged as approximate")
            // chips carry the wording of the rule, never a judgement
            assertEquals("No comments yet", view.text(DiscTags.chip(5, "SILENT_DISCUSSION")))
            assertEquals("No AC comment yet", view.text(DiscTags.chip(5, "AC_ABSENT")))
            screenshot("golden/discussion/triage")
        }
    }

    @Test
    @Covers("view:discussion", "golden:pid3", "golden:pid4", "golden:pid5")
    fun `filters by AC, by rule and by tier narrow the list and clear again`(
        @TempDir dir: Path,
    ) {
        run(dir) { driver, view, _, _ ->
            driver.click(DiscTags.filterAc("ac-idle@example.org"))
            assertEquals(expectedOrder.filter { it in acPapers.getValue("ac-idle@example.org") }, pids(view))
            assertEquals("2 of 13 papers", view.text(DiscTags.TRI_COUNT))
            driver.click(DiscTags.TRI_CLEAR)
            driver.click(DiscTags.filterRule("SPLIT"))
            assertEquals(expectedOrder.filter { "SPLIT" in fires.getValue(it) }, pids(view))
            driver.click(DiscTags.TRI_CLEAR)
            // tier: papers with a junior reviewer are 3, 4 and 12 (R-silent); with the nominee, paper 2
            driver.click(DiscTags.filterTier("junior"))
            assertEquals(listOf(4L, 3L, 12L), pids(view))
            driver.click(DiscTags.filterTier("junior"))
            driver.click(DiscTags.filterTier("nominee"))
            assertEquals(listOf(2L), pids(view))
            driver.click(DiscTags.TRI_CLEAR)
            assertEquals(expectedOrder, pids(view))
        }
    }

    @Test
    @Covers("view:discussion", "golden:pid4", "prop:H3")
    fun `paper 4's drawer shows the day +3 ping with no reply, its reasons, and no score change`(
        @TempDir dir: Path,
    ) {
        run(dir) { driver, view, opener, url ->
            driver.clickRow4()
            driver.waitFor(DiscTags.DRAWER)
            assertEquals("#4 Synthetic Paper 4", view.text(DiscTags.DRAWER_TITLE))
            val events = view.tagsWith("drawer-event-").map { view.text("drawer-event-$it") }
            val ping = events.single { "@mentions" in it }
            assertTrue(ping.startsWith("day +3 "), ping)
            assertTrue(ping.contains("Avery Busy") && ping.contains("@mentions Pat Pinged: no reply yet (11 days)"), ping)
            assertTrue(events.none { "score change" in it }, "paper 4 never changes a score: $events")
            assertEquals(3, events.count { " review: " in it }, "the three reviews are on the timeline")
            assertEquals(listOf("SPLIT", "UNRESOLVED_SPLIT"), view.tagsWith("drawer-reason-").sorted())
            assertTrue(view.text(DiscTags.reason("SPLIT")).contains("scores 2/4/4"))
            assertTrue(view.text(DiscTags.reason("UNRESOLVED_SPLIT")).contains("no movement since discussion opened 14 days ago"))
            screenshot("golden/discussion/paper-4-drawer")
            driver.click(DiscTags.DRAWER_OPEN)
            assertEquals(listOf("$url/paper/4"), opener.opened)
            driver.click(DiscTags.DRAWER_CLOSE)
            assertFalse(view.exists(DiscTags.DRAWER))
        }
    }

    @Test
    @Covers("view:discussion", "golden:pid3", "prop:H3")
    fun `paper 3's drawer shows the score change on day +6, with HotCRP's own time because the history was read`(
        @TempDir dir: Path,
    ) {
        run(dir) { driver, view, _, _ ->
            driver.click(DiscTags.row(3))
            driver.waitFor(DiscTags.DRAWER)
            val change = view.tagsWith("drawer-event-").map { view.text("drawer-event-$it") }.single { "score change" in it }
            assertTrue(change.startsWith("day +6 "), "no approximation mark once the history is read: $change")
            assertTrue(change.contains("merit 1 → 2"), change)
        }
    }

    @Test
    @Covers("view:discussion", "golden:pid5", "golden:pid7")
    fun `the AC table tells a busy AC from an idle one by the load column, and a row filters the list`(
        @TempDir dir: Path,
    ) {
        run(dir) { driver, view, _, _ ->
            driver.click(DiscTags.section("acs"))
            driver.waitFor(TableTags.COUNT)
            val t = view.table()
            assertEquals(listOf("ac", "load", "coverage", "first", "nudges", "stale", "meta", "activity"), t.columnIds)
            assertEquals(acPapers.keys.toSet(), t.keys.toSet(), "one row per AC, in both directions")

            // the table: AC-busy holds 6 papers and 5 are flagged; AC-idle holds 2 and both are flagged
            fun load(ac: String) = acPapers.getValue(ac).let { ps -> "${ps.size} papers, ${ps.count { fires.getValue(it).isNotEmpty() }} flagged" }
            for (ac in acPapers.keys) assertEquals(load(ac), t.cell(ac, "load"), "load of $ac")
            assertNotEquals(t.cell("ac-busy@example.org", "load"), t.cell("ac-idle@example.org", "load"))
            assertEquals("6 papers, 5 flagged", t.cell("ac-busy@example.org", "load"))
            assertEquals("2 papers, 2 flagged", t.cell("ac-idle@example.org", "load"))
            assertEquals("100%", t.cell("ac-busy@example.org", "coverage"), "AC-busy comments on all six")
            assertEquals("0%", t.cell("ac-idle@example.org", "coverage"), "AC-idle has no comment on either")
            assertEquals("no post yet", t.cell("ac-idle@example.org", "first"))
            assertEquals("24 h", t.cell("ac-busy@example.org", "first"), "AC-busy's first posts are on day +1")
            assertEquals("1", t.cell("ac-idle@example.org", "stale"), "paper 5 has been quiet since before discussion; paper 7 had a comment on day +13")
            screenshot("golden/discussion/acs")
            // a row filters the triage list to that AC's papers
            driver.clickRow("ac-idle@example.org")
            driver.waitFor(DiscTags.TRI_COUNT)
            assertEquals(listOf(5L, 7L), pids(view))
        }
    }

    @Test
    @Covers("view:discussion", "golden:pid3", "golden:pid4", "golden:pid12")
    fun `reviewer outliers by tier, and the person page for R-silent`(
        @TempDir dir: Path,
    ) {
        run(dir) { driver, view, _, _ ->
            driver.click(DiscTags.section("reviewers"))
            driver.click(DiscTags.tier("junior"))
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.exists(TableTags.COUNT) && view.table().keys == listOf("r-silent@example.org") }
            val junior = view.table()
            assertEquals("3", junior.cell("r-silent@example.org", "silent"), "R-silent tops 'silent on split papers' with 3")
            assertTrue(
                junior.cell("r-silent@example.org", "why")!!.contains("no comments yet on 3 split paper(s): #3, #4, #12"),
                junior.cell("r-silent@example.org", "why"),
            )
            assertEquals("2", junior.cell("r-silent@example.org", "moves"), "the 1 to 2 changes on papers 3 and 12")
            driver.click(DiscTags.tier("senior"))
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.exists(TableTags.COUNT) && "r-pinged@example.org" in view.table().keys }
            val senior = view.table()
            assertEquals("1", senior.cell("r-pinged@example.org", "pings"), "R-pinged has the unanswered ping on paper 4")
            assertFalse("r-silent@example.org" in senior.keys, "R-silent is junior")
            // the nominee's empty review on paper 2 (past the deadline) comes from the reviewing-progress report
            driver.click(DiscTags.tier("nominee"))
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.exists(TableTags.COUNT) && view.table().keys == listOf("n-laggard@example.org") }
            assertEquals("1 (1 late)", view.table().cell("n-laggard@example.org", "late"))
            // person page
            driver.click(DiscTags.tier("junior"))
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.exists(TableTags.COUNT) && view.table().keys == listOf("r-silent@example.org") }
            driver.clickRow("r-silent@example.org")
            driver.waitFor(DiscTags.PERSON_TITLE)
            assertEquals("Sam Silent (junior)", view.text(DiscTags.PERSON_TITLE))
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.exists(TableTags.COUNT) && view.table().keys.isNotEmpty() }
            val page = view.table()
            assertEquals(setOf("3", "4", "12"), page.keys.toSet(), "every paper they review")
            for (pid in listOf("3", "4", "12")) {
                assertEquals("2", page.cell(pid, "merit"), "R-silent's score on paper $pid")
                assertEquals("split", page.cell(pid, "split"))
                assertEquals("no comment yet", page.cell(pid, "last"))
            }
            assertTrue(view.text(DiscTags.PERSON_SUMMARY).contains("3 split paper(s) with no comment yet"), view.text(DiscTags.PERSON_SUMMARY))
            screenshot("golden/discussion/person")
        }
    }

    @Test
    @Covers("view:discussion", "golden:pid12", "prop:H3")
    fun `the overview counts papers by phase and draws the no-consensus burndown from the score history`(
        @TempDir dir: Path,
    ) {
        run(dir) { driver, view, _, _ ->
            driver.click(DiscTags.section("overview"))
            driver.waitFor(DiscTags.PHASE_LINE)
            assertEquals("Reviews due 2030-02-01; discussion opens 2030-02-12; decisions due 2030-03-03", view.text(DiscTags.PHASE_LINE))
            assertEquals("In discussion: 12", view.text(DiscTags.stage("IN_DISCUSSION")))
            assertEquals("Decided: 1", view.text(DiscTags.stage("DECIDED")), "paper 1")
            assertEquals("Awaiting reviews: 0", view.text(DiscTags.stage("AWAITING_REVIEWS")))
            // spreads from the table's merits: 0 is papers 5, 6, 11; 2 is papers 3, 4, 12; the rest are 1
            assertEquals("spread 0: 3 papers", view.text(DiscTags.spread(0)))
            assertEquals("spread 1: 7 papers", view.text(DiscTags.spread(1)))
            assertEquals("spread 2: 3 papers", view.text(DiscTags.spread(2)))
            assertEquals("Avery Busy: 5", view.text(DiscTags.flaggedAc("ac-busy@example.org")))
            assertEquals("Ira Idle: 2", view.text(DiscTags.flaggedAc("ac-idle@example.org")))
            // papers 3, 4 and 12 are split from the start and stay split (the 1 to 2 moves leave a range of 2)
            assertEquals("day +0: 3 split, target 3.0", view.text(DiscTags.burn(0)))
            assertTrue(view.text(DiscTags.BURN_NOW).startsWith("3 undecided paper(s) are split now"), view.text(DiscTags.BURN_NOW))
            assertTrue(view.exists(DiscTags.BURN_CHART))
            screenshot("golden/discussion/overview")
        }
    }

    private fun AppDriver.clickRow4() = click(DiscTags.row(4))
}
