package pcs.app

import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.printToString
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
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
import pcs.testing.Covers
import pcs.testing.Family
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Path

/**
 * The Writeback review screen on the harness (PLAN M5): a chair filters the paper table, copies the
 * HotCRP search for it, drafts a `#chair-attention` tag, sees HotCRP's dry-run diff, confirms, and
 * the next sync shows the artifact observed; when someone reverts the tag in HotCRP, the sync report
 * flags the mismatch. HotCRP's own state is read through the API, apart from the app.
 */
@Tag("ui")
@Tag("harness")
@Family("T12")
@OptIn(ExperimentalTestApi::class)
class WritebackUiTest {
    private val http = HttpClient.newHttpClient()

    private fun api(token: String, url: URI, method: String, path: String, json: String? = null): kotlinx.serialization.json.JsonObject {
        val b = HttpRequest.newBuilder(URI("$url/api/$path${if ('?' in path) "&" else "?"}pretty=0&notify=0")).header("Authorization", "Bearer $token")
        val req =
            if (json !=
                null
            ) {
                b.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(json))
            } else {
                b.method(method, HttpRequest.BodyPublishers.noBody())
            }
        return Json.parseToJsonElement(http.send(req.build(), HttpResponse.BodyHandlers.ofString()).body()).jsonObject
    }

    @Test
    @Covers("view:writeback", "view:report", "prop:H1", "prop:H2", "prop:M2")
    fun `a chair drafts a tag for a filtered set, reviews HotCRP's dry run, confirms, and the sync report flags a revert`(
        @TempDir dir: Path,
    ) {
        val (url, token) = Fixtures.harness()
        val tag = "chair-attention"
        val titles = HotcrpClient(url, token).use { c -> runBlocking { c.papers(c.paperIds()) } }.associate { it.pid to it.title.orEmpty() }
        val word = titles.getValue(4L).split(" ").maxBy { it.length }
        val expected = titles.filter { (_, t) -> t.contains(word, ignoreCase = true) }.keys.sorted()

        fun tagged(): List<Long> =
            titles.keys.sorted().filter { pid ->
                api(token, url, "GET", "$pid/tags")["tags"]!!.jsonArray.any { it.jsonPrimitive.content.startsWith(tag) }
            }
        assertTrue(tagged().isEmpty(), "precondition: nothing has #$tag yet")

        Fixtures.conference(dir, "wb", url.toString())
        val shell = Shell(mapOf("PCS_CONFERENCES" to dir.toString(), "PCS_HOTCRP_TOKEN" to token), { MapKeychain() }, RecordingOpener(), screenshotMode = true)
        runUi {
            setContent { PcsApp(shell) }
            val driver = AppDriver(this)
            val view = ViewReader(this)
            driver.waitFor(Tags.PICKER)
            driver.openConference("wb")
            driver.waitFor(Tags.SYNC_NOW)
            driver.syncNow()
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.exists(TableTags.COUNT) && view.text(TableTags.COUNT) == "${titles.size} papers" }

            // a filtered set -> its copyable HotCRP search, which HotCRP resolves to the same papers
            driver.filter(word)
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.table().keys == expected.map { it.toString() } }
            driver.copySearch()
            val link = view.text(Tags.SEARCH_LINK)
            assertEquals("$url/search?q=" + URLEncoder.encode(expected.joinToString(" "), Charsets.UTF_8).replace("+", "%20"), link)
            val q = link.substringAfter("q=").let { java.net.URLDecoder.decode(it, Charsets.UTF_8) }
            val found =
                api(token, url, "GET", "search?q=${URLEncoder.encode(q, Charsets.UTF_8)}&t=all")["ids"]!!.jsonArray.map {
                    it.jsonPrimitive.content.toLong()
                }
            assertEquals(expected, found.sorted(), "HotCRP's own search for the copied query")

            // draft the tag: nothing changes in HotCRP; the review screen opens on the new artifact
            driver.draftAttention()
            try {
                waitUntil(timeoutMillis = 15_000) { view.exists(WritebackTags.STATUS) || view.exists(Tags.DRAFT_ERROR) }
            } catch (e: Exception) {
                println("DEBUG " + onRoot().printToString(80).take(6000))
                throw e
            }
            assertTrue(!view.exists(Tags.DRAFT_ERROR), view.textOrNull(Tags.DRAFT_ERROR).orEmpty())
            assertEquals("drafted", view.text(WritebackTags.STATUS))
            assertTrue(view.text(WritebackTags.SUMMARY).contains("${expected.size} to add"), view.text(WritebackTags.SUMMARY))
            assertTrue(tagged().isEmpty())

            // HotCRP's dry run is the diff the chair sees; still nothing changes
            driver.dryRun()
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.text(WritebackTags.STATUS) == "dry-run" }
            val wb = view.writeback()
            assertEquals(expected.size, wb.diff.size, "one diff line per paper: ${wb.diff}")
            assertTrue(wb.diff.all { it.contains("tag") && it.contains(tag) }, wb.diff.toString())
            assertEquals(expected, wb.diff.map { it.substringAfter('#').substringBefore(' ').toLong() }.sorted())
            assertTrue(tagged().isEmpty(), "the dry run changed nothing")
            screenshot("writeback/dry-run")

            // confirm and apply
            driver.confirmAndApply()
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.text(WritebackTags.STATUS) == "applied" }
            assertEquals(expected, tagged(), "the confirmed run made the change")

            // the next sync observes it, and the report is clean
            driver.syncNow()
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.text(WritebackTags.STATUS) == "observed" }
            driver.tab(TabName.Report)
            driver.waitFor(WritebackTags.REPORT_SUMMARY)
            // a fresh golden has not had spec §11's `tag_hidden = pcs-*` set, and the report says so; nothing else, and no mismatch
            val clean = view.report()
            assertTrue(clean.mismatches.isEmpty(), clean.toString())
            assertTrue(clean.issues.all { it.contains("tag_hidden") }, clean.issues.toString())
            screenshot("report/clean")

            // someone removes one tag in HotCRP; the next sync flags the mismatch
            val victim = expected.first()
            assertTrue(api(token, url, "POST", "assign", """[{"pid":$victim,"action":"cleartag","tag":"$tag"}]""")["ok"]!!.jsonPrimitive.content == "true")
            driver.syncNow()
            waitUntil(timeoutMillis = AppDriver.TIMEOUT_MS) { view.report().mismatches.isNotEmpty() }
            val r = view.report()
            assertEquals(1, r.mismatches.size)
            assertTrue(r.mismatches.values.single().contains(tag) && r.mismatches.values.single().contains("$victim"), r.mismatches.toString())
            screenshot("report/mismatch")
        }
    }
}
