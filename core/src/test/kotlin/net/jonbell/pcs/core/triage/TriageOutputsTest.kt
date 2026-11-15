package net.jonbell.pcs.core.triage

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.core.Repo
import net.jonbell.pcs.core.readings.Q1
import net.jonbell.pcs.core.readings.Q4
import net.jonbell.pcs.core.rules.Conventions
import net.jonbell.pcs.core.rules.Ground
import net.jonbell.pcs.core.rules.Stage
import net.jonbell.pcs.core.rules.Trace
import net.jonbell.pcs.core.time.Clock
import net.jonbell.pcs.core.triage.TriageFixture.Companion.bundle
import net.jonbell.pcs.core.triage.TriageFixture.Companion.finding
import net.jonbell.pcs.core.triage.TriageFixture.Companion.readings
import net.jonbell.pcs.core.writeback.AssignmentArtifact
import net.jonbell.pcs.core.writeback.CommentArtifact
import net.jonbell.pcs.core.writeback.DecisionArtifact
import net.jonbell.pcs.core.writeback.TagArtifact
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.time.Instant
import java.time.ZoneId

/** What the module drafts and what it measures: notices rendered from grounds, the findings comment, TriageFeedback, and the consistency view. */
@Family("T1")
class TriageOutputsTest {
    private val ac = "ac@example.org"
    private val now = Instant.ofEpochSecond(1_900_000_000L)
    private val nowH = now.epochSecond / 3600
    private val clock = Clock { now }

    @Test
    @Covers("prop:C2")
    fun `a notice is rendered from its ground and names no person, no engine and no way the ground was found`() {
        for (g in Ground.entries) {
            val texts = listOf(Notices.removal(g), Notices.remedyOffer(g, "2030-01-01 12:00 EST"), Notices.warning())
            texts.forEach { assertEquals(emptyList<String>(), Notices.lint(it), "ground ${g.key}: $it") }
            assertTrue(Notices.removal(g).contains(Notices.groundText(g)), "the notice states the ground: ${g.key}")
        }
        assertTrue(Notices.removal(Ground.PROMPT_INJECTION).contains("hidden text addressed to an automated reader"))
        assertEquals(8, Ground.entries.map { Notices.groundText(it) }.distinct().size, "every ground has its own words")
        // the lint itself: it finds each kind of leak
        assertTrue(Notices.lint("write to bob@example.org").isNotEmpty())
        assertTrue(Notices.lint("a second opinion agreed").isNotEmpty())
        assertTrue(Notices.lint("the engine flagged it").isNotEmpty())
        assertTrue(Notices.lint("Dear Ada Lovelace", listOf("Ada Lovelace")).isNotEmpty())
    }

    @Test
    @Covers("prop:S2", "card:E9")
    fun `the findings comment is the record a sync parses, lists verified findings only, and names no engine`() {
        val (store, rep) = triageWorld(5L to "prompt-injection")
        val unverified = finding(5, "format", quote = "UNVERIFIED-QUOTE", verified = false)
        val b = bundle(listOf(finding(5, "prompt-injection", engine = "ENGINE-X", quote = "ignore previous instructions"), unverified))
        val rows = rep.rows.map { it.copy(findings = b.visible) }
        val a = TriageDrafts.postFindings(store, rows).single() as CommentArtifact
        assertEquals("rev", a.visibility)
        assertEquals(Conventions.FINDINGS_MARKER, a.text.lineSequence().first())
        assertTrue("ignore previous instructions" in a.text && "UNVERIFIED-QUOTE" !in a.text && "ENGINE-X" !in a.text)
        assertTrue(Conventions.decodeComment(5, 1, "admin@example.org", a.text) is Trace.Findings)
        // once a chair's comment with the marker exists, none is drafted again; after triage it is withdrawn by editing its visibility
        store.conn.createStatement().use {
            it.executeUpdate("INSERT INTO person(email,name,roles,tags,first_seen_at,last_seen_at) VALUES('admin@example.org','a','[\"chair\"]','[]',0,0)")
            it.executeUpdate(
                "INSERT INTO comment(cid,pid,email,visibility,draft,word_count,mentions,tags,modified_at,first_seen_at,last_seen_at) VALUES(90,5,'admin@example.org','rev',0,5,'[]','[]',1,0,0)",
            )
            it.executeUpdate("INSERT INTO comment_text(cid,modified_at,text) VALUES(90,1,'${a.text.replace("'", "''")}')")
        }
        assertEquals(emptyList<Any>(), TriageDrafts.postFindings(store, rows))
        val kept = rows.map { it.copy(status = TriageStatus.KEPT) }
        val w = TriageDrafts.withdrawFindings(store, kept).single() as CommentArtifact
        assertEquals("admin" to 90L, w.visibility to w.cid)
        store.close()
    }

