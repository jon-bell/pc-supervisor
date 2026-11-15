@file:Suppress("ktlint:standard:max-line-length")

package net.jonbell.pcs.agent

import kotlinx.coroutines.runBlocking
import net.jonbell.pcs.core.hotcrp.HotcrpClient
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.Sync
import net.jonbell.pcs.core.time.Clock
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import net.jonbell.pcs.testing.LocalHarness
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.time.Instant

/**
 * `prop:S6`, through T6: the screening agent has no write path to HotCRP. The agent holds no HotCRP credential at all
 * (policy table 3.9: it may not read or write HotCRP), so "the agent's credentials" are none, a malformed one, and the
 * only secret it does hold, an engine API key. Each HotCRP write the system knows (and the rest of the API's writes) is
 * attempted with each; all must be refused and change nothing. The other half is structural: no agent class refers to the
 * code that can write.
 */
@Family("T6")
@Covers("prop:S6")
class AgentNoWriteTest {
    private val url: URI = LocalHarness.require(System.getenv("PCS_HOTCRP_URL") ?: error("PCS_HOTCRP_URL not set"))
    private val token = System.getenv("PCS_HOTCRP_TOKEN") ?: error("PCS_HOTCRP_TOKEN not set")
    private val http = HttpClient.newHttpClient()

    /** What the agent could present: nothing, a malformed header, an engine provider's key. */
    private val credentials: List<Pair<String, String?>> =
        listOf("no credential" to null, "malformed bearer" to "Bearer", "engine API key" to "Bearer sk-ant-api03-synthetic-engine-key-not-a-hotcrp-token")

    private class Attempt(val name: String, val method: String, val path: String, val body: String?)

    private fun attempts(pid: Long): List<Attempt> {
        val tag = """[{"paper":$pid,"action":"tag","tag":"agent-wrote-this"}]"""
        return listOf(
            Attempt("assign (Writeback's bulk assignment)", "POST", "assign?format=json", tag),
            Attempt("assign, tag action as a form", "POST", "assign?format=json&p=$pid", tag),
            Attempt("comment (Writeback's findings comment)", "POST", "$pid/comment", """{"text":"[pcs:findings] written by the agent","visibility":"pc"}"""),
            Attempt("create a paper", "POST", "paper", """{"object":"paper","title":"agent paper","authors":[],"abstract":"x","status":"submitted"}"""),
            Attempt("edit a paper", "POST", "$pid/paper", """{"object":"paper","pid":$pid,"title":"edited by the agent"}"""),
            Attempt("delete a paper", "DELETE", "$pid/paper", null),
            Attempt("save a review", "POST", "$pid/review", """{"ovemer":"A","revexp":"X"}"""),
            Attempt("set tags", "POST", "$pid/tags", """{"tags":"agent-wrote-this"}"""),
            Attempt("set a decision", "POST", "$pid/decision", """{"decision":"reject"}"""),
            Attempt("change settings", "POST", "settings", """{"sub_open":"no"}"""),
        )
    }

    private fun send(method: String, path: String, body: String?, auth: String?): Pair<Int, String> {
        val sep = if ('?' in path) "&" else "?"
        val b = HttpRequest.newBuilder(URI("$url/api/$path${sep}pretty=0&notify=0"))
        if (auth != null) b.header("Authorization", auth)
        if (body != null) b.header("Content-Type", "application/json")
        val req = b.method(method, if (body != null) HttpRequest.BodyPublishers.ofString(body) else HttpRequest.BodyPublishers.noBody()).build()
        var r = http.send(req, HttpResponse.BodyHandlers.ofString())
        repeat(6) {
            if (r.statusCode() != 429) return@repeat
            Thread.sleep((r.headers().firstValue("Retry-After").orElse("5").toLong() * 1000).coerceAtMost(30_000))
            r = http.send(req, HttpResponse.BodyHandlers.ofString())
        }
        return r.statusCode() to r.body()
    }

