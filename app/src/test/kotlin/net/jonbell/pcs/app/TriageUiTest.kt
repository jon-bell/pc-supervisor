package net.jonbell.pcs.app

import androidx.compose.ui.test.ExperimentalTestApi
import net.jonbell.pcs.app.testing.AppDriver
import net.jonbell.pcs.app.testing.MapKeychain
import net.jonbell.pcs.app.testing.RecordingOpener
import net.jonbell.pcs.app.testing.ViewReader
import net.jonbell.pcs.app.testing.runUi
import net.jonbell.pcs.app.testing.screenshot
import net.jonbell.pcs.core.bundle.BundleAnchor
import net.jonbell.pcs.core.bundle.BundleCodec
import net.jonbell.pcs.core.bundle.BundleFinding
import net.jonbell.pcs.core.bundle.BundleKey
import net.jonbell.pcs.core.bundle.BundleManifest
import net.jonbell.pcs.core.bundle.BundlePaper
import net.jonbell.pcs.core.bundle.BundlePayload
import net.jonbell.pcs.core.bundle.ScreeningBundles
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.secrets.Accounts
import net.jonbell.pcs.core.time.Clock
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import net.jonbell.pcs.testing.MirrorFixture
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Tag
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

/**
 * The triage screen over a mirror built by hand (no harness) and an imported screening bundle. What the screen lists comes from this
 * file's own table of what each paper has, never from the app's computation.
 */
@Tag("ui")
@Family("T12")
@OptIn(ExperimentalTestApi::class)
class TriageUiTest {
    private fun sql(store: net.jonbell.pcs.core.store.Store, q: String) = store.conn.createStatement().use { it.executeUpdate(q) }

    private fun conference(dir: Path, answers: String, extra: (net.jonbell.pcs.core.store.Store) -> Unit = {}): Shell {
        val file = Files.writeString(dir.resolve("answers.txt"), answers)
        val kc =
            MapKeychain().also {
                it.write(Accounts.dbKey("tr"), "test-only-key")
                it.write(Accounts.token("tr"), "unused-no-call-is-made")
            }
        val store =
            MirrorFixture.build(dir.resolve("tr.db"), "test-only-key") {
                for (pid in 1L..4L) paper(pid, title = "Triage paper $pid", tags = if (pid == 1L || pid == 2L) listOf("pcs-refer-format") else emptyList())
            }
        // the metareviews (rtype 5, normal round) and one agreeing second opinion on paper 1
        for (pid in 1..4) {
            sql(
                store,
                "INSERT INTO review(rid,pid,email,rtype,status,scores,word_count,ratings,first_seen_at,last_seen_at) VALUES(${100 + pid},$pid,'ac@example.org',5,'complete','{}',0,'[]',0,0)",
            )
        }
        sql(
            store,
            "INSERT INTO review(rid,pid,email,rtype,status,round,scores,word_count,ratings,first_seen_at,last_seen_at) VALUES(200,1,'s@example.org',2,'complete','screen','{}',0,'[]',0,0)",
        )
        extra(store)
        val finding = { pid: Int ->
            BundleFinding(
                "$pid",
                "format-check",
                "v1",
                "violation",
                "format",
                "high",
                "verified",
                "stand-in",
                "$pid|format-check|format",
                anchors = listOf(BundleAnchor("pdf", "a sentence", page = 1)),
            )
        }
        val payload =
            BundlePayload(
                BundleManifest(
                    createdAt = "2030-01-01T00:00:00Z",
                    papers =
                        (1..3).map {
                            BundlePaper("$it", "0".repeat(64), "synthetic")
                        },
                    checks = emptyList(),
                ),
                (1..3).map(finding),
            )
        val key = BundleKey.generate()
        val clock = Clock { Instant.parse("2030-01-10T00:00:00Z") }
        ScreeningBundles(store, Imports(store, clock), clock).import(BundleCodec.encrypt(payload, key), key, "ui-test")
        store.close()
        Files.writeString(
            dir.resolve("tr.conf"),
            "PCS_HOTCRP_URL=http://127.0.0.1:1\nPCS_ANSWERS=$file\nPCS_DB_PATH=${dir.resolve("tr.db")}\nPCS_TZ=UTC\nPCS_NOW=2030-01-10T00:00:00\n",
        )
        return Shell(mapOf("PCS_CONFERENCES" to dir.toString()), { kc }, RecordingOpener(), screenshotMode = true)
    }

    private val full = "Q1 = fix-window\nQ2 = ac-plus-senior\nQ3 = any-until-release\nQ6 = grounds\nQ10 = desk-reject\n"

