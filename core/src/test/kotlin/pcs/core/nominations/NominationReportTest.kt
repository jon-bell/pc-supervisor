package pcs.core.nominations

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import pcs.core.readings.Answers
import pcs.core.readings.QId
import pcs.core.readings.Readings
import pcs.core.rules.Compliance
import pcs.core.rules.Tier
import pcs.testing.Covers
import pcs.testing.Family

/** Spec §10.4 A at report level: the rules are checked against the model elsewhere (cards, T2); this is what the report assembles from them. */
@Family("T10")
class NominationReportTest {
    private fun e(n: String) = "$n@example.org"

    private fun answers(vararg kv: String): Readings =
        Answers.parse(kv.joinToString("\n")).also {
            check(it.errors.isEmpty()) { it.errors.toString() }
        }.readings

    private val allAnswered =
        answers("Q8 = up-to-n", "Q10 = warn-then-reject", "Q17 = 9", "Q18 = once", "Q19 = equal", "Q19b = others-absorb")

    private fun cand(
        who: String,
        origin: String = "nominee",
        by: List<Long> = emptyList(),
        decision: Decision = Decision.ACCEPT,
        tier: Tier? = Tier.JUNIOR,
        consent: Boolean? = true,
        ac: String = "ac",
    ) = Candidate(e(who), origin, by, "area", e(ac), decision, tier, consent, "")

    private fun paper(pid: Long, vararg authors: String, tags: List<String> = emptyList()) = PaperInfo(pid, "Paper $pid", authors.map(::e), tags)

    /** ACs of papers 1..20: `ac`. */
    private val acs = (1L..20L).associateWith { setOf(e("ac")) }

    private fun input(papers: List<PaperInfo>, sheet: List<Candidate>, pc: Set<String> = emptySet(), registered: Set<String>? = null) =
        NominationInput(papers, sheet, pc, registered, acs)

    private fun report(i: NominationInput, r: Readings = allAnswered) = NominationRules.build(i, r)

    private fun PaperCheck.compliant() = compliance.decided

    @Test
    @Covers("card:X1", "q:Q8=one", "q:Q8=up-to-n", "q:Q8=at-least-one", "q:Q10=desk-reject", "q:Q10=warn-then-reject", "q:Q10=warn-only")
    fun `a paper naming no nominee is not compliant, and Q10 says what follows`() {
        val i = input(listOf(paper(1, "a", "b"), paper(2, "c", "d", tags = listOf("pcs-warned"))), emptyList())
        for ((q10, unwarned, warned) in listOf(Triple("desk-reject", true, true), Triple("warn-then-reject", false, true), Triple("warn-only", false, false))) {
            val r = report(i, answers("Q8 = one", "Q10 = $q10", "Q17 = none", "Q18 = once", "Q19 = equal", "Q19b = paper-short"))
            val (p1, p2) = r.papers
            assertEquals(Compliance.MISSING_NOMINEE, p1.compliant(), q10)
            assertEquals(Resolved.Decided(unwarned), p1.referable, "$q10, no warning")
            assertEquals(Resolved.Decided(warned), p2.referable, "$q10, after the warning tag")
            assertTrue(p2.warned)
        }
    }

    @Test
    @Covers("card:X8", "q:Q8=one", "q:Q8=up-to-n", "q:Q8=at-least-one")
    fun `Q8 decides how many nominees are too many`() {
        val sheet = listOf("x", "y", "z", "w").map { cand(it, by = listOf(1)) }
        val i = input(listOf(paper(1, "x", "y", "z", "w")), sheet)

        fun under(q8: String) =
            report(
                i,
                answers("Q8 = $q8", "Q10 = warn-only", "Q17 = none", "Q18 = once", "Q19 = equal", "Q19b = others-absorb"),
            ).papers.single().compliant()
        assertEquals(Compliance.TOO_MANY_NOMINEES, under("one"))
        assertEquals(Compliance.TOO_MANY_NOMINEES, under("up-to-n"))
        assertEquals(Compliance.OK, under("at-least-one"))
        val three = input(listOf(paper(1, "x", "y", "z")), sheet.take(3))
        assertEquals(
            Compliance.OK,
            report(
                three,
                answers("Q8 = up-to-n", "Q10 = warn-only", "Q17 = none", "Q18 = once", "Q19 = equal", "Q19b = others-absorb"),
            ).papers.single().compliant(),
        )
    }

