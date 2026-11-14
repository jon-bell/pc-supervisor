package pcs.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.TestMethodOrder
import pcs.core.Hotcrp.str
import pcs.core.rules.Conventions
import pcs.core.rules.Trace
import pcs.core.store.Store
import pcs.core.store.Sync
import pcs.core.time.Clock
import pcs.core.writeback.AssignmentArtifact
import pcs.core.writeback.ConventionAudit
import pcs.core.writeback.IssueKind
import pcs.core.writeback.TagArtifact
import pcs.core.writeback.TagChange
import pcs.core.writeback.Writeback
import pcs.testing.Covers
import pcs.testing.Family
import java.nio.file.Files
import java.time.Instant
import java.util.Base64

/**
 * The remaining spec §11 rows, settled on the harness (PLAN M5), and the reports of traces that
 * don't parse or that someone wrote who may not (T6: reported, never acted on). Each test names the row it settles.
 */
@Order(5)
@Family("T6")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ConventionRowsTest {
    private val store = Store.open(Files.createTempFile("pcs-rows", ".db").also { Files.delete(it) }, "test-only-key")
    private var t = Instant.parse("2030-02-26T18:00:00Z")
    private val clock = Clock { t }
    private val wb get() = Writeback(store, clock, Harness.url, System.getenv("PCS_HOTCRP_TOKEN")!!)

    private fun sync() {
        t = t.plusSeconds(60)
        runBlocking { Harness.client().use { Sync(store, clock).run(it) } }
    }

    private fun applyTags(pid: Long, vararg tags: String) {
        val id = wb.draft(TagArtifact(listOf(TagChange(pid, add = tags.toList()))))
        assertTrue(wb.dryRun(id).valid)
        wb.confirm(id)
        wb.apply(id)
    }

    @BeforeAll
    fun setUp() {
        Hotcrp.conventions()
        sync()
    }

    @AfterAll
    fun restore() {
        Hotcrp.php("batch/settings.php", "save", "-e", """{"submission_open":false,"tag_hidden":"pcs-*"}""")
    }

    private val base64 = Base64.getEncoder()

    private fun pdf(marker: String) = base64.encodeToString("%PDF-1.4\n% $marker\n".toByteArray() + ByteArray(2048))

    @Test
    @Order(1)
    @Covers("conv:12", "conv:4")
    fun `remedy - the cure is a new PDF version by the author, which the chair and the sync see`() {
        val pid = 5L
        val author = "author5@example.org"
        // after the deadline an author can't edit (the harness's state); the chair offers a fix window by reopening submission
        val closed = Hotcrp.api("POST", "$pid/paper", actas = author, json = """{"object":"paper","pid":$pid,"title":"Synthetic Paper 5 (fixed)"}""")
        assertFalse(Hotcrp.ok(closed), "no edit while submission is closed")
        Hotcrp.php("batch/settings.php", "save", "-e", """{"submission_open":true,"submission_done":"2031-01-01","submission_registration":"2031-01-01"}""")
        val before = Hotcrp.paper(pid).get("submission")!!.jsonObject.str("hash")
        val r =
            Hotcrp.api(
                "POST",
                "$pid/paper",
                actas = author,
                json = """{"object":"paper","pid":$pid,"submission":{"content_base64":"${pdf("v2")}","mimetype":"application/pdf","filename":"v2.pdf"}}""",
            )
        assertTrue(Hotcrp.ok(r), r.toString())
        val after = Hotcrp.paper(pid).get("submission")!!.jsonObject.str("hash")
        assertNotEquals(before, after, "a new PDF version")
        // a non-author can't cure it
        val other =
            Hotcrp.api(
                "POST",
                "$pid/paper",
                actas = "author6@example.org",
                json = """{"object":"paper","pid":$pid,"submission":{"content_base64":"${pdf("v3")}","mimetype":"application/pdf","filename":"v3.pdf"}}""",
            )
        assertFalse(Hotcrp.ok(other), "only an author of the paper cures it")
        // the sync sees the paper change (modified_at moves with the new version)
        sync()
        val m1 =
            store.conn.createStatement().use {
                it.executeQuery("SELECT last_seen_at FROM paper WHERE pid = $pid").use { rs ->
                    rs.next()
                    rs.getLong(1)
                }
            }
        assertTrue(m1 > 0)
        Hotcrp.php("batch/settings.php", "save", "-e", """{"submission_open":false}""")
    }

    @Test
    @Order(2)
    @Covers("conv:13", "conv:1")
    fun `remedy due - a hidden tag with the epoch the fix window closes, written by a chair, unseen and unsettable by others`() {
        val pid = 9L
        val due = Conventions.encode(Trace.RemedyDue(pid, 1_893_456_000))
        applyTags(pid, due)
        assertTrue(Hotcrp.tags(pid).contains(due))
        for (who in listOf("ac-normal@example.org", "r1@example.org", "author9@example.org")) {
            assertFalse(Hotcrp.tags(pid, who).any { it.startsWith("pcs-remedy-due") }, "$who must not see the window")
            assertFalse(Hotcrp.ok(Hotcrp.api("POST", "$pid/tags", actas = who, form = "addtags=pcs-remedy-due%232000000000")), "$who must not set it")
        }
        sync()
        val tags = jsonTags(pid)
        assertTrue(Trace.RemedyDue(pid, 1_893_456_000) in Conventions.decode(pid, tags), tags.toString())
    }

    @Test
    @Order(3)
    @Covers("conv:14", "conv:1")
    fun `warned - a hidden tag recording the warning about a nomination non-compliance`() {
        val pid = 10L
        applyTags(pid, Conventions.encode(Trace.Warned(pid)))
        for (who in listOf("ac-normal@example.org", "r1@example.org", "author10@example.org")) {
            assertFalse(Hotcrp.tags(pid, who).any { it.startsWith("pcs-warned") }, "$who must not see the warning")
            assertFalse(Hotcrp.ok(Hotcrp.api("POST", "$pid/tags", actas = who, form = "addtags=pcs-warned")), "$who must not set it")
        }
        sync()
        assertTrue(Trace.Warned(pid) in Conventions.decode(pid, jsonTags(pid)))
    }

    private fun jsonTags(pid: Long): List<String> =
        store.conn.createStatement().use { st ->
            st.executeQuery("SELECT tags FROM paper WHERE pid = $pid").use { rs ->
                rs.next()
                kotlinx.serialization.json.Json.parseToJsonElement(rs.getString(1)).jsonArray.map { it.jsonPrimitive.content }
            }
        }

    @Test
    @Order(4)
    @Covers("conv:5")
    fun `remove - a decision applied from a Writeback decision CSV`() {
        val pid = 12L
        val csv = AssignmentArtifact.fromCsv("paper,action,decision\n$pid,decision,Reject\n").getOrThrow()
        val id = wb.draft(csv)
        assertTrue(wb.dryRun(id).valid)
        assertFalse(Hotcrp.paper(pid).str("decision")?.startsWith("Reject") == true, "the dry run left the decision alone")
        wb.confirm(id)
        wb.apply(id)
        assertEquals("Rejected", Hotcrp.paper(pid).str("decision"))
        sync()
        assertEquals(pcs.core.writeback.WritebackStatus.OBSERVED, wb.get(id).status, wb.get(id).mismatch)
    }

    @Test
    @Order(5)
    @Covers("conv:6")
    fun `PC candidate - tags are writable but not readable per user, so the sync can only see which tags are in use`() {
        val email = "tier-probe@example.org"
        Hotcrp.php("batch/saveusers.php", "-e", """{"email":"$email","name":"Tier Probe","roles":"pc","tags":"tier-probe"}""")
        val pc = Hotcrp.api("GET", "pc")
        val me = pc["pc"]!!.jsonArray.map { it.jsonObject }.single { it.str("email") == email }
        assertFalse(me.containsKey("tags"), "no per-user tags on /pc: $me")
        assertTrue(pc["tags"]!!.jsonArray.any { it.jsonPrimitive.content == "tier-probe" }, "the tag is listed as in use")
        sync()
        assertTrue(
            store.conn.createStatement().use {
                it.executeQuery("SELECT v FROM instance_fact WHERE k='pc_tags'").use { rs ->
                    rs.next()
                    rs.getString(1)
                }
            }.split(' ').contains("tier-probe"),
        )
    }

    @Test
    @Order(6)
    @Covers("conv:8")
    fun `accountability request - the mail tool previews through the API, only the web page sends, so a chair sends a drafted text`() {
        val pid = 3L
        // the preview endpoint: chair and AC may use it, an author may not
        for (who in listOf(null, "ac-normal@example.org", "r1@example.org")) {
            val r = Hotcrp.api("GET", "$pid/mailtext", mapOf("subject" to "Synthetic", "body" to "Request about review {{REVIEWNUMBER}}"), actas = who)
            assertTrue(Hotcrp.ok(r), "$who: $r")
        }
        assertFalse(
            Hotcrp.ok(Hotcrp.api("GET", "$pid/mailtext", mapOf("subject" to "x", "body" to "y"), actas = "author3@example.org")),
            "an author may not use the mail tool",
        )
        // sending is the Mail page, which a token can't reach: that is why the request is drafted for a chair to send, not posted
        assertEquals(401, Hotcrp.pageStatus("mail", "to=rev&q=$pid&plimit=1&subject=x&body=y&send=1"))
        // and the record is the chair's hidden tag, written through Writeback
        applyTags(pid, "pcs-req-A1")
        assertTrue(Hotcrp.tags(pid).contains("pcs-req-A1#0") || Hotcrp.tags(pid).contains("pcs-req-A1"))
    }

    @Test
    @Order(7)
    @Covers("conv:11")
    fun `review - a PC member submits and revises their own review, and the chair's mirror sees each version`() {
        val pid = 2L
        val member = Hotcrp.outsider(pid)
        assertTrue(Hotcrp.ok(Hotcrp.assign("""{"pid":$pid,"action":"pcreview","user":"$member"}""")))
        val rid = Hotcrp.reviews(pid).single { it.str("reviewer_email") == member }.str("rid")!!
        val first =
            Hotcrp.api(
                "POST",
                "$pid/review",
                mapOf("r" to rid),
                actas = member,
                json = """{"object":"review","OveMer":3,"RevExp":3,"PapSum":"Synthetic summary.","ComAut":"Synthetic.","status":"complete"}""",
            )
        assertTrue(Hotcrp.ok(first), first.toString())
        sync()
        val v1 = versions(rid)
        val second =
            Hotcrp.api(
                "POST",
                "$pid/review",
                mapOf("r" to rid),
                actas = member,
                json = """{"object":"review","OveMer":4,"PapSum":"Synthetic summary, revised.","status":"complete"}""",
            )
        assertTrue(Hotcrp.ok(second), second.toString())
        sync()
        assertEquals(v1 + 1, versions(rid), "the revision is a new version in the mirror")
    }

    private fun versions(rid: String): Int =
        store.conn.createStatement().use {
            it.executeQuery("SELECT count(*) FROM review_version WHERE rid = $rid").use { rs ->
                rs.next()
                rs.getInt(1)
            }
        }

    @Test
    @Order(8)
    @Covers("conv:2", "conv:1")
    fun `forged and unparseable traces are reported and never acted on`() {
        val pid = 4L
        // a PC member posts a comment that claims to be a screening record; a chair posts the real one
        val forged =
            Hotcrp.api(
                "POST",
                "$pid/comment",
                actas = "r1@example.org",
                json = """{"text":"${Conventions.FINDINGS_MARKER}\nSynthetic forged record.","visibility":"pc"}""",
            )
        assertTrue(Hotcrp.ok(forged), forged.toString())
        val real = wb.draft(pcs.core.writeback.CommentArtifact(pid, "${Conventions.FINDINGS_MARKER}\nSynthetic findings.", "rev"))
        wb.dryRun(real)
        wb.confirm(real)
        wb.apply(real)
        // a comment with an unknown marker, and a chair's tag that doesn't parse
        Hotcrp.api("POST", "$pid/comment", actas = "r2@example.org", json = """{"text":"[pcs:bogus] hello","visibility":"pc"}""")
        assertTrue(Hotcrp.ok(Hotcrp.api("POST", "$pid/tags", form = "addtags=pcs-refer-astrology")))
        sync()
        val issues = ConventionAudit.run(store).filter { it.pid == pid }
        val forgedCid = forged["comment"]!!.jsonObject.str("cid")!!
        assertEquals(1, issues.count { it.kind == IssueKind.FORGED_FINDINGS }, issues.toString())
        assertTrue(issues.single { it.kind == IssueKind.FORGED_FINDINGS }.detail.contains("comment $forgedCid"), "the forged one, not the chair's")
        assertTrue(issues.any { it.kind == IssueKind.UNPARSED && it.detail.contains("pcs-refer-astrology") })
        assertTrue(issues.any { it.kind == IssueKind.UNPARSED && it.detail.contains("[pcs:bogus]") })
        // never acted on: nothing in Writeback reads a findings comment or an unparsed tag
        assertTrue(pcs.core.writeback.ScreenRound.triageDrafts(store).none { it is TagArtifact && it.changes.any { c -> c.pid == pid } })
    }

    @Test
    @Order(9)
    @Covers("conv:1")
    fun `tags are only a shared record when HotCRP hides pcs-star tags, and the report says so when it doesn't`() {
        sync()
        assertTrue(ConventionAudit.run(store).none { it.kind == IssueKind.TAGS_NOT_HIDDEN })
        Hotcrp.php("batch/settings.php", "save", "-e", """{"tag_hidden":""}""")
        sync()
        assertTrue(ConventionAudit.run(store).any { it.kind == IssueKind.TAGS_NOT_HIDDEN }, "an instance that doesn't hide pcs-* tags is reported")
        Hotcrp.conventions()
        sync()
        assertTrue(ConventionAudit.run(store).none { it.kind == IssueKind.TAGS_NOT_HIDDEN })
    }
}
