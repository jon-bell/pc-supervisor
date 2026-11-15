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

    // ACs are metareviewers only; the chairs are the paper administrators (spec §11, decided 2026-11-13)
    @BeforeAll
    fun conventions() {
        harness(
            "batch/settings.php",
            "save",
            "-e",
            """{"tag_hidden":"pcs-*","review":[{"name":"screen"}],"review_visibility_pc":"after_review",""" +
                """"rf":[{"id":"s90","name":"Triage","type":"radio","required":false,"visibility":"admin","condition":"round:screen",""" +
                """"values":[{"name":"Keep","symbol":1},{"name":"Refer: format","symbol":2},{"name":"Refer: scope","symbol":3}]},""" +
                """{"id":"s01","condition":"round:unnamed"},{"id":"s02","condition":"round:unnamed"}]}""",
        )
    }

    private fun assign(vararg rows: String) = api("POST", "assign", json = rows.joinToString(",", "[", "]"))

    private fun reviewsSeenBy(who: String?, p: Int) =
        api("GET", "$p/reviews", if (who == null) emptyMap() else mapOf("actas" to who))["reviews"]?.jsonArray?.map { it.jsonObject }.orEmpty()

    private fun JsonObject.str(k: String) = this[k]?.let { if (it is kotlinx.serialization.json.JsonNull) null else it.jsonPrimitive.content }

    private fun reviewersOf(p: Int) = reviewsSeenBy(null, p).filter { it.str("rtype") != "5" }

    private fun outsider(p: Int): String {
        val onPaper = reviewsSeenBy(null, p).mapNotNull { it.str("reviewer_email") }.toSet()
        val pc = api("GET", "pc")["pc"]!!.jsonArray.map { it.jsonObject.str("email")!! }
        return pc.first { it !in onPaper && !it.startsWith("admin") && !it.startsWith("ac-") }
    }

    @Test
    @Covers("conv:1")
    fun `triage - the AC records keep or refer in a screen-round metareview that only the chairs and that AC read`() {
        assertTrue(ok(assign("""{"pid":$pid,"action":"metareview","user":"$ac","round":"screen"}""")))
        val mine = reviewsSeenBy(ac, pid).single { it.str("rtype") == "5" && it.str("reviewer_email") == ac }
        assertEquals("screen", mine.str("round"))
        val saved = api("POST", "$pid/review", mapOf("r" to mine.str("rid")!!, "actas" to ac), json = """{"object":"review","Tri":3,"status":"complete"}""")
        assertTrue(ok(saved), saved.toString())
        val chairView = reviewsSeenBy(null, pid).single { it.str("reviewer_email") == ac }
        assertEquals("complete", chairView.str("status"))
        assertEquals("3", chairView.str("Tri"), "the chair reads the AC's triage")
        for (who in reviewersOf(pid).mapNotNull { it.str("reviewer_email") } + outsider(pid) + "ac-busy@example.org") {
            assertFalse(reviewsSeenBy(who, pid).any { it.containsKey("Tri") }, "$who must not read the triage field")
        }
    }

    @Test
    @Covers("conv:1")
    fun `triage - the chair mirrors it into a hidden tag that ACs and reviewers neither set nor see`() {
        assertTrue(ok(api("POST", "$pid/tags", form = "addtags=pcs-refer-scope")))
        assertTrue("pcs-refer-scope#0" in tagsSeenBy(null, pid))
        for (who in listOf(ac, "r1@example.org", "r3@example.org", "ac-busy@example.org", "author13@example.org")) {
            assertFalse(tagsSeenBy(who, pid).any { it.startsWith("pcs-") }, "$who must not see PC Supervisor's tags")
        }
        assertFalse(ok(setTags(ac, pid, "pcs-keep")), "an AC isn't an administrator, so can't forge a trace")
        assertFalse(ok(setTags("r3@example.org", pid, "pcs-keep")))
    }

    @Test
    @Covers("conv:2")
    fun `screening findings - a reviewer-visible comment reaches the AC, and reviewers only after their own review, until the chair hides it`() {
        val r = api("POST", "$pid/comment", json = """{"text":"Synthetic screening record.","visibility":"rev"}""")
        assertTrue(ok(r), r.toString())
        val cid = r["comment"]!!.jsonObject.str("cid")!!

        fun sees(who: String) = api("GET", "$pid/comments", mapOf("actas" to who))["comments"]?.jsonArray?.any { it.jsonObject.str("cid") == cid } ?: false
        assertTrue(sees(ac), "the AC sees it before writing their metareview")
        for (rev in reviewersOf(pid)) {
            val who = rev.str("reviewer_email")!!
            assertEquals(rev.str("status") == "complete", sees(who), "$who (${rev.str("status")})")
        }
        assertFalse(sees(outsider(pid)))
        assertFalse(sees("ac-busy@example.org"))
        val hidden = api("POST", "$pid/comment", mapOf("c" to cid), json = """{"text":"Synthetic screening record.","visibility":"admin"}""")
        assertTrue(ok(hidden), hidden.toString())
        assertFalse(sees(ac), "after triage the chair can withdraw it to admin visibility")
    }

    @Test
    @Covers("conv:3", "conv:1")
    fun `second opinion under Q5 - the chair unsubmits the screen review and moves it to the normal round`() {
        val member = outsider(pid)
        assertTrue(ok(assign("""{"pid":$pid,"action":"pcreview","user":"$member","round":"screen"}""")))
        val rid = reviewsSeenBy(null, pid).single { it.str("reviewer_email") == member }.str("rid")!!
        val saved =
            api(
                "POST",
                "$pid/review",
                mapOf("r" to rid, "actas" to member),
                json = """{"object":"review","ComPC":"Synthetic second opinion.","status":"complete"}""",
            )
        assertTrue(ok(saved), saved.toString())
        assertEquals("complete", reviewsSeenBy(null, pid).single { it.str("reviewer_email") == member }.str("status"))
        val moved =
            assign(
                """{"pid":$pid,"action":"unsubmitreview","user":"$member"}""",
                """{"pid":$pid,"action":"pcreview","user":"$member","round":"unnamed"}""",
            )
        assertTrue(ok(moved), moved.toString())
        val after = reviewsSeenBy(null, pid).single { it.str("reviewer_email") == member }
        assertEquals("draft", after.str("status"))
        assertEquals(null, after.str("round"), "back in the unnamed round, so the member now writes their full review")
        assertEquals("Synthetic second opinion.", after.str("ComPC")?.trim(), "the screen text is kept")
    }

    @Test
    @Covers("conv:9")
    fun `tag values are numbers - dispositions need numeric codes`() {
        assertTrue(ok(api("POST", "$pid/tags", form = "addtags=" + URLEncoder.encode("pcs-req-C1#2", Charsets.UTF_8))))
        assertFalse(ok(api("POST", "$pid/tags", form = "addtags=" + URLEncoder.encode("pcs-req-C2#revised", Charsets.UTF_8))))
        assertTrue("pcs-req-C1#2" in tagsSeenBy(null, pid))
    }

    @Test
    @Covers("conv:10", "conv:17")
    fun `chair-only tags - only chairs set or see them`() {
        assertTrue(ok(api("POST", "$pid/tags", form = "addtags=" + URLEncoder.encode("~~pcs-case-1#1", Charsets.UTF_8))))
        assertFalse(ok(setTags(ac, pid, "~~pcs-case-2#1")))
        assertFalse(tagsSeenBy(ac, pid).any { it.startsWith("~~") })
        assertTrue("~~pcs-case-1#1" in tagsSeenBy(null, pid))
    }

    @Test
    @Covers("conv:15")
    fun `early-reject objection - a chair records pcs-er-object, which ACs and reviewers neither set nor see`() {
        assertFalse(ok(setTags(ac, pid, "pcs-er-object")), "an AC isn't an administrator, so can't object by tag")
        assertTrue(ok(api("POST", "$pid/tags", form = "addtags=pcs-er-object")))
        assertTrue("pcs-er-object#0" in tagsSeenBy(null, pid))
        for (who in listOf(ac, "r1@example.org", "author13@example.org")) {
            assertFalse(tagsSeenBy(who, pid).any { it.startsWith("pcs-er-object") }, "$who must not see the objection")
        }
        assertEquals(listOf(pcs.core.rules.Trace.EarlyObjection(pid.toLong())), pcs.core.rules.Conventions.decode(pid.toLong(), listOf("pcs-er-object#0")))
    }

    @Test
    @Covers("conv:16")
    fun `accountability reminder - the chair records pcs-remind with no value, and others neither set nor see it`() {
        assertFalse(ok(setTags(ac, pid, "pcs-remind-C1")), "an AC can't record a reminder")
        assertTrue(ok(api("POST", "$pid/tags", form = "addtags=pcs-remind-C1")))
        assertTrue("pcs-remind-C1#0" in tagsSeenBy(null, pid))
        for (who in listOf(ac, "r1@example.org", "author13@example.org")) {
            assertFalse(tagsSeenBy(who, pid).any { it.startsWith("pcs-remind") }, "$who must not see the reminder")
        }
        assertEquals(
            listOf(pcs.core.rules.Trace.Reminder(pid.toLong(), "C", 1)),
            pcs.core.rules.Conventions.decode(pid.toLong(), listOf("pcs-remind-C1#0")),
        )
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
    @Covers("conv:1", "conv:9", "conv:10", "conv:15", "conv:16", "conv:17")
    fun `round trip - traces the chairs write in HotCRP are decoded by core after a sync`() {
        assertTrue(
            ok(api("POST", "$pid/tags", form = "addtags=" + URLEncoder.encode("pcs-refer-scope pcs-req-B1#3 pcs-remind-B1 pcs-er-object", Charsets.UTF_8))),
        )
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
            assertTrue(pcs.core.rules.Trace.Reminder(pid.toLong(), "B", 1) in traces, traces.toString())
            assertTrue(pcs.core.rules.Trace.EarlyObjection(pid.toLong()) in traces, traces.toString())
            assertTrue(traces.none { it is pcs.core.rules.Trace.Unparsed }, traces.toString())
        }
    }
}
