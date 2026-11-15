package net.jonbell.pcs.core

import net.jonbell.pcs.core.accountability.AccConfig
import net.jonbell.pcs.core.accountability.AccDrafts
import net.jonbell.pcs.core.accountability.AccInput
import net.jonbell.pcs.core.accountability.AccLoader
import net.jonbell.pcs.core.accountability.AccLocal
import net.jonbell.pcs.core.accountability.AccountabilityPlan
import net.jonbell.pcs.core.accountability.AccountabilityReport
import net.jonbell.pcs.core.accountability.CaseStatus
import net.jonbell.pcs.core.accountability.Criterion
import net.jonbell.pcs.core.accountability.PersonTier
import net.jonbell.pcs.core.accountability.ReqStatus
import net.jonbell.pcs.core.accountability.SignalConfig
import net.jonbell.pcs.core.accountability.SuggestionStatus
import net.jonbell.pcs.core.accountability.Tiers
import net.jonbell.pcs.core.accountability.Viewer
import net.jonbell.pcs.core.nominations.Obligation
import net.jonbell.pcs.core.nominations.Resolved
import net.jonbell.pcs.core.readings.QId
import net.jonbell.pcs.core.readings.Readings
import net.jonbell.pcs.core.rules.Faults
import net.jonbell.pcs.core.rules.ReqDisposition
import net.jonbell.pcs.core.rules.Tier
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.testing.AccFixture
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.time.Duration
import java.time.Instant

/** Progress, the coaching queue, suggestions, requests, the engagement record and cases over a hand-built mirror (PLAN M16). */
@Family("T2")
class AccountabilityPlanTest {
    private val due = Instant.parse("2030-03-01T00:00:00Z")
    private val criteria =
        listOf(
            Criterion(1, "backs each weakness with evidence", setOf("negative-no-weakness", "thin")),
            Criterion(2, "tells the authors what would change the reviewer's mind", setOf("thin", "rated")),
            Criterion(3, "on time", setOf("late")),
        )
    private val cfg = AccConfig(criteria, dueH = 48, signal = SignalConfig(minWords = 150, weaknessField = "Wea", reviewDue = due))
    private val tiers = Tiers(mapOf("jun@example.org" to PersonTier(Tier.JUNIOR, false), "nom@example.org" to PersonTier(Tier.JUNIOR, true)))

    private fun at(hoursAfterDue: Long) = due.plus(Duration.ofHours(hoursAfterDue))

    private fun store(build: AccFixture.() -> Unit): Store {
        val s = Store.open(Files.createTempFile("pcs-acc", ".db"), "test-only-key")
        AccFixture(s).build()
        return s
    }

    private fun report(
        s: Store,
        now: Instant,
        f: Faults = Faults.NONE,
        obligations: List<Obligation> = emptyList(),
        readings: Readings = Readings(),
        config: AccConfig = cfg,
    ): AccountabilityReport = AccountabilityPlan.compute(AccLoader.load(s, now, tiers, "OveMer"), config, readings, obligations, f)

    private val base: AccFixture.() -> Unit = {
        person("sen@example.org", "Sam Senior")
        person("jun@example.org", "Jo Junior")
        person("nom@example.org", "Nia Nominee")
        person("ac@example.org", "Alex AC")
        paper(1)
        paper(2)
        review(1, "ac@example.org", rtype = 5, ordinal = null)
        review(1, "sen@example.org", ordinal = "A", words = 400, texts = mapOf("Wea" to "synthetic"))
        review(1, "jun@example.org", ordinal = "B", words = 60, merit = 1, texts = mapOf("PapSum" to "short summary"))
        review(1, "nom@example.org", ordinal = "C", status = "draft", firstCompleteAt = null)
        review(2, "sen@example.org", ordinal = "A", words = 500, merit = 4)
        review(2, "jun@example.org", ordinal = "B", words = 200, ratings = listOf("short", "vague"))
        review(2, "nom@example.org", ordinal = "C", words = 90)
    }

    @Test
    fun `progress by tier, with the nominee view`() {
        val r = report(store(base), at(24))
        val by = r.progress.associateBy { it.group }
        assertEquals(listOf(2, 0, 2), listOf(by.getValue("senior").assigned, by.getValue("senior").outstanding, by.getValue("senior").submitted))
        assertEquals(listOf(2, 2, 0), listOf(by.getValue("junior").assigned, by.getValue("junior").submitted, by.getValue("junior").late))
        assertEquals(listOf(2, 1, 1), listOf(by.getValue("nominee").assigned, by.getValue("nominee").outstanding, by.getValue("nominee").late))
        // the AC's metareview is not a review a reviewer owes
        assertEquals(6, r.progress.sumOf { it.assigned })
        assertEquals(listOf("nom@example.org"), r.nomineeOutstanding.map { it.email })
        assertEquals(1L, r.nomineeOutstanding.single().lateDays)
        // before the deadline nothing is late
        assertEquals(0, report(store(base), at(-1)).progress.sumOf { it.late })
    }