    @Test
    @Covers("rule:compliance")
    fun `a nominee who never registered with the matching system makes the paper unregistered`() {
        val i = input(listOf(paper(1, "a", "b")), listOf(cand("b", by = listOf(1))))
        assertEquals(Compliance.UNREGISTERED, report(i.copy(registered = setOf(e("someone-else")))).papers.single().compliant())
        assertEquals(Compliance.OK, report(i.copy(registered = setOf(e("b")))).papers.single().compliant())
        val unknown = report(i).papers.single()
        assertEquals(Compliance.OK, unknown.compliant(), "no registrations import: unchecked, and the report says so")
        assertTrue(unknown.notes.any { "unchecked" in it })
    }

    @Test
    @Covers("card:X2", "rule:owes", "q:Q18=once", "q:Q18=per-paper", "q:Q18=share-weighted", "q:Q18=capped-at-band")
    fun `a person nominated by three papers owes what Q18 says, once as a person`() {
        val i = input((1L..3L).map { paper(it, "alice", "nina") }, listOf(cand("nina", by = listOf(1, 2, 3))))
        val expected = mapOf("once" to 18, "per-paper" to 54, "share-weighted" to 54, "capped-at-band" to 48)
        for ((q18, sixths) in expected) {
            val r = report(i, answers("Q8 = up-to-n", "Q10 = warn-only", "Q17 = none", "Q18 = $q18", "Q19 = equal", "Q19b = others-absorb"))
            val nina = r.obligations.single()
            assertEquals(listOf(1L, 2L, 3L), nina.papers)
            assertEquals(Resolved.Decided<Int?>(sixths), nina.owes, q18)
        }
        assertEquals(1, report(i).obligations.size, "one person, one obligation, however many papers")
    }

    @Test
    @Covers("card:X9", "prop:V2", "q:Q19b=others-absorb", "q:Q19b=paper-short")
    fun `a declined co-nominee's share goes to the other nominee or is left unmet, never to someone else`() {
        val i = input(listOf(paper(5, "dana", "eli", "fay")), listOf(cand("eli", by = listOf(5)), cand("fay", by = listOf(5), decision = Decision.DECLINE)))
        val absorb = report(i, answers("Q8 = up-to-n", "Q10 = warn-only", "Q17 = none", "Q18 = share-weighted", "Q19 = equal", "Q19b = others-absorb"))
        assertEquals(Resolved.Decided<Int?>(18), absorb.obligations.single { it.email == e("eli") }.owes)
        assertEquals(Resolved.Decided(0), absorb.papers.single().shortfall)
        val short = report(i, answers("Q8 = up-to-n", "Q10 = warn-only", "Q17 = none", "Q18 = share-weighted", "Q19 = equal", "Q19b = paper-short"))
        assertEquals(Resolved.Decided<Int?>(9), short.obligations.single { it.email == e("eli") }.owes)
        assertEquals(Resolved.Decided(9), short.papers.single().shortfall, "the paper is short by a review and a half")
        assertEquals(Resolved.Decided<Int?>(0), short.obligations.single { it.email == e("fay") }.owes, "the declined owes nothing")
        // only people the authors named have an obligation (V2)
        assertEquals(setOf(e("eli"), e("fay")), short.obligations.map { it.email }.toSet())
    }