    /** Everything a write could change in what the app mirrors, without the sync's own timestamps. */
    private fun fingerprint(): String {
        val dir = Files.createTempDirectory("pcs-s6")
        try {
            Store.open(dir.resolve("m.db"), "test-only-key").use { s ->
                runBlocking { HotcrpClient(url, token, chunk = 5).use { Sync(s, Clock { Instant.parse("2030-02-26T17:00:00Z") }).run(it) } }

                fun rows(sql: String) =
                    s.conn.createStatement().use { st ->
                        st.executeQuery(sql).use { rs ->
                            generateSequence {
                                if (rs.next()) {
                                    (1..rs.metaData.columnCount).joinToString("|") { rs.getString(it).orEmpty() }
                                } else {
                                    null
                                }
                            }.toList()
                        }
                    }
                return (
                    rows("SELECT pid,title,decision,tags FROM paper ORDER BY pid") +
                        rows("SELECT cid,pid,email,draft,modified_at FROM comment ORDER BY cid") +
                        rows("SELECT rid,pid,email,status,scores FROM review ORDER BY rid")
                ).joinToString("\n")
            }
        } finally {
            dir.toFile().deleteRecursively()
        }
    }

    @Test
    fun `every HotCRP write attempted with the agent's credentials is refused and changes nothing`() {
        val before = fingerprint()
        val pid = before.lineSequence().first().substringBefore('|').toLong()
        // Control: the same request shapes are accepted from a chair (as a dry run, which changes nothing), so a refusal below is about the credential.
        val chair = "Bearer $token"
        val a = attempts(pid)
        val assignControl = send("POST", "assign?format=json&dry_run=1", a[0].body, chair)
        assertEquals(200, assignControl.first, assignControl.second)
        assertTrue(assignControl.second.contains("\"ok\": true") || assignControl.second.contains("\"ok\":true"), assignControl.second)
        val commentControl = send("POST", "$pid/comment?dry_run=1", a[2].body, chair)
        assertEquals(200, commentControl.first, commentControl.second)
        assertTrue(commentControl.second.contains("\"ok\": true") || commentControl.second.contains("\"ok\":true"), commentControl.second)

        var refused = 0
        for (att in a) {
            for ((who, auth) in credentials) {
                val (code, body) = send(att.method, att.path, att.body, auth)
                assertTrue(code in setOf(401, 403, 404, 405), "${att.name} with $who: HTTP $code")
                assertTrue(!body.contains("\"ok\": true") && !body.contains("\"ok\":true"), "${att.name} with $who was not refused: $body")
                refused++
            }
        }
        assertEquals(a.size * credentials.size, refused)
        assertEquals(before, fingerprint(), "nothing in HotCRP changed")
    }

    @Test
    fun `no class of the agent refers to a HotCRP client or writer`() {
        val classes = File(System.getProperty("pcs.repoRoot"), "agent/build/classes/kotlin/main")
        assertTrue(classes.isDirectory, "the agent's classes are built: $classes")
        val forbidden =
            listOf("net/jonbell/pcs/core/hotcrp/", "net/jonbell/pcs/core/writeback/", "net/jonbell/pcs/core/store/Sync", "HotcrpWriter", "HotcrpClient")
        val files = classes.walkTopDown().filter { it.isFile && it.name.endsWith(".class") }.toList()
        assertTrue(files.size > 100, "scanned ${files.size} classes")
        val hits = files.flatMap { f -> String(f.readBytes(), Charsets.ISO_8859_1).let { t -> forbidden.filter { it in t }.map { "${f.name} -> $it" } } }
        assertEquals(emptyList<String>(), hits)
        // The agent's bundle has no field that could carry a write: it holds findings, summaries, a manifest.
        assertEquals(
            setOf("manifest", "findings", "summaries"),
            net.jonbell.pcs.core.bundle.BundlePayload.serializer().descriptor.let { d -> (0 until d.elementsCount).map { d.getElementName(it) }.toSet() },
        )
    }
}
