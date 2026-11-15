package net.jonbell.pcs.core.triage

import net.jonbell.pcs.core.readings.Q1
import net.jonbell.pcs.core.readings.Q10
import net.jonbell.pcs.core.readings.Q2
import net.jonbell.pcs.core.readings.Q3
import net.jonbell.pcs.core.readings.Q6
import net.jonbell.pcs.core.readings.Readings
import net.jonbell.pcs.core.rules.Conventions
import net.jonbell.pcs.core.rules.DeskReject
import net.jonbell.pcs.core.rules.Faults
import net.jonbell.pcs.core.rules.Ground
import net.jonbell.pcs.core.rules.Stage
import net.jonbell.pcs.core.rules.Tier
import net.jonbell.pcs.core.rules.Trace
import net.jonbell.pcs.core.rules.TriageChoice
import net.jonbell.pcs.core.triage.TriageFixture.Companion.bundle
import net.jonbell.pcs.core.triage.TriageFixture.Companion.finding
import net.jonbell.pcs.core.triage.TriageFixture.Companion.readings
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** The triage queue over a hand-built mirror: the status of each paper, the model's rule behind it, and the timing of Q3. */
@Family("T3")
class TriagePlanTest {
    private val ac = "ac@example.org"
    private val now = 1_900_000_000L
    private val nowH = now / 3600

    private fun plan(
        r: Readings = readings(),
        stage: Stage = Stage.SCREENING,
        f: Faults = Faults.NONE,
        nowHours: Long = nowH,
        findings: List<net.jonbell.pcs.core.bundle.BundleFinding> = emptyList(),
        build: TriageFixture.() -> Unit,
    ): TriageReport.Ready {
        val store = TriageFixture.store(build)
        return TriagePlan.compute(store, bundle(findings), emptyList(), r, stage, nowHours, TriageFixture.tiers, f) as TriageReport.Ready
    }

    @Test
    @Covers("prop:S8")
    fun `a flagged paper the AC has not triaged stays in review, and an AC's referral in her review waits for a chair to mirror it`() {
        val rep =
            plan(findings = listOf(finding(1, "format"), finding(2, "format"))) {
                people()
                paper(1)
                paper(2)
                meta(1, ac, round = "screen")
                meta(2, ac, triage = 2, round = "screen")
            }
        assertEquals(TriageStatus.UNTRIAGED, rep.status(1), "findings alone never remove (S8)")
        assertEquals(TriageStatus.NEEDS_SECOND_OPINION, rep.status(2))
        assertTrue(rep.rows.single { it.pid == 2L }.needsMirror)
        assertFalse(rep.rows.single { it.pid == 1L }.needsMirror)
    }

    private fun TriageFixture.people() {
        listOf(ac, "senior1@example.org", "senior2@example.org", "junior1@example.org").forEach { person(it) }
    }

    private fun scenario(
        r: Readings = readings(),
        stage: Stage = Stage.SCREENING,
        f: Faults = Faults.NONE,
    ) = plan(r, stage, f, findings = (3L..9L).map { finding(it, "format") }) {
        people()
        for (pid in 3L..9L) {
            paper(
                pid,
                tags = if (pid == 8L) listOf("pcs-keep") else listOf("pcs-refer-format"),
                conflicts = if (pid == 6L) listOf("senior1@example.org") else emptyList(),
                decision = if (pid == 9L) "Rejected" else null,
            )
            meta(pid, ac, round = null, note = if (pid == 7L) "my own note to the PC" else null)
        }
        opinion(3, "senior1@example.org", complete = false, askedAt = 3600 * (nowH - 100))
        opinion(4, "senior1@example.org")
        opinion(5, "junior1@example.org")
        opinion(6, "senior1@example.org")
        opinion(9, "senior2@example.org")
    }

    @Test
    @Covers("prop:S8", "prop:S1", "rule:may-remove", "card:E8")
    fun `the second opinion must come from someone else, unconflicted, and of Q2's kind`() {
        val rep = scenario()
        assertEquals(TriageStatus.OPINION_PENDING, rep.status(3), "asked, not answered: it stays in review")
        assertEquals(TriageStatus.READY, rep.status(4))
        assertEquals(TriageStatus.NEEDS_SECOND_OPINION, rep.status(5), "a junior is not a senior (Q2)")
        assertEquals(TriageStatus.NEEDS_SECOND_OPINION, rep.status(6), "a conflicted member's opinion does not count")
        assertEquals(TriageStatus.NEEDS_SECOND_OPINION, rep.status(7), "the AC's own note is not a second opinion")
        assertEquals(TriageStatus.KEPT, rep.status(8))
        assertEquals(TriageStatus.REMOVED, rep.status(9))
        assertEquals(setOf(4L), rep.rows.filter { it.status == TriageStatus.READY }.map { it.pid }.toSet())
    }