    @Test
    @Covers("prop:AR3")
    fun `lateness is dated from HotCRP's timestamps, so a mirror that first syncs after the deadline does not make on-time reviews late`() {
        val firstSync = at(30).epochSecond
        val s =
            store {
                person("sen@example.org", "Sam Senior")
                person("jun@example.org", "Jo Junior")
                person("nom@example.org", "Nia Nominee")
                paper(1)
                // submitted a day before the deadline, never revised; the mirror saw it a day after
                review(
                    1,
                    "sen@example.org",
                    ordinal = "A",
                    words = 400,
                    firstCompleteAt = firstSync,
                    modifiedAt = at(-24).epochSecond,
                    versionSeenAt = listOf(firstSync),
                )
                // submitted on time, revised after the deadline; its history was read and says so
                review(
                    1,
                    "jun@example.org",
                    ordinal = "B",
                    words = 400,
                    firstCompleteAt = firstSync,
                    modifiedAt = at(26).epochSecond,
                    historyCompleteAt = at(-5).epochSecond,
                    versionSeenAt = listOf(at(-5).epochSecond),
                )
                // really late: the history says it was submitted two days after the deadline
                review(
                    1,
                    "nom@example.org",
                    ordinal = "C",
                    words = 400,
                    firstCompleteAt = firstSync,
                    modifiedAt = at(48).epochSecond,
                    historyCompleteAt = at(48).epochSecond,
                    versionSeenAt = listOf(at(48).epochSecond),
                )
            }
        val r = report(s, at(60))
        val late = r.suggestions.filter { sg -> sg.reasons.any { "after the deadline" in it } }
        assertEquals(listOf("C"), late.map { it.ordinal }, "only the review HotCRP says was submitted late")
        assertTrue(late.single().reasons.any { "2 day(s) after the deadline" in it }, late.single().reasons.toString())
        // the cross-check reports the reviews the mirror saw far from HotCRP's time, and what it used instead
        assertTrue(r.dating.any { "first seen complete more than 15 minutes from HotCRP" in it && "#1 A" in it && "#1 B" in it }, r.dating.toString())
        // a sync interval of four days makes the same gaps unremarkable
        val loose = report(s, at(60), config = cfg.copy(syncIntervalMin = 60 * 100))
        assertTrue(loose.dating.none { "first seen" in it }, loose.dating.toString())
    }

    @Test
    @Covers("prop:AR3")
    fun `a review revised after the deadline with no history read is not called late, and the report asks for the history`() {
        val s =
            store {
                person("sen@example.org", "Sam Senior")
                paper(1)
                review(1, "sen@example.org", ordinal = "A", words = 400, firstCompleteAt = at(3).epochSecond, modifiedAt = at(2).epochSecond)
            }
        val r = report(s, at(10))
        assertTrue(r.suggestions.none { sg -> sg.reasons.any { "after the deadline" in it } })
        assertTrue(r.dating.single().contains("not flagged late") && r.dating.single().contains("#1 A"), r.dating.toString())
        // once its history is read the same review is dated, and late
        val read =
            store {
                person("sen@example.org", "Sam Senior")
                paper(1)
                review(
                    1,
                    "sen@example.org",
                    ordinal = "A",
                    words = 400,
                    firstCompleteAt = at(3).epochSecond,
                    modifiedAt = at(2).epochSecond,
                    historyCompleteAt = at(1).epochSecond,
                    versionSeenAt = listOf(at(1).epochSecond),
                )
            }
        val after = report(read, at(10))
        assertEquals(listOf("A"), after.suggestions.filter { sg -> sg.reasons.any { "after the deadline" in it } }.map { it.ordinal })
        assertTrue(after.dating.none { "not flagged late" in it }, "no longer undetermined: ${after.dating}")
    }

