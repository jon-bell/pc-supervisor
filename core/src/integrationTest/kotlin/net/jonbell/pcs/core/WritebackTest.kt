package net.jonbell.pcs.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.core.Hotcrp.str
import net.jonbell.pcs.core.hotcrp.HotcrpLinks
import net.jonbell.pcs.core.rules.Faults
import net.jonbell.pcs.core.rules.Trace
import net.jonbell.pcs.core.store.Load
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.Sync
import net.jonbell.pcs.core.time.Clock
import net.jonbell.pcs.core.writeback.Artifact
import net.jonbell.pcs.core.writeback.AssignmentArtifact
import net.jonbell.pcs.core.writeback.CommentArtifact
import net.jonbell.pcs.core.writeback.ConventionAudit
import net.jonbell.pcs.core.writeback.DecisionArtifact
import net.jonbell.pcs.core.writeback.FirstActions
import net.jonbell.pcs.core.writeback.Ledger
import net.jonbell.pcs.core.writeback.ReviewMove
import net.jonbell.pcs.core.writeback.ReviewMoveArtifact
import net.jonbell.pcs.core.writeback.ScreenRound
import net.jonbell.pcs.core.writeback.TagArtifact
import net.jonbell.pcs.core.writeback.TagChange
import net.jonbell.pcs.core.writeback.UserArtifact
import net.jonbell.pcs.core.writeback.UserChange
import net.jonbell.pcs.core.writeback.Writeback
import net.jonbell.pcs.core.writeback.WritebackException
import net.jonbell.pcs.core.writeback.WritebackStatus
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.TestMethodOrder
import java.nio.file.Files
import java.time.Instant

/**
 * Writeback end to end on the harness (PLAN M5): for each artifact kind the dry run changes nothing,
 * the confirmed run makes the change, and the next sync observes it; an applied artifact whose effect
 * is later reverted is flagged. Expectations are read from HotCRP itself (`Hotcrp`), not from `core`.
 * Runs on `golden`, after the convention tests, on papers they don't touch.
 */