    @Test
    @Covers("prop:S8", "prop:S1")
    fun `the two specification mutants change what a chair may remove, and only they do`() {
        val anyone = scenario(f = Faults.MUTANTS[0])
        assertEquals(TriageStatus.READY, anyone.status(7), "mutant: second opinion from anyone, including the AC")
        assertEquals(TriageStatus.READY, anyone.status(6), "mutant: ... and a conflicted member")
        val silent = scenario(f = Faults.MUTANTS[1])
        assertEquals(TriageStatus.READY, silent.status(3), "mutant: silence removes (the request is over 72 h old)")
        val honest = scenario()
        assertFalse(honest.rows.any { it.pid in setOf(3L, 6L, 7L) && it.status == TriageStatus.READY })
    }

    private fun anonymity(
        r: Readings,
        tagsExtra: List<String> = emptyList(),
        modified: Long? = null,
        at: Long = nowH,
        decision: String? = null,
    ) = plan(r, nowHours = at, findings = listOf(finding(10, "anonymity"))) {
        people()
        paper(10, tags = listOf("pcs-refer-anonymity") + tagsExtra, modifiedAt = modified, decision = decision)
        meta(10, ac, round = null)
        opinion(10, "senior1@example.org")
    }

    @Test
    @Covers("prop:S10", "card:E3")
    fun `Q1 - a fix window is offered, honored, and a cure keeps the paper`() {
        val fix = readings(q1 = Q1.FIX_WINDOW)
        assertEquals(TriageStatus.READY, anonymity(readings(q1 = Q1.REJECT_AT_ONCE)).status(10), "reject at once: no window")
        assertEquals(TriageStatus.NEEDS_REMEDY, anonymity(fix).status(10))
        val due = nowH + 40
        val tag = Conventions.encode(Trace.RemedyDue(10, due * 3600))
        assertEquals(TriageStatus.REMEDY_OPEN, anonymity(fix, listOf(tag)).status(10), "offered, still open")
        assertEquals(TriageStatus.REMEDY_OPEN, anonymity(fix, listOf(tag), at = due).status(10), "the due hour itself is inside the window")
        assertEquals(TriageStatus.READY, anonymity(fix, listOf(tag), at = due + 1).status(10), "over, uncured")
        val curedAt = (due - 30) * 3600
        assertEquals(TriageStatus.CURED, anonymity(fix, listOf(tag), modified = curedAt, at = due + 1).status(10), "cured: it stays")
        assertEquals(
            TriageStatus.READY,
            anonymity(fix, listOf(tag), modified = (due - 200) * 3600, at = due + 1).status(10),
            "an edit before the offer is no cure",
        )
        assertEquals(
            TriageStatus.READY,
            anonymity(fix, listOf(tag), modified = (due + 5) * 3600, at = due + 6).status(10),
            "an edit after the window is no cure",
        )
        // the AC may not keep an anonymity violation under "reject at once", and may under the fix window
        val keep = { r: Readings ->
            plan(r, findings = listOf(finding(10, "anonymity"))) {
                people()
                paper(10, tags = listOf("pcs-keep"))
                meta(10, ac, round = null)
            }.status(10)
        }
        assertEquals(TriageStatus.KEEP_REFUSED, keep(readings(q1 = Q1.REJECT_AT_ONCE)))
        assertEquals(TriageStatus.KEPT, keep(fix))
        assertEquals(TriageStatus.KEPT, keep(readings(q1 = Q1.AC_DECIDES)))
    }

    private fun ready(r: Readings, stage: Stage, ground: String = "format", tags: List<String> = emptyList()) =
        plan(r, stage, findings = listOf(finding(10, ground))) {
            people()
            paper(10, tags = listOf("pcs-refer-$ground") + tags)
            meta(10, ac, round = null)
            opinion(10, "senior1@example.org")
        }.rows.single()