    @Test
    fun `the coaching queue holds junior and nominee reviews below the floor or rated short and vague`() {
        val q = report(store(base), at(24)).coaching
        assertEquals(listOf(1L to "B", 2L to "B", 2L to "C"), q.map { it.pid to it.ordinal })
        assertTrue(q.none { it.group == "senior" })
        assertTrue(q.first { it.pid == 2L && it.ordinal == "B" }.reasons.single().contains("short or vague"))
        assertTrue(q.first { it.pid == 1L }.reasons.single().contains("60 words, below the depth floor of 150"))
    }

    @Test
    @Covers("card:C1", "prop:AR1")
    fun `a weak reject with no weakness suggests the criteria that answer it, from the list only`() {
        val r = report(store(base), at(24))
        val s = r.suggestions.first { it.pid == 1L && it.ordinal == "B" }
        assertEquals(listOf(1, 2), s.criteria) // thin and negative-no-weakness both point at 1; thin and rated at 2
        assertTrue(s.reasons.any { it.contains("merit 1") && it.contains("Wea field is empty") })
        assertEquals(SuggestionStatus.OPEN, s.status)
        // with no criteria list the suggestion cites nothing, and the report says why
        val none = report(store(base), at(24), config = cfg.copy(criteria = emptyList()))
        assertTrue(none.suggestions.all { it.criteria.isEmpty() })
        assertTrue(none.notes.single().contains("criteria list"))
        // a draft cites only criteria on the list
        assertTrue(runCatching { AccDrafts.draft(s, listOf(9), criteria, "", 48, null) }.isFailure)
        val d = AccDrafts.draft(s, listOf(1, 2), criteria, "I would value a second look.", 48, null)
        assertTrue(d.body.contains("1. backs each weakness") && d.body.contains("I would value a second look.") && d.body.contains("%NUMBER%"))
    }

    private fun withRequest(disp: String, seenAt: Long, extra: AccFixture.() -> Unit = {}): Store =
        store {
            base()
            tagSeen(1, "pcs-req-B1", disp, seenAt)
            setTags(1, listOf("pcs-req-B1#$disp"))
            extra()
        }

    @Test
    fun `a request is sent, then reminded after its due date, and replies are seen from the revision`() {
        val sent = due.plusSeconds(3600).epochSecond
        val s = withRequest("0", sent)
        val r1 = report(s, due.plusSeconds(3600 * 10)).requests.single()
        assertEquals(ReqStatus.SENT, r1.status)
        assertFalse(r1.mayRemind)
        assertEquals(sent + 48 * 3600, r1.due.epochSecond)
        val r2 = report(s, due.plusSeconds(3600 * 60)).requests.single()
        assertTrue(r2.mayRemind && !r2.mayNoReply)
        // the reviewer revises the review after the request: a version first seen later
        val revised =
            withRequest("0", sent) {
                store.conn.createStatement().use {
                    it.executeUpdate(
                        "INSERT INTO review_version(rid,vtag,seen_at,source,scores,status) VALUES(3,'v1',${sent + 100},'snapshot','{}','complete')",
                    )
                }
            }
        val r3 = report(revised, due.plusSeconds(3600 * 10)).requests.single()
        assertTrue(r3.revised)
        assertEquals(ReqStatus.REPLIED, r3.status)
        assertFalse(report(revised, due.plusSeconds(3600 * 60)).requests.single().mayRemind)
    }

    @Test
    @Covers("card:C3", "prop:AR5")
    fun `no reply only after the due date, the reminder, and the grace period`() {
        val sent = due.epochSecond
        val reminded = due.plus(Duration.ofHours(50)).epochSecond
        val s =
            store {
                base()
                tagSeen(1, "pcs-req-B1", "0", sent)
                tagSeen(1, "pcs-remind-B1", "0", reminded)
                setTags(1, listOf("pcs-req-B1#0", "pcs-remind-B1"))
            }

        fun req(h: Long) = report(s, at(h)).requests.single()
        // due at +48; reminder at +50; grace ends at +96 (card C3: hour 90 no, hour 97 yes, measured from the due date and reminder)
        assertFalse(req(48).mayNoReply)
        assertFalse(req(90).mayNoReply)
        assertFalse(req(96).mayNoReply, "the instant the grace period ends is still inside it")
        assertTrue(req(97).mayNoReply)
        assertEquals(ReqStatus.REMINDED, req(60).status)
        // without a reminder, no waiting is enough
        val unreminded = withRequest("0", sent)
        assertFalse(report(unreminded, at(500)).requests.single().mayNoReply)
    }

