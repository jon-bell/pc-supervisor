package net.jonbell.pcs.core

import kotlinx.coroutines.runBlocking
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.Sync
import net.jonbell.pcs.core.store.SyncCounts
import net.jonbell.pcs.core.time.Clock
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.TestMethodOrder
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.time.Instant

/**
 * PLAN M3 against the harness seeded with `golden` (it runs after the seed tests and changes the
 * harness in stage 2). Expected values come from the golden scenario and the stage-2 changes.
 */
@Order(1)
@Family("T11")
@Covers("prop:H3")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class MirrorTest {
    private val dbFile = Files.createTempFile("pcs-mirror", ".db").also { Files.delete(it) }
    private val store = Store.open(dbFile, "test-only-key")
    private var t = Instant.parse("2030-02-26T17:00:00Z")
    private val clock = Clock { t }

    private fun sync(): SyncCounts = runBlocking { Harness.client().use { Sync(store, clock).run(it) } }

    private fun one(sql: String): Long =
        store.conn.createStatement().use { s ->
            s.executeQuery(sql).use {
                it.next()
                it.getLong(1)
            }
        }

    private val http = HttpClient.newHttpClient()

    private fun post(path: String, params: Map<String, String>, json: String? = null) {
        val q = (params + ("pretty" to "0") + ("notify" to "0")).entries.joinToString("&") { "${it.key}=${URLEncoder.encode(it.value, Charsets.UTF_8)}" }
        val b = HttpRequest.newBuilder(URI("${Harness.url}/api/$path?$q")).header("Authorization", "Bearer ${System.getenv("PCS_HOTCRP_TOKEN")}")
        val req =
            (
                if (json !=
                    null
                ) {
                    b.header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(json))
                } else {
                    b.POST(HttpRequest.BodyPublishers.noBody())
                }
            ).build()
        var r = http.send(req, HttpResponse.BodyHandlers.ofString())
        repeat(6) {
            if (r.statusCode() != 429) return@repeat
            Thread.sleep((r.headers().firstValue("Retry-After").orElse("5").toLong() * 1000).coerceAtMost(60_000))
            r = http.send(req, HttpResponse.BodyHandlers.ofString())
        }
        check(r.statusCode() == 200 && r.body().contains("\"ok\":true")) { "$path: ${r.body().take(300)}" }
    }

    @Test
    @Order(1)
    fun `the first sync mirrors golden`() {
        val c = sync()
        assertEquals(13, c.newRows["paper"])
        assertEquals(52, c.newRows["review"], "39 assigned reviews plus 13 metareviews")
        assertEquals(37, c.newRows["comment"])
        assertEquals(38L, one("SELECT count(*) FROM review WHERE first_complete_seen_at IS NOT NULL"))
        assertEquals(38L, one("SELECT count(*) FROM review_text WHERE field_uid='PapSum'"))
        assertEquals(1L, one("SELECT count(*) FROM comment WHERE pid=4 AND mentions LIKE '%r-pinged@example.org%'"))
        assertEquals(1L, one("SELECT count(*) FROM comment WHERE response_round IS NOT NULL"))
        assertEquals(1L, one("SELECT count(*) FROM fts WHERE fts MATCH 'convinced'"))
        assertEquals(1L, one("SELECT count(*) FROM paper WHERE decision IS NOT NULL"))
    }

    @Test
    @Order(2)
    fun `a second sync with no changes writes nothing`() {
        t = t.plusSeconds(900)
        val before = listOf("review_version", "review_text", "comment_text", "rating_change", "fts").associateWith { store.count(it) }
        val c = sync()
        assertTrue(c.isNoop, c.toString())
        assertEquals(before, listOf("review_version", "review_text", "comment_text", "rating_change", "fts").associateWith { store.count(it) })
    }

    @Test
    @Order(3)
    @Covers(
        "prop:H3",
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
    )
    fun `after the history backfill, the discussion rules fire exactly the golden table`() {
        val added = runBlocking { Harness.client().use { net.jonbell.pcs.core.store.Backfill(store, clock).run(it, rps = 50) } }
        assertTrue(added > 0, "the backfill added history versions")
        val et = java.time.ZoneId.of("America/New_York")
        val ph =
            net.jonbell.pcs.core.rules.Phases(
                reviewDue = java.time.LocalDateTime.parse("2030-02-01T23:59").atZone(et).toInstant(),
                discussionOpen = java.time.LocalDateTime.parse("2030-02-12T00:00").atZone(et).toInstant(),
                decisionsDue = java.time.LocalDateTime.parse("2030-03-03T23:59").atZone(et).toInstant(),
            )
        val view = net.jonbell.pcs.core.store.MirrorView.load(store)
        val now = java.time.LocalDateTime.parse("2030-02-26T12:00").atZone(et).toInstant()
        val fired = view.associate { p -> p.pid to net.jonbell.pcs.core.rules.Discussion.reasons(p, ph, now).map { it.rule }.toSet() }
        val expected =
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
        assertEquals(expected, fired)
        val second = java.time.LocalDateTime.parse("2030-03-01T12:00").atZone(et).toInstant()
        val later = view.associate { p -> p.pid to net.jonbell.pcs.core.rules.Discussion.reasons(p, ph, second).map { it.rule }.toSet() }
        assertTrue("DEADLINE_NO_CONSENSUS" in later.getValue(12L), later.toString())
        assertEquals(setOf<String>(), later.getValue(1L))
    }

    @Test
    @Order(4)
    fun `stage 2 changes are recorded exactly`() {
        val ridR4 = one("SELECT r.rid FROM review r WHERE r.pid=12 AND r.email='r4@example.org'")
        val cidEdit = one("SELECT cid FROM comment WHERE pid=9 AND email='r3@example.org'")
        val cidDelete = one("SELECT cid FROM comment WHERE pid=9 AND email='r4@example.org'")
        val versionsBefore = store.count("review_version")
        post("reviews", emptyMap(), """[{"pid":12,"rid":$ridR4,"OveMer":3,"submitted":true}]""")
        post("9/comment", mapOf("actas" to "r5@example.org"), """{"text":"A new synthetic comment.","visibility":"rev"}""")
        post("9/comment", mapOf("actas" to "r3@example.org", "c" to "$cidEdit"), """{"text":"An edited synthetic comment.","visibility":"rev"}""")
        post("9/comment", mapOf("actas" to "r4@example.org", "c" to "$cidDelete", "delete" to "1"))
        val p =
            ProcessBuilder(
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
                "batch/assign.php",
            )
                .redirectErrorStream(true).start()
        p.outputStream.use { it.write("paper,action,user\n2,clearreview,n-laggard@example.org\n".toByteArray()) }
        check(p.waitFor() == 0) { p.inputStream.bufferedReader().readText() }

        t = t.plusSeconds(86400)
        val c = sync()
        assertEquals(1, c.changed["review"], c.toString())
        assertEquals(versionsBefore + 1, store.count("review_version"))
        assertEquals(1, c.newRows["comment"], c.toString())
        assertEquals(2, c.newRows["comment_text"], "the new comment and the edit")
        assertEquals(1, c.changed["comment"], c.toString())
        assertEquals(1, c.gone["comment"], c.toString())
        assertEquals(1, c.gone["assignment"], c.toString())
        assertEquals(1, c.gone["review"], c.toString())
        assertEquals(t.epochSecond, one("SELECT deleted_seen_at FROM comment WHERE cid=$cidDelete"))
        assertEquals(t.epochSecond, one("SELECT c.first_seen_at FROM comment c JOIN comment_text x ON x.cid = c.cid WHERE x.text = 'A new synthetic comment.'"))
        assertEquals(2L, one("SELECT count(*) FROM comment_text WHERE cid=$cidEdit"), "both versions of the edited comment are kept")
        t = t.plusSeconds(900)
        assertTrue(sync().isNoop, "and the next sync is again a no-op")
    }
}