    @Test
    @Covers("prop:S2", "prop:S1")
    fun `the drafts are exactly the model's steps, and a removal can only be drafted for a paper that is ready`() {
        val (store, rep) = triageWorld(5L to "anonymity", 6L to "format")
        val row = rep.rows.single { it.pid == 5L }
        assertEquals(TriageStatus.READY, row.status)
        val (decision, mails) = TriageDrafts.remove(rep.rows)
        assertEquals(mapOf(5L to "Reject", 6L to "Reject"), (decision as DecisionArtifact).decisions)
        assertEquals(setOf("5", "6"), mails.map { it.search }.toSet())
        assertThrows(IllegalArgumentException::class.java) { TriageDrafts.remove(rep.rows.map { it.copy(status = TriageStatus.NEEDS_SECOND_OPINION) }) }
        // a second opinion request is a screen-round assignment; the fix window and the warning are the hidden tags of spec §11
        val (asg, mail) = TriageDrafts.requestSecondOpinion(row, "senior2@example.org")
        assertEquals(
            mapOf("pid" to "5", "action" to "pcreview", "user" to "senior2@example.org", "round" to "screen"),
            (asg as AssignmentArtifact).rows.single(),
        )
        assertTrue("anonymity" !in mail.body.lowercase() || "double-anonymous" in mail.body)
        val (tag, offer) = TriageDrafts.offerRemedy(row, Q1.FIX_WINDOW, now, ZoneId.of("America/New_York"))
        val due = now.epochSecond + 72 * 3600
        assertEquals(listOf(Conventions.encode(Trace.RemedyDue(5, due))), (tag as TagArtifact).changes.single().add)
        assertTrue(Notices.lint(offer.body).isEmpty() && "You may upload a corrected version until" in offer.body)
        for (w in listOf(24L, 120L)) { // the venue's window (PCS_REMEDY_WINDOW_H), not a constant
            val (t, _) = TriageDrafts.offerRemedy(row, Q1.FIX_WINDOW, now, ZoneId.of("UTC"), w)
            assertEquals(listOf(Conventions.encode(Trace.RemedyDue(5, now.epochSecond + w * 3600))), (t as TagArtifact).changes.single().add)
        }
        assertThrows(IllegalArgumentException::class.java) { TriageDrafts.offerRemedy(row, Q1.REJECT_AT_ONCE, now, ZoneId.of("UTC")) }
        assertThrows(IllegalArgumentException::class.java) { TriageDrafts.warn(row) }
        store.close()
        val (store2, rep2) = triageWorld(9L to "nomination-noncompliance")
        val warn = TriageDrafts.warn(rep2.rows.single()).first as TagArtifact
        assertEquals(listOf("pcs-warned"), warn.changes.single().add)
        assertThrows(IllegalArgumentException::class.java) { TriageDrafts.offerRemedy(rep2.rows.single(), Q1.FIX_WINDOW, now, ZoneId.of("UTC")) }
        store2.close()
    }