@Order(4)
@Family("T3")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class WritebackTest {
    private val store = Store.open(Files.createTempFile("pcs-wb", ".db").also { Files.delete(it) }, "test-only-key")
    private var t = Instant.parse("2030-02-26T17:00:00Z")
    private val clock = Clock { t }
    private val token = System.getenv("PCS_HOTCRP_TOKEN")!!
    private val wb get() = Writeback(store, clock, Harness.url, token)

    private fun sync() {
        t = t.plusSeconds(60)
        runBlocking { Harness.client().use { Sync(store, clock).run(it) } }
    }

    @BeforeAll
    fun setUp() {
        Hotcrp.conventions()
        sync()
    }

    private fun status(id: Long) = wb.get(id).status

    /** The whole lifecycle with the checks that make it Writeback: [applied] reads HotCRP itself. */
    private fun lifecycle(a: Artifact, applied: () -> Boolean): Long {
        assertFalse(applied(), "precondition: the change is not in HotCRP yet")
        val id = wb.draft(a)
        assertFalse(applied(), "drafting changes nothing")
        assertThrows(WritebackException::class.java) { wb.apply(id) }
        assertThrows(WritebackException::class.java) { wb.confirm(id) } // no dry run yet
        val dr = wb.dryRun(id)
        assertTrue(dr.valid, dr.messages.toString())
        assertTrue(dr.lines.isNotEmpty(), "the review screen has a diff to show")
        assertFalse(applied(), "the dry run changes nothing")
        assertThrows(WritebackException::class.java) { wb.apply(id) } // dry run but not confirmed
        assertEquals(WritebackStatus.CONFIRMED, wb.confirm(id).status)
        assertFalse(applied(), "confirming changes nothing")
        val r = wb.apply(id)
        assertTrue(r.status == WritebackStatus.APPLIED || r.status == WritebackStatus.HANDED_OFF, r.status.toString())
        assertTrue(applied(), "the confirmed run makes the change")
        sync()
        assertEquals(WritebackStatus.OBSERVED, status(id), wb.get(id).mismatch)
        assertNotNull(wb.get(id).observedAt)
        return id
    }

    @Test
    @Order(1)
    @Covers("prop:H1", "prop:H2")
    fun `tags - a visible tag and a hidden trace`() {
        val pid = 5L
        val id =
            lifecycle(TagArtifact(listOf(TagChange(pid, add = listOf("chair-attention", "pcs-req-C1#2")))), {
                Hotcrp.tags(pid).any { it.startsWith("chair-attention") }
            })
        assertTrue("pcs-req-C1#2" in Hotcrp.tags(pid))
        assertTrue(
            store.conn.query("SELECT tags FROM paper WHERE pid = $pid") {
                it.getString(1)
            }.single().contains("pcs-req-C1#2"),
            "the mirror shows the hidden trace",
        )
        assertTrue(
            Trace.RequestSent(pid, "C", 1, net.jonbell.pcs.core.rules.ReqDisposition.EXPLAINED) in
                net.jonbell.pcs.core.rules.Conventions.decode(pid, Hotcrp.tags(pid)),
        )
        assertEquals(WritebackStatus.OBSERVED, status(id))
    }

    @Test
    @Order(2)
    @Covers("prop:H1", "prop:H2")
    fun `assignments - a bulk-assign CSV`() {
        val pid = 9L
        val pc = Hotcrp.pcEmails().filter { !it.startsWith("admin") }
        val onPaper = Hotcrp.reviews(pid).mapNotNull { it.str("reviewer_email") }.toSet()
        val who =
            pc.filter { it !in onPaper }.first { e ->
                Hotcrp.api(
                    "POST",
                    "assign",
                    params = mapOf("dry_run" to "1"),
                    json = """[{"pid":$pid,"action":"pcreview","user":"$e"}]""",
                )["valid"]?.jsonPrimitive?.content ==
                    "true"
            }
        val a = AssignmentArtifact.fromCsv("paper,action,email\n$pid,pcreview,$who\n").getOrThrow()
        lifecycle(a, { Hotcrp.reviews(pid).any { it.str("reviewer_email") == who } })
        // revert it through the ledger's own check later (see the mismatch test); here, the mirror agrees
        assertEquals(1, store.conn.query("SELECT count(*) FROM review WHERE pid = $pid AND email = '$who' AND gone_at IS NULL") { it.getInt(1) }.single())
    }

    @Test
    @Order(3)
    @Covers("prop:H1", "prop:H2")
    fun `comments - a findings comment, then the chair re-scopes it to admin`() {
        val pid = 10L
        val text = "${net.jonbell.pcs.core.rules.Conventions.FINDINGS_MARKER}\nSynthetic screening record."
        val before = Hotcrp.comments(pid).size
        val id = lifecycle(CommentArtifact(pid, text, "rev"), { Hotcrp.comments(pid).size > before })
        assertEquals(before + 1, Hotcrp.comments(pid).size)
        val cid = Hotcrp.comments(pid).last { it.str("text")?.startsWith(net.jonbell.pcs.core.rules.Conventions.FINDINGS_MARKER) == true }.str("cid")!!.toLong()
        assertEquals("rev", store.conn.query("SELECT visibility FROM comment WHERE cid = $cid") { it.getString(1) }.single())
        // after triage the chair withdraws it to admin visibility; the first artifact is superseded, not flagged
        lifecycle(CommentArtifact(pid, text, "admin", cid = cid), { Hotcrp.comments(pid).first { it.str("cid") == "$cid" }.str("visibility") == "admin" })
        assertEquals(WritebackStatus.OBSERVED, status(id), "an earlier artifact is not held against a later one")
        assertEquals(before + 1, Hotcrp.comments(pid).size, "an edit, not a second comment")
    }

    @Test
    @Order(4)
    @Covers("prop:H1", "prop:H2")
    fun `decisions - a decision CSV with a notice`() {
        val pid = 11L
        val a = DecisionArtifact(mapOf(pid to "Reject"), notice = "Dear author of paper 11, synthetic notice.")
        lifecycle(a, { Hotcrp.paper(pid).str("decision").let { d -> d != null && d.startsWith("Reject") } })
        assertEquals("Rejected", store.conn.query("SELECT decision FROM paper WHERE pid = $pid") { it.getString(1) }.single())
    }

    @Test
    @Order(5)
    @Covers("prop:H1", "prop:H2", "conv:3", "conv:1")
    fun `review moves - triage, then Q5 second opinions, read from trusted traces only`() {
        val pid = 6L
        val ac = Hotcrp.acOf(pid)!!
        // the AC records the triage in a screen-round metareview (spec §11)
        assertTrue(Hotcrp.ok(Hotcrp.assign("""{"pid":$pid,"action":"metareview","user":"$ac","round":"screen"}""")))
        val mine = Hotcrp.reviews(pid, ac).single { it.str("rtype") == "5" && it.str("reviewer_email") == ac }
        assertTrue(
            Hotcrp.ok(
                Hotcrp.api("POST", "$pid/review", mapOf("r" to mine.str("rid")!!), actas = ac, json = """{"object":"review","Tri":1,"status":"complete"}"""),
            ),
        )
        // a member's second opinion, in the screen round, with a triage value they may not give
        val member = Hotcrp.outsider(pid)
        assertTrue(Hotcrp.ok(Hotcrp.assign("""{"pid":$pid,"action":"pcreview","user":"$member","round":"screen"}""")))
        val rid = Hotcrp.reviews(pid).single { it.str("reviewer_email") == member }.str("rid")!!
        assertTrue(
            Hotcrp.ok(
                Hotcrp.api(
                    "POST",
                    "$pid/review",
                    mapOf("r" to rid),
                    actas = member,
                    json = """{"object":"review","ComPC":"Synthetic second opinion.","Tri":3,"status":"complete"}""",
                ),
            ),
        )
        sync()
        // the member's Triage is reported and ignored; the AC's is the only one acted on
        val trusted = ConventionAudit.trustedTriage(store).filter { it.pid == pid }
        assertEquals(listOf(ac), trusted.map { it.reviewer })
        assertTrue(ConventionAudit.run(store).any { it.kind == net.jonbell.pcs.core.writeback.IssueKind.FORGED_TRIAGE && it.pid == pid })
        val drafts =
            ScreenRound.triageDrafts(store).filter {
                it is TagArtifact &&
                    it.changes.any { c -> c.pid == pid } ||
                    it is ReviewMoveArtifact &&
                    it.moves.any { m -> m.pid == pid }
            }
        assertEquals(2, drafts.size, drafts.toString())
        val tagId = lifecycle(drafts[0], { Hotcrp.tags(pid).any { it.startsWith("pcs-keep") } })
        val moveId = lifecycle(drafts[1], { Hotcrp.reviews(pid).single { it.str("reviewer_email") == ac }.str("round") == null })
        val acReview = Hotcrp.reviews(pid).single { it.str("reviewer_email") == ac }
        assertEquals("draft", acReview.str("status"), "the AC writes the real metareview later")
        assertEquals(WritebackStatus.OBSERVED, status(tagId))
        assertEquals(WritebackStatus.OBSERVED, status(moveId))
        // Q5: the paper is kept, so the second opinion moves to the normal round with its text
        val second = ScreenRound.secondOpinionDrafts(store).filterIsInstance<ReviewMoveArtifact>().single { a -> a.moves.any { it.pid == pid } }
        assertEquals(listOf(ReviewMove(pid, member, meta = false)), second.moves.filter { it.pid == pid })
        lifecycle(second, { Hotcrp.reviews(pid).single { it.str("reviewer_email") == member }.str("round") == null })
        val moved = Hotcrp.reviews(pid).single { it.str("reviewer_email") == member }
        assertEquals("draft", moved.str("status"))
        assertEquals("Synthetic second opinion.", moved.str("ComPC")?.trim())
        assertTrue(ScreenRound.secondOpinionDrafts(store).none { it is ReviewMoveArtifact && it.moves.any { m -> m.pid == pid } }, "nothing left to move")
    }

    @Test
    @Order(6)
    @Covers("prop:H1", "prop:H2", "conv:6")
    fun `users - PC membership and a tier tag are handed to a chair, and the sync sees them`() {
        val email = "new-pc-writeback@example.org"
        val a = UserArtifact(listOf(UserChange(email, name = "Wanda Writeback", roles = "pc", tags = listOf("tier-writeback"))))
        val id = wb.draft(a)
        val dr = wb.dryRun(id)
        assertFalse(dr.supported, "HotCRP has no dry run for users")
        assertTrue(dr.valid && dr.lines.single().contains(email))
        assertFalse(Hotcrp.pcEmails().contains(email))
        wb.confirm(id)
        val r = wb.apply(id)
        assertEquals(WritebackStatus.HANDED_OFF, r.status)
        assertFalse(Hotcrp.pcEmails().contains(email), "PC Supervisor itself can't write users: the chair runs the command")
        // the chair runs what PC Supervisor printed, on the HotCRP server (the harness's container)
        wb.handOffCommands(id).forEach { cmd ->
            assertTrue(cmd.startsWith("php batch/saveusers.php -e '"))
            Hotcrp.php("batch/saveusers.php", "-e", cmd.removePrefix("php batch/saveusers.php -e '").removeSuffix("'"))
        }
        sync()
        assertEquals(WritebackStatus.OBSERVED, status(id), wb.get(id).mismatch)
        assertEquals(1, store.conn.query("SELECT count(*) FROM person WHERE email = '$email' AND gone_at IS NULL") { it.getInt(1) }.single())
    }

    @Test
    @Order(7)
    @Covers("prop:H2", "prop:M2")
    fun `an applied artifact whose effect is later reverted in HotCRP is flagged with the mismatch`() {
        val pid = 8L
        val id = lifecycle(TagArtifact(listOf(TagChange(pid, add = listOf("pcs-warned")))), { Hotcrp.tags(pid).any { it.startsWith("pcs-warned") } })
        assertTrue(Ledger.mismatches(store).none { it.id == id })
        // someone removes the tag in HotCRP
        assertTrue(Hotcrp.ok(Hotcrp.assign("""{"pid":$pid,"action":"cleartag","tag":"pcs-warned"}""")))
        sync()
        val bad = Ledger.mismatches(store).single { it.id == id }
        assertEquals(WritebackStatus.MISMATCH, status(id))
        assertTrue(bad.problems.contains("pcs-warned") && bad.problems.contains("$pid"), bad.problems)
        // and a revert that is put back clears the flag
        assertTrue(Hotcrp.ok(Hotcrp.assign("""{"pid":$pid,"action":"tag","tag":"pcs-warned"}""")))
        sync()
        assertEquals(WritebackStatus.OBSERVED, status(id))
        // an effect that never shows is flagged on the very next sync: apply, then undo behind its back before syncing
        val pid2 = 7L
        val a = TagArtifact(listOf(TagChange(pid2, add = listOf("pcs-lost"))))
        val id2 = wb.draft(a)
        wb.dryRun(id2)
        wb.confirm(id2)
        wb.apply(id2)
        assertTrue(Hotcrp.ok(Hotcrp.assign("""{"pid":$pid2,"action":"cleartag","tag":"pcs-lost"}""")))
        sync()
        assertEquals(WritebackStatus.MISMATCH, status(id2))
        assertTrue(wb.get(id2).mismatch!!.contains("pcs-lost"))
    }

    @Test
    @Order(8)
    @Covers("prop:H1")
    fun `a dry run that HotCRP no longer agrees with is not applied`() {
        val pid = 12L
        val id = wb.draft(TagArtifact(listOf(TagChange(pid, add = listOf("pcs-stale")))))
        wb.dryRun(id)
        wb.confirm(id)
        // the chair confirmed one diff; HotCRP now answers another (the tag is already there)
        assertTrue(Hotcrp.ok(Hotcrp.assign("""{"pid":$pid,"action":"tag","tag":"pcs-stale"}""")))
        val e = assertThrows(WritebackException::class.java) { wb.apply(id) }
        assertTrue(e.message!!.contains("changed"), e.message)
        assertEquals(WritebackStatus.DRY_RUN, status(id), "back to needing a confirmation")
        // revising a draft voids its dry run
        wb.revise(id, TagArtifact(listOf(TagChange(pid, add = listOf("pcs-stale2")))))
        assertEquals(WritebackStatus.DRAFTED, status(id))
        assertThrows(WritebackException::class.java) { wb.confirm(id) }
        // a draft HotCRP refuses has no valid dry run and can't be confirmed
        val bad = wb.draft(AssignmentArtifact(listOf(mapOf("pid" to "$pid", "action" to "pcreview", "user" to "nobody@example.org"))))
        assertFalse(wb.dryRun(bad).valid)
        assertThrows(WritebackException::class.java) { wb.confirm(bad) }
    }

    @Test
    @Order(9)
    @Covers("prop:H1")
    fun `the apply-without-dry-run fault is the only way past the gate`() {
        val pid = 4L
        val a = TagArtifact(listOf(TagChange(pid, add = listOf("pcs-fault-probe"))))
        val id = wb.draft(a)
        assertThrows(WritebackException::class.java) { wb.apply(id) }
        assertFalse(Hotcrp.tags(pid).any { it.startsWith("pcs-fault-probe") })
        val faulty = Writeback(store, clock, Harness.url, token, Faults(applyWithoutDryRun = true))
        faulty.apply(id)
        assertTrue(Hotcrp.tags(pid).any { it.startsWith("pcs-fault-probe") }, "the mutant skips the dry run; the end-to-end suite above would catch it")
    }

    @Test
    @Order(10)
    @Covers("prop:H1")
    fun `only a chair may confirm`() {
        val pc = Hotcrp.pcEmails().first { it.startsWith("r1@") }
        val acToken = Hotcrp.php("batch/apitoken.php", "create", "-e", "1d", "--note", "pcs-test-nonchair", pc).trim().lines().last()
        val nonChair = Writeback(store, clock, Harness.url, acToken)
        val id = nonChair.draft(TagArtifact(listOf(TagChange(3, add = listOf("pcs-nochair")))))
        nonChair.dryRun(id).let { assertTrue(!it.valid || it.lines.isNotEmpty()) }
        val e = assertThrows(WritebackException::class.java) { nonChair.confirm(id) }
        assertTrue(e.message!!.contains("chair") || e.message!!.contains("dry run"), e.message)
        assertFalse(Hotcrp.tags(3).any { it.startsWith("pcs-nochair") })
    }

    @Test
    @Order(11)
    @Covers("prop:H1")
    fun `first actions - a copyable search, a nudge comment, and the chair-attention tag`() {
        val pids = listOf(3L, 5L, 9L)
        val q = FirstActions.searchQuery(pids)
        val ids =
            Hotcrp.api("GET", "search", mapOf("q" to q, "t" to "all"))["ids"]!!.let {
                (it as kotlinx.serialization.json.JsonArray).map { x ->
                    x.jsonPrimitive.content.toLong()
                }
            }
        assertEquals(pids, ids.sorted(), "HotCRP's search for the query is exactly the filtered set")
        assertEquals("${Harness.url}/search?q=3%205%209", FirstActions.searchLink(HotcrpLinks(Harness.url), pids))
        val tag = "chair-attention"
        lifecycle(FirstActions.chairAttention(listOf(3L, 9L), tag), { Hotcrp.tags(3).any { it.startsWith("$tag") } })
        assertTrue(Hotcrp.tags(9).any { it.startsWith(tag) })
        val nudge = FirstActions.nudge(3, listOf("B", "A"))
        assertTrue(nudge.text.contains("review A, review B") && !nudge.text.lowercase().contains("disengaged"))
        val before = Hotcrp.comments(3).size
        lifecycle(nudge, { Hotcrp.comments(3).size > before })
    }

    @Test
    @Order(12)
    @Covers("conv:3")
    fun `the screen round is excluded from load`() {
        val pid = 3L
        val member = Hotcrp.outsider(pid)
        sync()
        val before = Load.byPerson(store)[member.lowercase()] ?: 0
        val rowsBefore = store.conn.query("SELECT count(*) FROM review WHERE lower(email) = lower('$member') AND gone_at IS NULL") { it.getInt(1) }.single()
        assertTrue(Hotcrp.ok(Hotcrp.assign("""{"pid":$pid,"action":"pcreview","user":"$member","round":"screen"}""")))
        sync()
        val rowsAfter = store.conn.query("SELECT count(*) FROM review WHERE lower(email) = lower('$member') AND gone_at IS NULL") { it.getInt(1) }.single()
        assertEquals(rowsBefore + 1, rowsAfter, "the second opinion is a review in the mirror")
        assertEquals("screen", store.conn.query("SELECT round FROM review WHERE pid = $pid AND lower(email) = lower('$member')") { it.getString(1) }.single())
        assertEquals(before, Load.byPerson(store)[member.lowercase()] ?: 0, "and it is not load")
        // the same member in the normal round does count
        assertTrue(Hotcrp.ok(Hotcrp.assign("""{"pid":$pid,"action":"pcreview","user":"$member","round":"unnamed"}""")))
        sync()
        assertEquals(before + 1, Load.byPerson(store)[member.lowercase()] ?: 0)
    }
}

private fun <T> java.sql.Connection.query(sql: String, f: (java.sql.ResultSet) -> T): List<T> =
    createStatement().use { st -> st.executeQuery(sql).use { rs -> buildList { while (rs.next()) add(f(rs)) } } }