    @Test
    @Covers("view:triage", "prop:S8", "prop:S1")
    fun `the queue says where each paper stands and which rule holds it`(
        @TempDir dir: Path,
    ) {
        val shell = conference(dir, full)
        runUi {
            setContent { PcsApp(shell) }
            val driver = AppDriver(this)
            val view = ViewReader(this)
            driver.waitFor(Tags.PICKER)
            driver.openConference("tr")
            driver.tab(TabName.Triage)
            driver.waitFor(TriageTags.SUMMARY)
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.exists(TableTags.COUNT) }
            val t = view.table()
            assertEquals(setOf("pid", "title", "ac", "grounds", "findings", "status", "why", "late"), t.columnIds.toSet())
            assertEquals(
                mapOf(
                    "1" to "ready for a chair to remove",
                    "2" to "referred; needs a second opinion",
                    "3" to "waiting for the AC",
                ),
                t.keys.associateWith { t.cell(it, "status")!! },
                "paper 4 has no finding and no triage, so it is not in the queue",
            )
            assertEquals("", t.cell("1", "why"))
            assertTrue(t.cell("2", "why")!!.startsWith("Q2"), "the blocked paper names the rule")
            assertEquals("format", t.cell("3", "grounds"))
            assertTrue(view.text(TriageTags.SUMMARY).startsWith("3 papers at the screening stage"))
            assertTrue(view.text(TriageTags.NOTE).contains("Topic areas"))
            screenshot("triage/queue")
        }
    }

    @Test
    @Covers("view:triage")
    fun `an unresolved question blocks the queue and is named`(
        @TempDir dir: Path,
    ) {
        val shell = conference(dir, "Q1 = fix-window\n")
        runUi {
            setContent { PcsApp(shell) }
            val driver = AppDriver(this)
            driver.waitFor(Tags.PICKER)
            driver.openConference("tr")
            driver.tab(TabName.Triage)
            driver.waitFor(TriageTags.BLOCKED)
        }
    }

    @Test
    @Covers("view:triage", "prop:S2")
    fun `each chair step drafts into Writeback and applies nothing`(
        @TempDir dir: Path,
    ) {
        val shell =
            conference(dir, full) { store ->
                // paper 4: the AC's complete screening metareview says keep, and no chair has mirrored it
                sql(
                    store,
                    "INSERT INTO review(rid,pid,email,rtype,status,round,scores,word_count,ratings,first_seen_at,last_seen_at) " +
                        "VALUES(304,4,'ac@example.org',5,'complete','screen','{\"Tri\":1}',0,'[]',0,0)",
                )
                sql(store, "INSERT INTO person(email,name,roles,tags,first_seen_at,last_seen_at) VALUES('senior@example.org','S','[\"pc\"]','[]',0,0)")
            }
        runUi {
            setContent { PcsApp(shell) }
            val driver = AppDriver(this)
            val view = ViewReader(this)
            driver.waitFor(Tags.PICKER)
            driver.openConference("tr")
            driver.tab(TabName.Triage)
            driver.waitFor(TriageTags.SUMMARY)
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.exists(TableTags.COUNT) }
            driver.click(TriageTags.MIRROR)
            driver.waitFor(TriageTags.MESSAGE)
            assertTrue(view.text(TriageTags.MESSAGE).startsWith("Drafted into Writeback: #1, #2"), view.text(TriageTags.MESSAGE))
            driver.click(TriageTags.FINDINGS)
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.text(TriageTags.MESSAGE).contains("#3") }
            driver.click(TriageTags.DECISION)
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.text(TriageTags.MESSAGE).contains("#6") }
            driver.clickRow("2")
            driver.waitFor(TriageTags.SELECTED)
            driver.click(TriageTags.ask("senior@example.org"))
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.text(TriageTags.MESSAGE).contains("#7") }
            assertTrue(view.text("${TriageTags.MAIL}-0").contains("Second opinion on paper #2"))
            driver.tab(TabName.Writeback)
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.exists(TableTags.COUNT) }
            val t = view.table()
            assertEquals(
                listOf("tags", "review-move", "comment", "comment", "comment", "decision", "assignments").sorted(),
                t.keys.map { t.cell(it, "kind")!! }.sorted(),
                "one of each step, as drafts",
            )
            assertEquals(setOf("drafted"), t.keys.map { t.cell(it, "status")!! }.toSet(), "nothing is applied or dry-run")
            screenshot("triage/drafted")
        }
    }
}