    @Test
    @Covers("q:Q19=equal", "q:Q19=authors-allocate", "q:Q19=solver")
    fun `an open question is never defaulted, the report lists what each reading would give`() {
        val i = input(listOf(paper(5, "dana", "eli", "fay")), listOf(cand("eli", by = listOf(5)), cand("fay", by = listOf(5), decision = Decision.DECLINE)))
        val open = report(i, answers("Q8 = up-to-n", "Q10 = warn-only", "Q17 = none", "Q18 = share-weighted", "Q19b = paper-short"))
        val owes = open.obligations.single { it.email == e("eli") }.owes
        assertTrue(owes is Resolved.Open)
        owes as Resolved.Open<Int?>
        assertEquals(listOf(QId.Q19), owes.by)
        // equal and "authors allocate" (an equal split stands in) give 9; the solver pools the share
        assertEquals(setOf(9, null), owes.cases.map { it.second }.toSet())
        assertEquals(setOf("equal", "authors-allocate", "solver"), owes.cases.map { it.first.getValue(QId.Q19) }.toSet())
        val unanswered = report(i, Readings())
        assertEquals(emptyList<CapCase>(), unanswered.capCases.decided, "nobody is over the cap under either reading")
        // two nominees are compliant under two readings of Q8 and not under "one": open, with each reading listed
        val compliance = unanswered.papers.single().compliance
        assertTrue(compliance is Resolved.Open)
        assertEquals(setOf("one", "up-to-n", "at-least-one"), (compliance as Resolved.Open).cases.map { it.first.getValue(QId.Q8) }.toSet())
    }

    @Test
    @Covers("card:X7", "prop:M4", "q:Q17=none", "q:Q17=9")
    fun `an author over the cap is reported with their papers, and nothing is withdrawn`() {
        val papers = (1L..11L).map { paper(it, "prolific", "s$it") } + paper(12, "other", "x")
        val i = input(papers, emptyList())
        val at9 = report(i, answers("Q17 = 9", "Q8 = at-least-one", "Q10 = warn-only", "Q18 = once", "Q19 = equal", "Q19b = paper-short"))
        val cases = at9.capCases.decided!!
        assertEquals(listOf(CapCase(e("prolific"), (1L..11L).toList(), 2)), cases)
        val none = report(i, answers("Q17 = none", "Q8 = at-least-one", "Q10 = warn-only", "Q18 = once", "Q19 = equal", "Q19b = paper-short"))
        assertEquals(emptyList<CapCase>(), none.capCases.decided)
        val unresolved = report(i, Readings()).capCases
        assertTrue(unresolved is Resolved.Open, "with Q17 open, an author on 11 papers is over the cap under one reading and not the other")
        assertEquals(listOf(QId.Q17), (unresolved as Resolved.Open).by)
        val nine = (1L..9L).map { paper(it, "nine", "s$it") }
        assertEquals(emptyList<CapCase>(), report(input(nine, emptyList())).capCases.decided, "exactly 9 is within the cap")
    }

    @Test
    @Covers("card:X3", "prop:V3", "prop:M4")
    fun `a senior who always nominates a junior is shown as a pattern and nothing follows from it`() {
        val papers = (1L..6L).map { paper(it, "senior", "s$it") }
        val sheet = (1L..6L).map { cand("s$it", by = listOf(it)) } + cand("senior", origin = "invited", tier = Tier.SENIOR)
        val r = report(input(papers, sheet))
        val p = r.patterns.single()
        assertEquals(e("senior"), p.author)
        assertEquals((1L..6L).toList(), p.papers)
        assertEquals("no consequence by itself", p.consequence)
        assertTrue(r.papers.all { it.compliant() == Compliance.OK && it.referable == null }, "a pattern never makes a paper referable")
        // not a pattern: a junior author, a mixed set of tiers, a nominated self, and too few papers
        val junior = report(input(papers, sheet.map { if (it.email == e("senior")) it.copy(tier = Tier.JUNIOR) else it }))
        assertTrue(junior.patterns.isEmpty())
        val mixed = report(input(papers, sheet.map { if (it.email == e("s3")) it.copy(tier = Tier.SENIOR) else it }))
        assertTrue(mixed.patterns.isEmpty())
        val self =
            report(
                input(papers, sheet + cand("senior", by = listOf(1)).copy(origin = "nominee", tier = Tier.SENIOR)).let {
                    it.copy(
                        sheet =
                            it.sheet.filter { c ->
                                c.email !=
                                    e("senior") ||
                                    c.origin == "nominee"
                            },
                    )
                },
            )
        assertTrue(self.patterns.isEmpty())
        val few = report(input(papers.take(2), sheet.take(2) + sheet.last()))
        assertTrue(few.patterns.isEmpty())
    }