    @Test
    @Covers("prop:S9", "card:E4", "card:E4b")
    fun `Q3 - the stage decides, and a removal after the screening stage is tracked as late`() {
        val any = readings(q3 = Q3.ANY_UNTIL_RELEASE)
        assertEquals(listOf(false, true, true), listOf(Stage.SCREENING, Stage.ASSIGNED, Stage.IN_REVIEW).map { ready(any, it).late })
        assertEquals(TriageStatus.TOO_LATE, ready(any, Stage.RELEASED).status)
        val before = readings(q3 = Q3.BEFORE_ASSIGNMENT)
        assertEquals(TriageStatus.READY, ready(before, Stage.SCREENING).status)
        assertEquals(TriageStatus.TOO_LATE, ready(before, Stage.ASSIGNED).status)
        val anon = readings(q3 = Q3.ANONYMITY_UNTIL_RELEASE)
        assertEquals(TriageStatus.READY, ready(anon, Stage.IN_REVIEW, "anonymity").status)
        assertEquals(TriageStatus.TOO_LATE, ready(anon, Stage.RELEASED, "anonymity").status)
        assertEquals(TriageStatus.TOO_LATE, ready(anon, Stage.IN_REVIEW, "format").status)
        val anyStage = readings(q3 = Q3.ANONYMITY_ANY_STAGE)
        assertEquals(TriageStatus.READY, ready(anyStage, Stage.RELEASED, "anonymity").status)
        assertEquals(TriageStatus.TOO_LATE, ready(anyStage, Stage.RELEASED, "scope").status)
        assertEquals(TriageStatus.READY, ready(readings(q3 = Q3.ANY_ANY_STAGE), Stage.RELEASED, "scope").status)
    }

    @Test
    @Covers("card:E6", "card:X1")
    fun `Q6 and Q10 decide whether a ground is a ground`() {
        assertEquals(TriageStatus.READY, ready(readings(q6 = Q6.GROUNDS), Stage.SCREENING, "fabricated-reference").status)
        assertEquals(TriageStatus.NOT_ADMISSIBLE, ready(readings(q6 = Q6.EVIDENCE), Stage.SCREENING, "fabricated-reference").status)
        val nn = "nomination-noncompliance"
        assertEquals(TriageStatus.READY, ready(readings(q10 = Q10.DESK_REJECT), Stage.SCREENING, nn).status)
        assertEquals(TriageStatus.NEEDS_WARNING, ready(readings(q10 = Q10.WARN_THEN_REJECT), Stage.SCREENING, nn).status)
        assertEquals(TriageStatus.READY, ready(readings(q10 = Q10.WARN_THEN_REJECT), Stage.SCREENING, nn, listOf("pcs-warned")).status)
        assertEquals(TriageStatus.NOT_ADMISSIBLE, ready(readings(q10 = Q10.WARN_ONLY), Stage.SCREENING, nn, listOf("pcs-warned")).status)
    }

    @Test
    @Covers("rule:may-remove", "prop:S1", "prop:S9", "prop:S10")
    fun `a paper is ready exactly when the model's rule lets a chair remove it, and a blocked paper says which conjunct`() {
        val qs =
            Q1.entries.flatMap { a ->
                Q2.entries.flatMap { b -> Q3.entries.flatMap { c -> Q6.entries.flatMap { d -> Q10.entries.map { e -> readings(a, b, c, d, e) } } } }
            }
        var checked = 0
        for (r in qs) {
            for (g in Ground.entries) {
                for (stage in Stage.entries) {
                    for (warned in listOf(false, true)) {
                        for (rem in listOf("none", "open", "over", "cured")) {
                            for (ops in listOf("none", "ac-note", "senior", "junior", "conflicted", "senior+junior", "two seniors+junior")) {
                                val opinions =
                                    when (ops) {
                                        "none" -> emptyList()
                                        "ac-note" -> listOf(GivenOpinion(ac, Tier.SENIOR, false, isAcNote = true))
                                        "senior" -> listOf(GivenOpinion("s1@x", Tier.SENIOR, false))
                                        "junior" -> listOf(GivenOpinion("j1@x", Tier.JUNIOR, false))
                                        "conflicted" -> listOf(GivenOpinion("s1@x", Tier.SENIOR, true))
                                        "senior+junior" -> listOf(GivenOpinion("s1@x", Tier.SENIOR, false), GivenOpinion("j1@x", Tier.JUNIOR, false))
                                        else ->
                                            listOf(
                                                GivenOpinion("s1@x", Tier.SENIOR, false),
                                                GivenOpinion("s2@x", Tier.SENIOR, false),
                                                GivenOpinion("j1@x", Tier.JUNIOR, false),
                                            )
                                    }
                                val facts =
                                    DeskFacts(
                                        1,
                                        "t",
                                        ac,
                                        TriageChoice.Refer(g),
                                        TriageSource.TAG,
                                        true,
                                        opinions,
                                        emptyList(),
                                        remedyDueH = if (rem == "none") null else 1000,
                                        warned = warned,
                                        cured = rem == "cured",
                                        removed = false,
                                        authors = emptyList(),
                                        askedAtH = null,
                                    )
                                val nowHours = if (rem == "open") 990L else 1010L
                                val (status, why, _) = TriagePlan.statusOf(Faults.NONE, r, facts, stage, nowHours, anonymityFound = false)
                                val may = DeskReject.mayRemove(Faults.NONE, r, facts.referral(stage, nowHours)!!)
                                assertEquals(may, status == TriageStatus.READY, "$r $g $stage $ops $rem")
                                assertEquals(may, why.isEmpty(), "a blocked paper says why: $r $g $stage $ops $rem")
                                checked++
                            }
                        }
                    }
                }
            }
        }
        assertTrue(checked > 100_000, "$checked states")
    }

