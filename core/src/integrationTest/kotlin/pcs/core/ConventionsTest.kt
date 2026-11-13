package pcs.core

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import pcs.testing.Covers
import pcs.testing.Family
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse

/**
 * The spec §11 *verify* rows, settled on the harness (PLAN M5): what HotCRP lets each role write
 * and see, under the convention that each AC is the manager of their papers and PC Supervisor's
 * tags are hidden tags (`tag_hidden = pcs-*`). Runs on the golden scenario, after MirrorTest.
 */
@Order(3)
@Family("T6")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class ConventionsTest {
    private val http = HttpClient.newHttpClient()
    private val token = System.getenv("PCS_HOTCRP_TOKEN")!!
    private val ac = "ac-normal@example.org" // AC of 2, 6, 11, 12, 13
    private val pid = 13
    private val otherPid = 3 // ac-busy's paper

    private fun api(method: String, path: String, params: Map<String, String> = emptyMap(), form: String? = null, json: String? = null): JsonObject {
        val q = (params + ("pretty" to "0") + ("notify" to "0")).entries.joinToString("&") { "${it.key}=${URLEncoder.encode(it.value, Charsets.UTF_8)}" }
        val b = HttpRequest.newBuilder(URI("${Harness.url}/api/$path?$q")).header("Authorization", "Bearer $token")
        val req =
            when {
                json != null -> b.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(json))
                form != null -> b.header("Content-Type", "application/x-www-form-urlencoded").method(method, HttpRequest.BodyPublishers.ofString(form))
                else -> b.method(method, HttpRequest.BodyPublishers.noBody())
            }.build()
        // the harness keeps HotCRP's rate limits: wait out a 429 as the production client does
        repeat(6) {
            val r = http.send(req, HttpResponse.BodyHandlers.ofString())
            if (r.statusCode() != 429) return Json.parseToJsonElement(r.body()).jsonObject
            Thread.sleep((r.headers().firstValue("Retry-After").orElse("5").toLong() * 1000).coerceAtMost(60_000))
        }
        error("$path: still rate-limited")
    }

    private fun ok(o: JsonObject) = o["ok"]?.jsonPrimitive?.content == "true"

    private fun tagsSeenBy(who: String?, p: Int): List<String> =
        api("GET", "$p/tags", if (who == null) emptyMap() else mapOf("actas" to who))["tags"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()

    private fun setTags(who: String, p: Int, tags: String) =
        api(
            "POST",
            "$p/tags",
            mapOf("actas" to who),
            form =
                "addtags=" + URLEncoder.encode(tags, Charsets.UTF_8),
        )

    private fun harness(vararg args: String, stdin: String? = null) {
        val cmd =
            listOf(
                "docker",
                "compose",
                "-p",
                System.getenv("HOTCRP_COMPOSE_PROJECT") ?: "pcs",
                "-f",
                Repo.path("hotcrp/compose.yaml").toString(),
                "exec",
                "-T",
                "hotcrp",
                "php",
            ) +
                args
        val p = ProcessBuilder(cmd).redirectErrorStream(true).start()
        if (stdin != null) p.outputStream.use { it.write(stdin.toByteArray()) } else p.outputStream.close()
        check(p.waitFor() == 0) { p.inputStream.bufferedReader().readText() }
    }

    @BeforeAll
    fun conventions() {
        harness("batch/settings.php", "save", "-e", """{"tag_hidden":"pcs-*"}""")
        harness("batch/assign.php", stdin = "paper,action,user\n$pid,manager,$ac\n")
    }

    @Test
    @Covers("conv:1")
    fun `triage - the AC (as manager) sets a hidden tag that only chairs and that AC see`() {
        assertTrue(ok(setTags(ac, pid, "pcs-refer-format")))
        assertTrue("pcs-refer-format#0" in tagsSeenBy(ac, pid))
        assertTrue("pcs-refer-format#0" in tagsSeenBy(null, pid), "the chair token reads it")
        for (who in listOf("r1@example.org", "r3@example.org", "r6@example.org", "ac-busy@example.org", "author13@example.org")) {
            assertFalse(tagsSeenBy(who, pid).any { it.startsWith("pcs-") }, "$who must not see PC Supervisor's tags")
        }
    }

    @Test
    @Covers("conv:1")
    fun `forged trace - an AC can't set a PC Supervisor tag on a paper they don't manage, nor can a reviewer`() {
        assertFalse(ok(setTags(ac, otherPid, "pcs-refer-scope")))
        assertFalse(ok(setTags("r3@example.org", pid, "pcs-refer-scope")))
    }

    @Test
    @Covers("conv:9")
    fun `tag values are numbers - dispositions need numeric codes`() {
        assertTrue(ok(setTags(ac, pid, "pcs-req-C1#2")))
        assertFalse(ok(setTags(ac, pid, "pcs-req-C2#revised")))
        assertTrue("pcs-req-C1#2" in tagsSeenBy(null, pid))
    }

    @Test
    @Covers("conv:10")
    fun `chair-only tags - only chairs set or see them, even a manager can't`() {
        assertTrue(ok(api("POST", "$pid/tags", form = "addtags=" + URLEncoder.encode("~~pcs-case-1#1", Charsets.UTF_8))))
        assertFalse(ok(setTags(ac, pid, "~~pcs-case-2#1")))
        assertFalse(tagsSeenBy(ac, pid).any { it.startsWith("~~") })
        assertTrue("~~pcs-case-1#1" in tagsSeenBy(null, pid))
    }

    @Test
    @Covers("conv:2")
    fun `screening findings - an admin comment reaches the managing AC and nobody else`() {
        assertTrue(ok(api("POST", "$pid/comment", json = """{"text":"Synthetic screening record.","visibility":"admin"}""")))

        fun adminCommentsSeenBy(who: String, p: Int) =
            api("GET", "$p/comments", mapOf("actas" to who))["comments"]?.jsonArray?.count { it.jsonObject["visibility"]?.jsonPrimitive?.content == "admin" }
                ?: 0
        assertTrue(adminCommentsSeenBy(ac, pid) >= 1)
        for (who in listOf("r1@example.org", "r3@example.org", "ac-busy@example.org")) assertEquals(0, adminCommentsSeenBy(who, pid), who)
    }

    @Test
    @Covers("conv:7")
    fun `there is no per-reviewer comment - a reviewer-visible comment reaches every reviewer of the paper`() {
        val r = api("POST", "$pid/comment", mapOf("actas" to ac), json = """{"text":"Synthetic note to reviewers.","visibility":"rev"}""")
        assertTrue(ok(r))
        val cid = r["comment"]!!.jsonObject["cid"]!!.jsonPrimitive.content
        for (who in listOf("r1@example.org", "r3@example.org", "r6@example.org")) {
            assertTrue(
                api("GET", "$pid/comments", mapOf("actas" to who))["comments"]!!.jsonArray.any {
                    it.jsonObject["cid"]!!.jsonPrimitive.content == cid
                },
                who,
            )
        }
    }

    @Test
    @Covers("conv:1", "conv:9", "conv:10")
    fun `round trip - traces written in HotCRP by an AC and a chair are decoded by core after a sync`() {
        assertTrue(ok(setTags(ac, pid, "pcs-refer-scope pcs-req-B1#3")))
        assertTrue(ok(api("POST", "$pid/tags", form = "addtags=" + URLEncoder.encode("~~pcs-case-2#4", Charsets.UTF_8))))
        val db = java.nio.file.Files.createTempFile("pcs-conv", ".db").also { java.nio.file.Files.delete(it) }
        pcs.core.store.Store.open(db, "test-only-key").use { store ->
            kotlinx.coroutines.runBlocking { Harness.client().use { pcs.core.store.Sync(store, pcs.core.time.Clock.System).run(it) } }
            val tags =
                store.conn.createStatement().use { st ->
                    st.executeQuery("SELECT tags FROM paper WHERE pid = $pid").use {
                        it.next()
                        it.getString(1)
                    }
                }
            val traces = pcs.core.rules.Conventions.decode(pid.toLong(), Json.parseToJsonElement(tags).jsonArray.map { it.jsonPrimitive.content })
            assertTrue(pcs.core.rules.Trace.Refer(pid.toLong(), pcs.core.rules.Ground.SCOPE) in traces, traces.toString())
            assertTrue(pcs.core.rules.Trace.RequestSent(pid.toLong(), "B", 1, pcs.core.rules.ReqDisposition.DECLINED) in traces, traces.toString())
            assertTrue(pcs.core.rules.Trace.Case(pid.toLong(), 2, 4) in traces, traces.toString())
            assertTrue(traces.none { it is pcs.core.rules.Trace.Unparsed }, traces.toString())
        }
    }
}