    @Test
    @Covers("prop:V1", "rule:eligible")
    fun `a decision by someone who is not the paper's AC is never acted on`() {
        val i =
            input(
                listOf(paper(1, "a", "nina")),
                listOf(cand("nina", by = listOf(1), ac = "mallory"), cand("lee", origin = "invited", ac = "")),
                pc = emptySet(),
            )
        val r = report(i)
        assertEquals(Decision.PENDING, NominationRules.effective(i).first.first { it.email == e("nina") }.decision)
        assertTrue(r.anomalies.any { it.subject == e("nina") && "never acted on" in it.message })
        assertTrue(r.obligations.single().let { !it.accepted && it.provisional })
        val plan = Appointments.plan(i, emptyMap())
        assertTrue(plan.drafts.isEmpty(), "no membership draft from a forged decision")
        assertNotNull(plan.skipped.firstOrNull { it.first == e("nina") })
    }

    @Test
    @Covers("assume:A4")
    fun `an accepted, classified, consenting candidate who is not on the PC gets a membership draft with their tags`() {
        val sheet =
            listOf(
                cand("nina", by = listOf(1)),
                cand("senior-nominee", by = listOf(1), tier = Tier.SENIOR),
                cand("noconsent", by = listOf(1), consent = null),
                cand("refused", by = listOf(1), consent = false),
                cand("pending", by = listOf(1), decision = Decision.PENDING, tier = null, consent = null),
                cand("declined", by = listOf(1), decision = Decision.DECLINE),
                cand("onpc", origin = "invited", tier = Tier.SENIOR),
                cand("invitee", origin = "invited", tier = Tier.SENIOR),
            )
        val i = input(listOf(paper(1, "a", "nina")), sheet, pc = setOf(e("onpc")))
        val plan = Appointments.plan(i, mapOf("junior" to "junior", "nominee" to "nominee"))
        assertEquals(listOf("invitee", "nina", "senior-nominee").map(::e), plan.drafts.map { it.email })
        assertEquals(listOf("junior", "nominee"), plan.drafts.first { it.email == e("nina") }.tags)
        assertEquals(listOf("nominee"), plan.drafts.first { it.email == e("senior-nominee") }.tags, "senior is untagged by default")
        assertEquals(emptyList<String>(), plan.drafts.first { it.email == e("invitee") }.tags)
        assertTrue(plan.drafts.all { it.roles == "pc" })
        assertEquals(
            mapOf(
                "noconsent" to "consent not recorded",
                "refused" to "did not consent",
                "pending" to "the AC has not decided (or the decision isn't an AC's)",
                "declined" to "declined",
                "onpc" to "already on the PC",
            ),
            plan.skipped.associate { it.first.substringBefore('@') to it.second },
        )
    }

    @Test
    @Covers("prop:V1")
    fun `a nominee the sheet lists for a paper they did not author is reported`() {
        val i = input(listOf(paper(1, "a", "b")), listOf(cand("stranger", by = listOf(1)), cand("ghost", by = listOf(99))))
        val r = report(i)
        assertTrue(r.papers.single().notes.any { "not an author" in it })
        assertTrue(r.anomalies.any { "#99" in it.message })
        assertFalse(r.papers.single().nominees.single().isAuthor)
        assertNull(r.papers.single().referable)
    }
}