    @Test
    @Covers("prop:S7", "card:E11")
    fun `S7 - revising a ruling never removes a paper, it can only make a paper ready or not ready`() {
        val all =
            Q1.entries.flatMap { a ->
                Q2.entries.flatMap { b -> Q3.entries.flatMap { c -> Q6.entries.flatMap { d -> Q10.entries.map { e -> readings(a, b, c, d, e) } } } }
            }
        val facts = listOf(("none" to null), ("tag" to "pcs-refer-anonymity"), ("scope" to "pcs-refer-scope")).map { it.second }
        var pairs = 0
        for (tag in facts) {
            val store =
                TriageFixture.store {
                    people()
                    paper(1, tags = listOfNotNull(tag))
                    paper(2, tags = listOfNotNull(tag), decision = "Rejected")
                    meta(1, ac, round = null)
                    meta(2, ac, round = null)
                    opinion(1, "senior1@example.org")
                    opinion(2, "senior1@example.org")
                }
            for (before in all.filterIndexed { i, _ -> i % 7 == 0 }) {
                for (after in all.filterIndexed { i, _ -> i % 11 == 0 }) {
                    val b = TriagePlan.compute(store, null, emptyList(), before, Stage.SCREENING, nowH, TriageFixture.tiers) as TriageReport.Ready
                    val a = TriagePlan.compute(store, null, emptyList(), after, Stage.SCREENING, nowH, TriageFixture.tiers) as TriageReport.Ready
                    // paper 1 was not removed in HotCRP: no ruling makes it removed (only a chair's confirmed decision does)
                    assertTrue(b.status(1) != TriageStatus.REMOVED && a.status(1) != TriageStatus.REMOVED)
                    // paper 2 was removed in HotCRP: no ruling un-removes it in the plan; the plan keeps showing it as removed
                    if (tag != null) assertEquals(TriageStatus.REMOVED, a.status(2))
                    pairs++
                }
            }
            store.close()
        }
        assertTrue(pairs >= 200, "$pairs pairs")
    }

    @Test
    @Covers("prop:S1")
    fun `second opinion candidates are unconflicted PC members of Q2's kind, not the AC, not authors, and the least asked first`() {
        val store =
            TriageFixture.store {
                people()
                person("senior3@example.org")
                person("senior4@example.org")
                person("ac2@example.org")
                person("outsider@example.org", roles = "[]")
                paper(1, conflicts = listOf("senior2@example.org"), authors = listOf("senior4@example.org"))
                meta(1, ac, round = null)
                meta(2, "ac2@example.org", round = null)
                opinion(5, "senior3@example.org")
                review(1, "senior1@example.org")
            }
        val seniors = SecondOpinions.candidates(store, 1, Q2.AC_PLUS_SENIOR, TriageFixture.tiers).map { it.email }
        assertEquals(listOf("ac2@example.org", "senior3@example.org"), seniors)
        assertTrue("senior2@example.org" !in seniors && "senior4@example.org" !in seniors && ac !in seniors && "senior1@example.org" !in seniors)
        assertTrue("junior1@example.org" !in seniors && "outsider@example.org" !in seniors)
        assertEquals(listOf("ac2@example.org"), SecondOpinions.candidates(store, 1, Q2.AC_PLUS_AC, TriageFixture.tiers).map { it.email })
        assertEquals(emptyList<OpinionCandidate>(), SecondOpinions.candidates(store, 1, Q2.AC_ALONE, TriageFixture.tiers))
        assertTrue("junior1@example.org" in SecondOpinions.candidates(store, 1, Q2.VOTE, TriageFixture.tiers).map { it.email })
    }
}
