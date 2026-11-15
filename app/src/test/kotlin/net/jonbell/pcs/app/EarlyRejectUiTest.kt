package net.jonbell.pcs.app

import androidx.compose.ui.test.ExperimentalTestApi
import net.jonbell.pcs.app.testing.AppDriver
import net.jonbell.pcs.app.testing.MapKeychain
import net.jonbell.pcs.app.testing.RecordingOpener
import net.jonbell.pcs.app.testing.ViewReader
import net.jonbell.pcs.app.testing.runUi
import net.jonbell.pcs.app.testing.screenshot
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
import java.time.Duration
import java.time.Instant

/**
 * The early-reject screen over a mirror built by hand (no harness): the window opens at 2030-02-02 00:00 UTC and closes 48 hours
 * later. The app is opened three times on the same history, with the clock pinned at the window's start, inside it after one
 * reviewer's score change, and after its close. What the screen lists at each instant comes from the fixture's table (which
 * papers have negative initial reviews, who changed a score when, which AC objects), never from the app's own computation.
 */
@Tag("ui")
@Family("T12")
@OptIn(ExperimentalTestApi::class)
class EarlyRejectUiTest {
    private val open = Instant.parse("2030-02-02T00:00:00Z")

    private fun h(hours: Long, merit: Int) = Triple(open.plus(Duration.ofHours(hours)).epochSecond, merit, "complete")

    /** Papers 1-5: see the expectations below. */
    private val history: MirrorFixture.() -> Unit = {
        paper(1, title = "Quiet and negative")
        review(1, "ra", h(-30, 1))
        review(1, "rb", h(-29, 1))
        review(1, "rc", h(-28, 2))
        paper(2, title = "One reviewer changes a score")
        review(2, "ra", h(-30, 1))
        review(2, "rb", h(-29, 2), h(10, 3))
        review(2, "rc", h(-28, 1))
        paper(3, title = "A positive review")
        review(3, "ra", h(-30, 1))
        review(3, "rb", h(-29, 1))
        review(3, "rc", h(-28, 4))
        paper(4, title = "The AC objects", tags = listOf("pcs-er-object#0"))
        review(4, "ra", h(-30, 1))
        review(4, "rb", h(-29, 1))
        review(4, "rc", h(-28, 1))
        paper(5, title = "A reviewer replies without changing")
        review(5, "ra", h(-30, 1))
        review(5, "rb", h(-29, 1))
        review(5, "rc", h(-28, 1))
        comment(5, "rb", open.plus(Duration.ofHours(5)).epochSecond)
    }

    private fun conference(dir: Path, now: Instant): Shell {
        val answers = Files.writeString(dir.resolve("answers.txt"), "Q15 = reject-or-weak\nQ16 = bump-window\n")
        val kc = MapKeychain().also { it.write(Accounts.dbKey("er"), "test-only-key") }
        MirrorFixture.build(dir.resolve("er.db"), "test-only-key", history).close()
        Files.writeString(
            dir.resolve("er.conf"),
            "PCS_HOTCRP_URL=http://127.0.0.1:1\nPCS_ANSWERS=$answers\nPCS_DB_PATH=${dir.resolve("er.db")}\nPCS_TZ=UTC\n" +
                "PCS_NOW=${now.toString().removeSuffix("Z")}\nPCS_PHASE_EARLYREJECT_OPEN=2030-02-02T00:00\n",
        )
        return Shell(mapOf("PCS_CONFERENCES" to dir.toString()), { kc }, RecordingOpener(), screenshotMode = true)
    }

    private fun at(hours: Long) = open.plus(Duration.ofHours(hours))

    private data class Seen(val statuses: Map<String, String>, val search: String, val csv: String)