    @Test
    @Covers("prop:S12")
    fun `S12 - the reveal rule per Q4 and the policy's cells agree, and the form is owed only after the reviewer's own review`() {
        assertEquals(listOf(false, false), listOf(false, true).map { TriageFeedback.mayReveal(Q4.NEVER, it) })
        assertEquals(listOf(false, true), listOf(false, true).map { TriageFeedback.mayReveal(Q4.AFTER_OWN_REVIEW, it) })
        assertEquals(listOf(true, true), listOf(false, true).map { TriageFeedback.mayReveal(Q4.ALWAYS, it) })
        val policy = Json.parseToJsonElement(Files.readString(Repo.path("model/export/policy.json"))).jsonObject["byQ4"]!!.jsonArray
        for (q in policy) {
            val q4 = Q4.ofKey(q.jsonObject["q4"]!!.jsonPrimitive.content)!!
            val cells = q.jsonObject["cells"]!!.jsonArray.map { it.jsonObject }.filter { it["perm"]!!.jsonPrimitive.content == "see-findings" }
            for (role in listOf("pc-member", "nominee")) {
                val cell = cells.single { it["role"]!!.jsonPrimitive.content == role }["cell"]!!.jsonObject
                val granted = cell["granted"]!!.jsonPrimitive.content.toBoolean()
                val afterOwn = cell["scope"]!!.jsonPrimitive.content == "after own review"
                assertEquals(granted && !afterOwn, TriageFeedback.mayReveal(q4, ownReviewSubmitted = false), "$q4 $role before their review")
                assertEquals(granted, TriageFeedback.mayReveal(q4, ownReviewSubmitted = true), "$q4 $role after their review")
            }
            assertEquals("denied", cells.single { it["role"]!!.jsonPrimitive.content == "author" }["cell"]!!.jsonObject["kind"]!!.jsonPrimitive.content)
        }

        val (store, rep) =
            triageWorld(5L to "format") {
                paper(8)
                review(5, "r1@example.org")
                review(5, "r2@example.org", status = "draft")
                review(8, "r1@example.org")
            }
        assertEquals(emptyList<FeedbackOwed>(), TriageFeedback.owed(store, Q4.NEVER, rep.rows))
        assertEquals(emptyList<FeedbackOwed>(), TriageFeedback.owed(store, Q4.ALWAYS, rep.rows), "no form when the record was always shown")
        assertEquals(
            listOf(FeedbackOwed(5, "r1@example.org", false)),
            TriageFeedback.owed(store, Q4.AFTER_OWN_REVIEW, rep.rows),
            "only the complete review on a paper with a record: not the draft, not paper 8",
        )
        store.close()
    }

    @Test
    @Covers("prop:S12", "prop:S2")
    fun `TriageFeedback answers are kept, summarized, and never change what the plan says about the paper`() {
        val (store, rep) = triageWorld(5L to "format") { review(5, "r1@example.org") }
        val before = TriagePlan.compute(store, bundle(listOf(finding(5, "format"))), emptyList(), readings(), Stage.SCREENING, nowH, TriageFixture.tiers)
        TriageFeedback.record(store, clock, FeedbackAnswer(5, "r1@example.org", YesNo.NO, YesNo.YES, YesNo.NO, "it is fine"))
        val after = TriagePlan.compute(store, bundle(listOf(finding(5, "format"))), emptyList(), readings(), Stage.SCREENING, nowH, TriageFixture.tiers)
        assertEquals(before, after)
        assertEquals(TriageStatus.READY, rep.status(5), "an answer that says the flag was wrong does not unflag the paper")
        val s = TriageFeedback.summary(store, Q4.AFTER_OWN_REVIEW, rep.rows)
        assertEquals(TriageFeedback.Summary(owed = 1, answered = 1, flagRight = 0, flagWrong = 1, missed = 1), s)
        assertEquals(1.0, s.rate)
        // answering again replaces, it does not add
        TriageFeedback.record(store, clock, FeedbackAnswer(5, "R1@example.org", YesNo.YES, YesNo.NO, YesNo.YES))
        assertEquals(listOf(YesNo.YES), TriageFeedback.answers(store).map { it.flagRight })
        store.close()
    }
}