    @Test
    @Covers("card:C3", "prop:AR5")
    fun `the grace period is the venue's`() {
        val sent = due.epochSecond
        val reminded = due.plus(Duration.ofHours(50)).epochSecond
        val s =
            store {
                base()
                tagSeen(1, "pcs-req-B1", "0", sent)
                tagSeen(1, "pcs-remind-B1", "0", reminded)
                setTags(1, listOf("pcs-req-B1#0", "pcs-remind-B1"))
            }
        for (grace in listOf(24L, 48L, 72L, 100L)) {
            val c = cfg.copy(graceH = grace)

            fun req(h: Long) = report(s, at(h), config = c).requests.single()
            // due at +48, reminded at +50: "no reply" from the end of the grace period, +48 + grace
            assertFalse(req(48 + grace).mayNoReply, "the instant a $grace h grace period ends is still inside it")
            assertTrue(req(48 + grace + 1).mayNoReply, "just past a $grace h grace period")
        }
    }

    @Test
    @Covers("card:C4", "prop:AR4")
    fun `a dismissed suggestion leaves no trace on the engagement record`() {
        val s = store(base)
        val before = report(s, at(24))
        AccLocal.dismiss(s, 1, "B", "chair", at(24))
        val after = report(s, at(25))
        assertEquals(SuggestionStatus.DISMISSED, after.suggestions.first { it.pid == 1L && it.ordinal == "B" }.status)
        assertEquals(before.engagement, after.engagement)
        assertEquals(emptyList<Any>(), after.engagement)
        assertEquals(before.requests, after.requests)
        // the mutant counts it, and is caught
        val mutant = report(s, at(25), f = Faults(dismissedSuggestionCounts = true))
        assertEquals(1, mutant.engagement.single { it.reviewer == "jun@example.org" }.notEngaged)
    }

    @Test
    @Covers("prop:AR2")
    fun `a heuristic suggestion is never a request a reviewer received`() {
        val s = store(base)
        assertEquals(emptyList<Any>(), report(s, at(24)).engagement)
        val mutant = report(s, at(24), f = Faults(heuristicSendsItself = true))
        assertTrue(mutant.engagement.any { it.open > 0 }, "the mutant counts a suggestion as sent")
    }

    @Test
    @Covers("card:C1", "card:C2", "prop:AR4")
    fun `the engagement record is dispositions only`() {
        val s =
            store {
                base()
                tagSeen(1, "pcs-req-B1", "1", 10)
                tagSeen(2, "pcs-req-B1", "3", 10)
                tagSeen(2, "pcs-req-C1", "4", 10)
                tagSeen(2, "pcs-req-A1", "2", 10)
                setTags(1, listOf("pcs-req-B1#1"))
                setTags(2, listOf("pcs-req-B1#3", "pcs-req-C1#4", "pcs-req-A1#2"))
                review(2, "ac@example.org", rtype = 5, ordinal = null)
            }
        val e = report(s, at(500)).engagement.associateBy { it.reviewer }
        assertEquals(listOf(1, 1), e.getValue("jun@example.org").let { listOf(it.engaged, it.notEngaged) })
        assertEquals(listOf(0, 1), e.getValue("nom@example.org").let { listOf(it.engaged, it.notEngaged) })
        assertEquals(listOf(1, 0), e.getValue("sen@example.org").let { listOf(it.engaged, it.notEngaged) })
        // who sees it (Q21): the PC chairs everything, the junior PC chair junior reviewers and nominees, an AC their own papers
        val r = report(s, at(500))
        assertEquals(3, r.engagementFor(Viewer.PcChair).size)
        assertEquals(setOf("jun@example.org", "nom@example.org"), r.engagementFor(Viewer.JuniorPcChair).map { it.reviewer }.toSet())
        assertEquals(3, r.engagementFor(Viewer.Ac("ac@example.org")).size)
        assertEquals(0, r.engagementFor(Viewer.Ac("other@example.org")).size)
    }

    private fun nominee(vararg papers: Long) = Obligation("nom@example.org", Tier.JUNIOR, papers.toList(), true, Resolved.Decided(18), false)