    private fun look(dir: Path, now: Instant, shot: String): Seen {
        val shell = conference(dir, now)
        var seen: Seen? = null
        runUi {
            setContent { PcsApp(shell) }
            val driver = AppDriver(this)
            val view = ViewReader(this)
            driver.waitFor(Tags.PICKER)
            driver.openConference("er")
            driver.tab(TabName.EarlyReject)
            driver.waitFor(EarlyRejectTags.SUMMARY)
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.exists(TableTags.COUNT) }
            val t = view.table()
            assertEquals(listOf("pid", "title", "status", "scores", "bump", "objection"), t.columnIds, "default columns")
            seen =
                Seen(
                    t.keys.associateWith { t.cell(it, "status")!! },
                    view.text(EarlyRejectTags.MAIL_SEARCH),
                    view.text(EarlyRejectTags.DECISION_CSV),
                )
            assertEquals(
                "Window opened 2030-02-02 00:00 UTC, closes 2030-02-04 00:00 UTC: " +
                    if (now <
                        at(48)
                    ) {
                        "open"
                    } else {
                        "closed"
                    },
                view.text(EarlyRejectTags.WINDOW),
            )
            assertEquals("reject, reject, weak-reject", t.cell("1", "scores"), "the scores shown are the reviews at the opening")
            assertEquals(if (now >= at(10)) "changed by rb@example.org" else "no score changed", t.cell("2", "bump"))
            assertEquals("AC objects", t.cell("4", "objection"))
            assertEquals("", t.cell("1", "objection"))
            screenshot("early-reject/$shot")
        }
        return seen!!
    }

    @Test
    @Covers("view:early-reject", "prop:E-1", "prop:E-2")
    fun `candidates at the opening, a bump inside the window, and the lists at the close`(
        @TempDir dir: Path,
    ) {
        val start = look(dir.resolve("a").also { Files.createDirectories(it) }, at(1), "window-open")
        assertEquals(
            mapOf("1" to "window open", "2" to "window open", "4" to "AC objects", "5" to "window open"),
            start.statuses,
            "the candidates at the opening; paper 3 has a positive review",
        )
        assertEquals("1 2 5", start.search, "the mail search reaches the waiting candidates (E-2)")
        assertEquals("paper,action,decision\n", start.csv, "nothing is ready while the window is open (E-1)")

        val mid = look(dir.resolve("b").also { Files.createDirectories(it) }, at(11), "bump")
        assertEquals(mapOf("1" to "window open", "2" to "bumped", "4" to "AC objects", "5" to "window open"), mid.statuses)
        assertEquals("1 5", mid.search, "a bumped paper leaves the search")

        val close = look(dir.resolve("c").also { Files.createDirectories(it) }, at(60), "window-closed")
        assertEquals(mapOf("1" to "ready to confirm", "2" to "bumped", "4" to "AC objects", "5" to "ready to confirm"), close.statuses)
        assertEquals("paper,action,decision\n1,decision,Reject\n5,decision,Reject\n", close.csv)
    }

    @Test
    @Covers("view:early-reject")
    fun `an unresolved Q16 blocks the screen and says why`(
        @TempDir dir: Path,
    ) {
        val kc = MapKeychain().also { it.write(Accounts.dbKey("er"), "test-only-key") }
        MirrorFixture.build(dir.resolve("er.db"), "test-only-key", history).close()
        val answers = Files.writeString(dir.resolve("answers.txt"), "Q15 = reject-or-weak\n")
        Files.writeString(
            dir.resolve("er.conf"),
            "PCS_HOTCRP_URL=http://127.0.0.1:1\nPCS_ANSWERS=$answers\nPCS_DB_PATH=${dir.resolve(
                "er.db",
            )}\nPCS_TZ=UTC\nPCS_NOW=2030-02-02T01:00\nPCS_PHASE_EARLYREJECT_OPEN=2030-02-02T00:00\n",
        )
        val shell = Shell(mapOf("PCS_CONFERENCES" to dir.toString()), { kc }, RecordingOpener(), screenshotMode = true)
        runUi {
            setContent { PcsApp(shell) }
            val driver = AppDriver(this)
            val view = ViewReader(this)
            driver.waitFor(Tags.PICKER)
            driver.openConference("er")
            driver.tab(TabName.EarlyReject)
            driver.waitFor(EarlyRejectTags.BLOCKED)
            assertTrue(view.text(EarlyRejectTags.BLOCKED).contains("Q16"), view.text(EarlyRejectTags.BLOCKED))
            assertFalse(view.exists(EarlyRejectTags.SUMMARY), "no candidates are listed while Q16 is open")
        }
    }

    /**
     * The mirror first synced after the window opened, so it holds no snapshot at or before the opening. A stub of HotCRP's
     * `/reviewhistory` (a local server; no harness) gives each review's version its true earlier time.
     */
    @Test
    @Covers("view:early-reject", "prop:E-1")
    fun `a window that opened before the mirror's first sync shows the gap, and only the chair's button backfills it`(
        @TempDir dir: Path,
    ) {
        val seenAfter = open.plus(Duration.ofHours(2)).epochSecond
        val trueTime = open.minus(Duration.ofHours(30)).epochSecond
        val reviews = mutableMapOf<Long, Pair<Long, Int>>() // rid -> (pid, merit)
        val gapHistory: MirrorFixture.() -> Unit = {
            var rid = 1L
            for (pid in 1L..2L) {
                paper(pid, title = "Late first sync $pid")
                for (who in listOf("ra", "rb", "rc")) {
                    review(pid, who, Triple(seenAfter, 1, "complete"))
                    reviews[rid++] = pid to 1
                }
            }
            paper(3, title = "A positive review")
            review(3, "ra", Triple(seenAfter, 1, "complete"))
            review(3, "rb", Triple(seenAfter, 1, "complete"))
            review(3, "rc", Triple(seenAfter, 4, "complete"))
            reviews[rid++] = 3L to 1
            reviews[rid++] = 3L to 1
            reviews[rid++] = 3L to 4
        }
        val requests = java.util.concurrent.CopyOnWriteArrayList<String>()
        val server =
            com.sun.net.httpserver.HttpServer.create(java.net.InetSocketAddress("127.0.0.1", 0), 0).apply {
                createContext("/api") { ex ->
                    requests += ex.requestURI.toString()
                    val rid = Regex("(?:^|&)r=([0-9]+)").find(ex.requestURI.rawQuery.orEmpty())!!.groupValues[1].toLong()
                    val (pid, merit) = reviews.getValue(rid)
                    val body =
                        """{"ok":true,"pid":$pid,"rid":$rid,"versions":[{"rid":$rid,"pid":$pid,"status":"complete","version":"v0","modified_at":$trueTime,"OveMer":$merit}]}"""
                            .toByteArray()
                    ex.responseHeaders.add("Content-Type", "application/json")
                    ex.sendResponseHeaders(200, body.size.toLong())
                    ex.responseBody.use { it.write(body) }
                    ex.close()
                }
                start()
            }
        try {
            val answers = Files.writeString(dir.resolve("answers.txt"), "Q15 = reject-or-weak\nQ16 = bump-window\n")
            val kc = MapKeychain().also { it.write(Accounts.dbKey("er"), "test-only-key") }
            MirrorFixture.build(dir.resolve("er.db"), "test-only-key", gapHistory).close()
            Files.writeString(
                dir.resolve("er.conf"),
                "PCS_HOTCRP_URL=http://127.0.0.1:${server.address.port}\nPCS_ANSWERS=$answers\nPCS_DB_PATH=${dir.resolve("er.db")}\nPCS_TZ=UTC\n" +
                    "PCS_NOW=2030-02-02T03:00\nPCS_PHASE_EARLYREJECT_OPEN=2030-02-02T00:00\nPCS_HISTORY_RPS=100\n",
            )
            val shell =
                Shell(mapOf("PCS_CONFERENCES" to dir.toString(), "PCS_HOTCRP_TOKEN" to "hct_stub"), { kc }, RecordingOpener(), screenshotMode = true)
            runUi {
                setContent { PcsApp(shell) }
                val driver = AppDriver(this)
                val view = ViewReader(this)
                driver.waitFor(Tags.PICKER)
                driver.openConference("er")
                driver.tab(TabName.EarlyReject)
                driver.waitFor(EarlyRejectTags.SUMMARY)
                driver.waitFor(EarlyRejectTags.GAP)
                assertTrue(view.text(EarlyRejectTags.GAP).contains("no review snapshot at or before the opening"), view.text(EarlyRejectTags.GAP))
                assertEquals("0 candidates: 0 window open, 0 bumped, 0 AC objects, 0 ready to confirm", view.text(EarlyRejectTags.SUMMARY))
                screenshot("early-reject/gap")
                // the screen waits for the chair: nothing has asked HotCRP for history
                Thread.sleep(500)
                assertEquals(emptyList<String>(), requests.toList(), "the backfill never runs by itself")

                driver.click(EarlyRejectTags.BACKFILL)
                waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { !view.exists(EarlyRejectTags.GAP) }
                assertEquals(9, requests.size, "one history request per review")
                assertTrue(requests.all { "reviewhistory" in it }, requests.toString())
                // recomputed: papers 1 and 2 had three negative reviews at the opening; paper 3 has a positive one
                waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.text(EarlyRejectTags.SUMMARY).startsWith("2 candidates") }
                waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.exists(TableTags.COUNT) }
                val t = view.table()
                assertEquals(setOf("1", "2"), t.keys.toSet())
                assertEquals("reject, reject, reject", t.cell("1", "scores"))
                assertFalse(view.exists(EarlyRejectTags.BACKFILL), "once the history is read the button is gone")
                screenshot("early-reject/backfilled")
            }
        } finally {
            server.stop(0)
        }
    }
}