    @Test
    @Covers("card:X10", "card:X6", "prop:V4")
    fun `one case lists every nominating paper whose share went unmet`() {
        val s =
            store {
                person("nom@example.org", "Nia Nominee")
                for (p in 10L..13L) {
                    paper(p)
                    review(p, "nom@example.org", ordinal = "A", status = "draft", firstCompleteAt = null)
                }
            }
        val r = report(s, at(24), obligations = listOf(nominee(10, 11, 12, 13)))
        val c = r.cases.single()
        assertEquals(listOf(10L, 11L, 12L, 13L), c.papers)
        assertTrue(c.missingReview)
        assertEquals(Resolved.Decided(true), c.mayOpen)
        assertEquals(CaseStatus.CANDIDATE, c.status)
        // under Q11 = reject own papers the consequence names the two-person path; unresolved, every reading is listed
        val open = c.consequence as Resolved.Open
        assertEquals(setOf(QId.Q11), open.by.toSet())
        assertTrue(open.cases.any { it.second.contains("two-person path") })
        assertEquals(3, open.cases.size)
        // before the review deadline there is nothing to open
        assertTrue(report(s, at(-24), obligations = listOf(nominee(10, 11, 12, 13))).cases.isEmpty())
    }

    @Test
    @Covers("card:C6", "card:C8", "prop:AR6")
    fun `a quality case needs an earlier request disposed declined or no reply, when Q20 says so`() {
        val ob = listOf(nominee(2))
        val quality: AccFixture.() -> Unit = {
            person("nom@example.org", "Nia Nominee")
            paper(2)
            review(2, "nom@example.org", ordinal = "C", words = 90)
        }
        val noRequest = store(quality)

        fun c(s: Store, q20: String?, f: Faults = Faults.NONE): Resolved<Boolean> {
            val r = if (q20 == null) Readings() else Readings().with(QId.Q20, q20)!!
            return report(s, at(24), f = f, obligations = ob, readings = r).cases.single { it.nominee == "nom@example.org" }.mayOpen
        }
        // two thin reviews and no request: under Q20 = yes there is no case to open (C6)
        assertEquals(Resolved.Decided(false), c(noRequest, "yes"))
        assertEquals(Resolved.Decided(true), c(noRequest, "no"))
        // unresolved: both readings are shown, not a default
        assertTrue(c(noRequest, null) is Resolved.Open)
        // a no-reply disposition on a request about their review opens the way
        val asked =
            store {
                quality()
                tagSeen(2, "pcs-req-C1", "4", 10)
                setTags(2, listOf("pcs-req-C1#4"))
            }
        assertEquals(Resolved.Decided(true), c(asked, "yes"))
        // an unsent suggestion is no request (C8); a request that never reached them is not one either
        assertEquals(Resolved.Decided(false), c(noRequest, "yes"))
        assertEquals(Resolved.Decided(false), c(noRequest, "yes", Faults(heuristicSendsItself = true)))
    }

    @Test
    fun `a case's status comes from the local record and the chair-only tag`() {
        val s =
            store {
                person("nom@example.org", "Nia Nominee")
                paper(10)
                review(10, "nom@example.org", ordinal = "A", status = "draft", firstCompleteAt = null)
            }
        val ob = listOf(nominee(10))
        assertEquals(CaseStatus.CANDIDATE, report(s, at(24), obligations = ob).cases.single().status)
        AccLocal.setCase(s, "nom@example.org", "open", at(24))
        assertEquals(CaseStatus.OPEN, report(s, at(24), obligations = ob).cases.single().status)
        AccFixture(s).setTags(10, listOf("~~pcs-case-1#1"))
        assertEquals(CaseStatus.UPHELD, report(s, at(24), obligations = ob).cases.single().status)
        assertEquals("~~pcs-case-1#1", AccDrafts.recordCase(listOf(10), 1, upheld = true).changes.single().add.single())
    }

    @Test
    @Covers("card:C7")
    fun `the engagement record's life depends on Q21`() {
        val open = AccountabilityPlan.q21Outcome(Readings())
        assertTrue(open is Resolved.Open)
        assertEquals(
            Resolved.Decided("engagement records deleted"),
            AccountabilityPlan.q21Outcome(Readings().with(QId.Q21, "this-conference")!!),
        )
        assertNotNull(AccountabilityPlan.q21Outcome(Readings().with(QId.Q21, "handed-on")!!).decided)
        assertNull(open.decided)
    }

    @Test
    fun `drafts and records use the conventions`() {
        assertEquals("pcs-req-B1#0", AccDrafts.recordSent(1, "B").changes.single().add.single())
        assertEquals("pcs-remind-B1", AccDrafts.recordReminder(1, "B").changes.single().add.single())
        assertEquals("pcs-req-B1#3", AccDrafts.recordDisposition(1, "B", 1, ReqDisposition.DECLINED).changes.single().add.single())
        val inp: AccInput = AccLoader.load(store(base), at(0), tiers, "OveMer")
        assertEquals(setOf(1L, 2L), inp.reviews.map { it.pid }.toSet())
    }
}
