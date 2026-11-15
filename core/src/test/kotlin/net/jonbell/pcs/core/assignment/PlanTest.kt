package net.jonbell.pcs.core.assignment

import net.jonbell.pcs.core.readings.Q13
import net.jonbell.pcs.core.readings.Q14
import net.jonbell.pcs.core.rules.Faults
import net.jonbell.pcs.core.rules.JuniorSeats
import net.jonbell.pcs.core.rules.Member
import net.jonbell.pcs.core.rules.Tier
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import kotlin.random.Random

/** The plan's properties on hand-built instances (PLAN M15; concepts A1 to A4, V1, V5, M3). */
@Family("T2")
class PlanTest {
    private fun sen(id: Long, cap: Int = 4, onPc: Boolean = true) = Reviewer(Member(id, Tier.SENIOR), cap, onPc = onPc)

    private fun jun(id: Long, cap: Int = 4) = Reviewer(Member(id, Tier.JUNIOR), cap)

    private fun nominee(id: Long, tier: Tier, cap: Int, owedSixths: Int, accepted: Boolean = true, consented: Boolean = true) =
        Reviewer(Member(id, tier, nominee = true, accepted = accepted, consented = consented), cap, owedSixths)

    private fun paper(pid: Long, authors: List<Long> = emptyList(), conflicts: List<Long> = emptyList()) = PlanPaper(pid, authors, conflicts)

    private fun cfg(q13: Q13 = Q13.ONE_JUNIOR, q14: Q14 = Q14.TIER_DECIDES, faults: Faults = Faults.NONE, k: Int = 3, rounds: Int = 3) =
        PlanConfig(q13, q14, faults, cycleMaxK = k, repairRounds = rounds)

    private fun everyone(rs: List<Reviewer>, ps: List<PlanPaper>, aff: (Reviewer, PlanPaper) -> Int = { _, _ -> 60 }) =
        rs.flatMap { r -> ps.map { p -> Candidate(r.who, p.pid, aff(r, p)) } }

    private fun solve(input: PlanInput, c: PlanConfig = cfg()): PlanResult =
        Planner.solve(input, c).also {
            assertEquals(emptyList<String>(), Planner.audit(input, c, it))
        }

    @Test
    @Covers("rule:composition", "prop:A1", "prop:A4", "prop:V1", "rule:load", "q:Q13=one-junior")
    fun `every paper gets two seniors and a junior, within every band, and only to eligible people`() {
        val rs = (1L..6).map { sen(it) } + (11L..13).map { jun(it) }
        val ps = (101L..103).map { paper(it, authors = listOf(it - 100)) }
        val input = PlanInput(rs, ps, everyone(rs, ps))
        val r = solve(input)
        assertEquals(3, r.composed)
        assertEquals(0, r.seniorShort + r.thirdShort)
        assertTrue(r.shortfalls.isEmpty())
        assertTrue(r.loads.all { (w, n) -> n <= input.reviewers.first { it.who == w }.cap })
        assertTrue(r.edges.none { e -> e.who == e.pid - 100 }, "no author reviews their own paper")
    }

    /** Three papers; seniors 1 to 3 (two seats a paper), PC juniors 11 to 13 and a reciprocal nominee junior 21 who owes [owed] sixths. */
    private fun seats(
        mode: JuniorSeats,
        seniors: Int = 6,
        owed: Int = 18,
        pinned: List<Pin> = emptyList(),
        papers: Int = 3,
    ): Pair<PlanResult, List<PlanPaper>> {
        val rs = (1L..seniors).map { sen(it) } + (11L..13).map { jun(it) } + nominee(21, Tier.JUNIOR, (owed + 5) / 6, owed)
        val ps = (101L..100 + papers).map { paper(it) }
        val c = cfg(q13 = Q13.ZERO_TO_TWO_JUNIORS).copy(juniorSeats = mode)
        return solve(PlanInput(rs, ps, everyone(rs, ps), pinned), c) to ps
    }

    private fun PlanResult.juniors(pid: Long) = edges.filter { it.pid == pid && it.who >= 11 }.map { it.who }

    private fun PlanResult.seniors(pid: Long) = edges.filter { it.pid == pid && it.who < 11 }.map { it.who }

    @Test
    @Covers("rule:composition", "rule:load", "q:Q13=zero-to-two-juniors", "card:P6")
    fun `junior seats fill - juniors take optional seats whenever load and what a nominee owes leave room, two a paper`() {
        val (r, ps) = seats(JuniorSeats.FILL)
        for (p in ps) {
            assertEquals(2, r.seniors(p.pid).size)
            assertEquals(2, r.juniors(p.pid).size, "two juniors on ${p.pid}")
        }
        assertEquals(3, r.composed)
        assertEquals(3, r.loads[21L], "the nominee works off all of what they owe (18 sixths = 3 reviews)")
    }

    @Test
    @Covers("rule:composition", "rule:load", "q:Q13=zero-to-two-juniors", "card:P6")
    fun `junior seats when short - seniors first, and a junior only to bring a paper to three reviewers`() {
        val (r, ps) = seats(JuniorSeats.WHEN_SHORT)
        for (p in ps) {
            assertEquals(2, r.seniors(p.pid).size)
            assertEquals(1, r.juniors(p.pid).size, "both senior seats filled, so one junior makes three reviewers on ${p.pid}")
        }
        assertEquals(3, r.composed)
        // one senior is all there is: the juniors make up the paper, up to the two the cap allows
        val (short, _) = seats(JuniorSeats.WHEN_SHORT, seniors = 1, papers = 1)
        assertEquals(1, short.seniors(101).size)
        assertEquals(2, short.juniors(101).size, "short of a senior, two juniors")
        assertEquals(1, short.seniorShort, "the paper still lacks a senior, and says so")
        // no junior is available: nothing to take the seat, and no shortfall is reported for an optional seat
        val rs = (1L..2).map { sen(it) }
        val ps1 = listOf(paper(101))
        val alone = solve(PlanInput(rs, ps1, everyone(rs, ps1)), cfg(q13 = Q13.ZERO_TO_TWO_JUNIORS).copy(juniorSeats = JuniorSeats.WHEN_SHORT))
        assertEquals(0, alone.thirdShort)
        assertEquals(1, alone.composed, "zero juniors meets the model's composition")
    }

    @Test
    @Covers("rule:composition", "rule:load", "prop:V5", "q:Q13=zero-to-two-juniors", "card:P6")
    fun `junior seats reciprocal only - the optional seats go to reciprocal nominees, PC juniors only when short`() {
        val (r, ps) = seats(JuniorSeats.RECIPROCAL_ONLY)
        // three papers, a nominee who owes three reviews: each paper gets the nominee's review, and with both seniors there no PC junior
        for (p in ps) {
            assertEquals(2, r.seniors(p.pid).size)
            assertEquals(listOf(21L), r.juniors(p.pid), "the reciprocal nominee, not a PC junior, on ${p.pid}")
        }
        assertEquals(3, r.loads[21L])
        // a nominee who owes only one review: the other papers make three reviewers with a PC junior ("when short"), not two
        val (some, _) = seats(JuniorSeats.RECIPROCAL_ONLY, owed = 6)
        assertEquals(1, some.edges.count { it.who == 21L })
        val withNominee = some.edges.first { it.who == 21L }.pid
        for (p in ps) {
            val js = some.juniors(p.pid)
            if (p.pid == withNominee) {
                assertEquals(listOf(21L), js, "no PC junior beside the nominee when both seniors are there")
            } else {
                assertEquals(1, js.size, "paper ${p.pid} reaches three reviewers with a PC junior")
                assertTrue(js.all { it in 11L..13L })
            }
        }
        // short of a senior: the nominee and a PC junior both sit
        val (short, _) = seats(JuniorSeats.RECIPROCAL_ONLY, seniors = 1, papers = 1)
        assertEquals(2, short.juniors(101).size)
        assertTrue(21L in short.juniors(101))
    }

    @Test
    @Covers("rule:composition", "q:Q13=one-junior", "q:Q13=one-or-two-juniors", "q:Q13=one-junior-or-nominee")
    fun `the choice of junior seats changes nothing under the other readings of Q13`() {
        val rs = (1L..6).map { sen(it) } + (11L..13).map { jun(it) } + nominee(21, Tier.JUNIOR, 3, 18)
        val ps = (101L..103).map { paper(it) }
        for (q13 in listOf(Q13.ONE_JUNIOR, Q13.ONE_OR_TWO_JUNIORS, Q13.ONE_JUNIOR_OR_NOMINEE)) {
            val base = solve(PlanInput(rs, ps, everyone(rs, ps)), cfg(q13 = q13))
            for (m in JuniorSeats.entries) {
                val r = solve(PlanInput(rs, ps, everyone(rs, ps)), cfg(q13 = q13).copy(juniorSeats = m))
                assertEquals(base.edges, r.edges, "$q13 under $m")
                assertEquals(base.objective, r.objective)
            }
        }
    }

    @Test
    @Covers("rule:composition", "q:Q13=zero-to-two-juniors")
    fun `pinned juniors count toward the optional seats in every mode, and a pinned reciprocal nominee is a junior`() {
        for (m in JuniorSeats.entries) {
            val (r, _) = seats(m, papers = 1, pinned = listOf(Pin(11, 101), Pin(21, 101)))
            assertEquals(emptyList<Long>(), r.juniors(101).filter { it in 12L..13L }, "two pinned juniors fill the cap under $m")
            assertEquals(2, r.seniors(101).size)
        }
        // when short counts a pinned junior toward the three reviewers: two seniors and one pinned junior leave no room
        val (w, _) = seats(JuniorSeats.WHEN_SHORT, papers = 1, pinned = listOf(Pin(11, 101)))
        assertEquals(emptyList<Long>(), w.juniors(101))
    }

    @Test
    @Covers("rule:composition", "prop:A1", "prop:V5", "q:Q13=zero-to-two-juniors")
    fun `zero to two juniors take first-pass seats beside the seniors, never more than two with reciprocal ones`() {
        val seniors = (1L..4).map { sen(it) }
        val juniors = (11L..13).map { jun(it) }
        val nom = nominee(21, Tier.JUNIOR, 4, 18)
        val rs = seniors + juniors + nom
        val ps = listOf(paper(101), paper(102))
        val input = PlanInput(rs, ps, everyone(rs, ps))
        val c = cfg(q13 = Q13.ZERO_TO_TWO_JUNIORS)
        val r = solve(input, c)
        assertEquals(2, r.composed)
        assertEquals(0, r.seniorShort + r.thirdShort, "zero seats are required, so none is short")
        val byPaper = r.edges.groupBy { it.pid }
        for (p in ps) {
            val es = byPaper.getValue(p.pid)
            assertEquals(2, es.count { it.who in 1L..4L }, "two seniors on ${p.pid}")
            val juniorSeats = es.count { it.who in 11L..21L }
            assertTrue(juniorSeats in 1..2, "up to two juniors on ${p.pid}, reciprocal ones included: $juniorSeats")
        }
        assertTrue(r.edges.any { it.who == 21L }, "the reciprocal nominee works off what they owe")
        // pinned juniors, reciprocal ones included, use up the cap
        val pinned = PlanInput(rs, listOf(paper(101)), everyone(rs, listOf(paper(101))), pinned = listOf(Pin(11, 101), Pin(21, 101)))
        val rp = solve(pinned, c)
        assertEquals(emptyList<Long>(), rp.edges.filter { it.who in 12L..13L }.map { it.who }, "no third junior beside two pinned ones")
        assertTrue(rp.composed == 1)
    }

    @Test
    @Covers("prop:V1", "rule:eligible", "mutant:2")
    fun `an unaccepted, unconsented or unclassified person is never assigned, and the mutant would assign them`() {
        val good = (1L..4).map { sen(it) } + jun(11)
        val bad =
            listOf(
                nominee(20, Tier.SENIOR, 4, 24, accepted = false),
                nominee(21, Tier.JUNIOR, 4, 24, consented = false),
                Reviewer(Member(22, null, nominee = true), 4),
            )
        val ps = listOf(paper(101))
        // the unaccepted ones have the best affinity of anyone
        val input = PlanInput(good + bad, ps, everyone(good + bad, ps) { r, _ -> if (r.who >= 20) 100 else 50 })
        val r = solve(input)
        assertTrue(r.edges.none { it.who >= 20 })
        val faulty = cfg(faults = Faults(assignUnaccepted = true))
        val m = Planner.solve(input, faulty)
        assertTrue(m.edges.any { it.who in 20L..21L }, "with the mutant the unaccepted nominee is planned")
        assertTrue(Planner.audit(input, faulty, m).any { it.startsWith("V1") }, "and the audit, which uses the signed rules, says so")
    }

    @Test
    @Covers("prop:A4", "rule:load")
    fun `an overloaded senior is held to their band, existing reviews count, and an excess is reported`() {
        val star = sen(1, cap = 2)
        val others = (2L..7).map { sen(it, cap = 4) } + (11L..13).map { jun(it) }
        val ps = (101L..104).map { paper(it) }
        val input =
            PlanInput(
                listOf(star) + others,
                ps,
                everyone(listOf(star) + others, ps) { r, _ ->
                    if (r.who ==
                        1L
                    ) {
                        100
                    } else {
                        40
                    }
                },
                pinned = listOf(Pin(1, 101)),
            )
        val r = solve(input)
        assertEquals(2, r.loads[1L], "one existing review plus one new: the band of 2")
        assertEquals(0, r.bandViolations.size)
        // already over: an existing load past the band is reported, and nothing is added
        val over = PlanInput(listOf(sen(1, cap = 1)) + others, ps, everyone(listOf(sen(1, cap = 1)) + others, ps), pinned = listOf(Pin(1, 101), Pin(1, 102)))
        val o = Planner.solve(over, cfg())
        assertEquals(listOf(1L to 2), o.bandViolations)
        assertTrue(o.edges.none { it.who == 1L })
    }

    @Test
    @Covers("prop:A1", "rule:composition")
    fun `a paper that cannot be staffed is reported with its reason`() {
        val rs = (1L..5).map { sen(it) } + (11L..12).map { jun(it) }
        val ps = listOf(paper(101, conflicts = listOf(1, 2, 3, 4)), paper(102, authors = listOf(5)))
        val r = solve(PlanInput(rs, ps, everyone(rs, ps)))
        val s = r.shortfalls.single { it.pid == 101L && it.slot == Slot.SENIOR }
        assertEquals(1, s.needed - s.filled)
        assertTrue("4 conflicted" in s.reason, s.reason)
        assertFalse(r.papers.first { it.pid == 101L }.composed)
        assertTrue(r.papers.first { it.pid == 102L }.composed)
    }

    @Test
    @Covers("prop:A1", "q:Q13=one-junior-or-nominee", "q:Q14=nominee-not-senior", "q:Q14=tier-decides")
    fun `Q14 decides whether a senior nominee fills a senior seat`() {
        val rs = listOf(sen(1), nominee(20, Tier.SENIOR, 3, 18), nominee(21, Tier.SENIOR, 3, 18), jun(11))
        val ps = listOf(paper(101))
        val input = PlanInput(rs, ps, everyone(rs, ps))
        val tier = solve(input, cfg(q14 = Q14.TIER_DECIDES))
        assertEquals(2, tier.papers.single().seniors.size, "tier alone decides: nominees fill the seniors' seats")
        val notSenior = solve(input, cfg(q14 = Q14.NOMINEE_NOT_SENIOR))
        assertEquals(1, notSenior.papers.single().seniors.size, "under the other reading only the one real senior counts")
        assertEquals(1, notSenior.shortfalls.count { it.slot == Slot.SENIOR })
    }

    @Test
    @Covers("prop:A3", "rule:cycle-free", "mutant:9")
    fun `a reciprocal 2-cycle is broken at its weaker edge, and the K = 1 mutant leaves it`() {
        // 1 wrote #101 and 2 wrote #102; each is the best match for the other's paper
        val rs = (1L..2).map { sen(it) } + (3L..6).map { sen(it) } + (11L..12).map { jun(it) }
        val ps = listOf(paper(101, authors = listOf(1)), paper(102, authors = listOf(2)))
        val aff: (Reviewer, PlanPaper) -> Int = { r, p -> if ((r.who == 1L && p.pid == 102L) || (r.who == 2L && p.pid == 101L)) 95 else 50 }
        val input = PlanInput(rs, ps, everyone(rs, ps, aff))
        val r = solve(input)
        assertTrue(r.cyclesFirst > 0, "the first solve has the cycle")
        assertEquals(emptyList<PaperCycle>(), r.cyclesLeft)
        assertTrue(r.repairs.isNotEmpty())
        assertFalse(r.edges.any { it.who == 1L && it.pid == 102L } && r.edges.any { it.who == 2L && it.pid == 101L }, "not both edges")
        val m = Planner.solve(input, cfg(faults = Faults(cycleK1 = true)))
        assertTrue(m.edges.any { it.who == 1L && it.pid == 102L } && m.edges.any { it.who == 2L && it.pid == 101L }, "the mutant leaves both")
        assertTrue(Planner.audit(input, cfg(), m).any { it.startsWith("A3") })
        // with no repair rounds the cycle is reported, never silent
        val none = Planner.solve(input, cfg(rounds = 0))
        assertEquals(1, none.cyclesLeft.size)
        assertEquals(emptyList<String>(), Planner.audit(input, cfg(rounds = 0), none))
    }

    @Test
    @Covers("prop:A3", "rule:cycle-free")
    fun `a 3-cycle is broken up to PCS_CYCLE_MAX_K and ignored beyond it`() {
        val rs = (1L..3).map { sen(it) } + (4L..8).map { sen(it) } + (11L..13).map { jun(it) }
        val ps = listOf(paper(101, authors = listOf(1)), paper(102, authors = listOf(2)), paper(103, authors = listOf(3)))
        // 1 -> #102, 2 -> #103, 3 -> #101: each author reviews the next paper
        val hot = setOf(1L to 102L, 2L to 103L, 3L to 101L)
        val input = PlanInput(rs, ps, everyone(rs, ps) { r, p -> if (r.who to p.pid in hot) 95 else 50 })
        val k3 = solve(input, cfg(k = 3))
        assertTrue(k3.cyclesFirst > 0)
        assertEquals(0, k3.cyclesLeft.size)
        assertTrue(hot.any { (w, p) -> k3.edges.none { it.who == w && it.pid == p } }, "one hop of the ring is gone")
        val k2 = Planner.solve(input, cfg(k = 2))
        assertEquals(0, k2.cyclesFirst, "K = 2 does not look for rings of three")
        assertTrue(hot.all { (w, p) -> k2.edges.any { it.who == w && it.pid == p } })
    }

    @Test
    @Covers("prop:A3", "rule:cycle-free")
    fun `repair repeats until no ring remains, needing more than three rounds, and reports what the cap leaves`() {
        // author 1 (cap 1) wants #102, #103, #104, #105 in that order, and each of those authors is a hot first-pass
        // reviewer of #101: every repair of 1's edge moves 1 on to the next paper whose author reviews #101, so each round
        // makes a new ring and a single hub paper needs four rounds before the fifth solve is clean
        val rs =
            listOf(Reviewer(Member(1, Tier.SENIOR), 1)) + (2L..8).map { sen(it) } + (12L..15).map { jun(it) }
        val ps =
            listOf(
                paper(101, authors = listOf(1)),
                paper(102, authors = listOf(2)),
                paper(103, authors = listOf(3)),
                paper(104, authors = listOf(12)),
                paper(105, authors = listOf(13)),
                paper(106),
            )
        val hotFor1 = mapOf(102L to 95, 103L to 90, 104L to 85, 105L to 80)
        val hubReviewers = setOf(2L, 3L, 12L, 13L)
        val aff: (Reviewer, PlanPaper) -> Int = { r, p ->
            when {
                r.who == 1L -> hotFor1[p.pid] ?: 50
                r.who in hubReviewers && p.pid == 101L -> 99
                else -> 50
            }
        }
        val input = PlanInput(rs, ps, everyone(rs, ps, aff))
        val c = cfg(q13 = Q13.ZERO_TO_TWO_JUNIORS, k = 2, rounds = 10)
        val full = solve(input, c)
        assertTrue(full.cyclesFirst > 0)
        assertEquals(emptyList<PaperCycle>(), full.cyclesLeft, "repeated until no ring is left")
        assertTrue(full.repairs.maxOf { it.round } > 3, "needed more than 3 rounds: ${full.repairs.map { it.round }}")
        val capped = Planner.solve(input, c.copy(repairRounds = 3))
        assertTrue(capped.cyclesLeft.isNotEmpty(), "the old three-round cap leaves a ring")
        assertEquals(emptyList<String>(), Planner.audit(input, c.copy(repairRounds = 3), capped), "and it is reported, never silent")
        assertEquals(10, PlanConfig(Q13.ONE_JUNIOR, Q14.TIER_DECIDES).repairRounds, "the default safety cap")
    }

    @Test
    @Covers("prop:A3")
    fun `a second partition, one reviewer per institution, is repaired the same way`() {
        val base = (1L..6).map { sen(it) } + (11L..12).map { jun(it) }
        val rs = base.map { if (it.who <= 3) it.copy(institution = "Synthetic U") else it }
        val ps = listOf(paper(101))
        val input = PlanInput(rs, ps, everyone(rs, ps) { r, _ -> if (r.who <= 3) 90 else 50 })
        val c = cfg().copy(maxPerInstitution = 1)
        val r = Planner.solve(input, c)
        assertEquals(1, r.edges.count { it.who <= 3 })
        assertTrue(r.repairs.any { "institution" in it.reason || "Synthetic U" in it.reason })
        assertEquals(2, r.papers.single().seniors.size)
    }

    @Test
    @Covers("prop:V5", "prop:V2", "rule:load")
    fun `a nominee is aimed at what they owe and never above it, and a shortfall comes with its reason`() {
        val rs =
            (1L..6).map { sen(it) } + (11L..13).map { jun(it) } + nominee(30, Tier.JUNIOR, cap = 3, owedSixths = 18) +
                nominee(31, Tier.JUNIOR, cap = 3, owedSixths = 18)
        val ps = (101L..106).map { paper(it) }
        // 31 has no affinity data on any paper: the plan can't give them what they owe
        val aff = everyone(rs.filter { it.who != 31L }, ps) { r, _ -> if (r.who == 30L) 90 else 50 }
        val r = solve(PlanInput(rs, ps, aff), cfg(q13 = Q13.ONE_JUNIOR_OR_NOMINEE))
        val n30 = r.nominees.first { it.who == 30L }
        assertEquals(3, n30.load)
        assertTrue(n30.withinOne)
        assertTrue(r.loads.all { (w, n) -> n <= rs.first { it.who == w }.cap })
        val n31 = r.nominees.first { it.who == 31L }
        assertFalse(n31.withinOne)
        assertTrue(n31.reason!!.contains("only 0 eligible"), n31.reason)
    }

    @Test
    @Covers("prop:A1")
    fun `hard mode makes an unstaffable paper infeasible and the report says which`() {
        val rs = (1L..3).map { sen(it) } + jun(11)
        val ps = listOf(paper(101, conflicts = listOf(1, 2, 3)), paper(102))
        val input = PlanInput(rs, ps, everyone(rs, ps))
        val soft = Planner.solve(input, cfg())
        assertFalse(soft.infeasible)
        val hard = Planner.solve(input, cfg().copy(hard = true))
        assertTrue(hard.infeasible)
        assertTrue(hard.shortfalls.any { it.pid == 101L })
    }

    @Test
    @Covers("rule:load")
    fun `affinity sources are normalized to one scale and blended by weight`() {
        val tpms = AffinitySource.tpms(mapOf((1L to 1L) to 0.5, (1L to 2L) to 1.0), weight = 3.0)
        val prefs = AffinitySource.hotcrpPreferences(mapOf((1L to 1L) to 20.0, (1L to 3L) to -20.0), weight = 1.0)
        val c = Affinity.combine(listOf(tpms, prefs))
        assertEquals(63, c[1L to 1L], "(3*50 + 1*100) / 4")
        assertEquals(100, c[1L to 2L], "only TPMS has the edge")
        assertEquals(0, c[1L to 3L], "only the preferences have it, at the bottom of their range")
    }

    @Test
    @Covers("prop:H1")
    fun `the CSV lists seniors first and holds back anyone not yet on the HotCRP PC`() {
        val rs = (1L..4).map { sen(it) } + sen(5, onPc = false) + jun(11)
        val ps = listOf(paper(101))
        val input = PlanInput(rs, ps, everyone(rs, ps) { r, _ -> if (r.who == 5L) 99 else 50 })
        val b =
            AssignmentBuild(
                input,
                cfg(),
                (
                    rs.map {
                        it.who
                    }
                ).associateWith { "u$it@example.org" },
                emptyMap(),
                emptyMap(),
                emptyList(),
                emptyList(),
                AssignmentSettings(emptyMap(), round = "R1"),
            )
        val plan = Planner.solve(input, b.config)
        val csv = AssignmentOutput.csv(plan, b)
        assertEquals(listOf("101,primary,u5@example.org").size, csv.awaitingMembership.size, "the best match isn't on the PC yet")
        assertTrue(csv.rows.take(plan.papers.single().seniors.size - 1).all { it["action"] == "primary" })
        assertEquals("secondary", csv.rows.last()["action"])
        assertTrue(csv.toCsv().startsWith("paper,action,email,round\n101,primary,"))
        assertTrue(csv.rows.none { it["email"] == "u5@example.org" })
    }

    @Test
    @Covers("prop:M3")
    fun `conflict engineering is flagged for a paper that excludes most of its qualified reviewers, and not otherwise`() {
        val rs = (1L..12).map { sen(it) } + (21L..22).map { jun(it) }
        val ps = (101L..110).map { paper(it) } + paper(111, conflicts = (1L..9).toList())
        val positive = ConflictMonitor.scan(PlanInput(rs, ps, everyone(rs, ps) { _, _ -> 80 }))
        assertEquals(listOf(111L), positive.map { it.pid })
        assertEquals(9, positive.single().excluded)
        // a spread of ordinary conflicts is not a signal
        val fair = (101L..111).map { paper(it, conflicts = listOf(it - 100, (it - 100) % 12 + 1)) }
        assertEquals(emptyList<ConflictSignal>(), ConflictMonitor.scan(PlanInput(rs, fair, everyone(rs, fair) { _, _ -> 80 })))
        // a conflict with someone unqualified for the paper doesn't count
        val low = ConflictMonitor.scan(PlanInput(rs, ps, everyone(rs, ps) { r, p -> if (p.pid == 111L && r.who <= 9) 10 else 80 }))
        assertEquals(emptyList<ConflictSignal>(), low)
    }

    @Test
    @Covers("prop:M3")
    fun `each number of the conflict monitor is a setting, tested away from its default`() {
        fun monitor(vararg kv: Pair<String, String>) =
            AssignmentSettings.of(
                net.jonbell.pcs.core.config.Settings.load(
                    mapOf("PCS_HOTCRP_URL" to "https://conf.example.org", "PCS_ANSWERS" to "/tmp/answers.txt") + kv,
                ).getOrThrow(),
            ).monitor
        assertEquals(MonitorConfig(), monitor())

        fun rounds(vararg kv: Pair<String, String>) =
            AssignmentSettings.of(
                net.jonbell.pcs.core.config.Settings.load(
                    mapOf("PCS_HOTCRP_URL" to "https://conf.example.org", "PCS_ANSWERS" to "/tmp/answers.txt") + kv,
                ).getOrThrow(),
            ).repairRounds
        assertEquals(10, rounds())
        assertEquals(25, rounds("PCS_CYCLE_REPAIR_MAX_ROUNDS" to "25"))
        assertEquals(
            MonitorConfig(qualifiedAffinity = 70, minShare = 0.2, minExcluded = 2, sigma = 4.0),
            monitor("PCS_M3_AFFINITY_MIN" to "70", "PCS_M3_MIN_SHARE" to "0.2", "PCS_M3_MIN_EXCLUDED" to "2", "PCS_M3_SIGMA" to "4"),
        )
        assertEquals(MonitorConfig(), monitor("PCS_M3_SIGMA" to "-1", "PCS_M3_MIN_SHARE" to "7"), "nonsense falls back to the default")

        val rs = (1L..12).map { sen(it) } + (21L..22).map { jun(it) }
        // ten papers each exclude 4 of the 12 seniors, and #111 excludes 5: a share of 0.33 against 0.42
        val ps = (101L..110).map { paper(it, conflicts = (1L..4).toList()) } + paper(111, conflicts = (1L..5).toList())

        fun scan(m: MonitorConfig, aff: Int = 80) = ConflictMonitor.scan(PlanInput(rs, ps, everyone(rs, ps) { _, _ -> aff }), m).map { it.pid }
        // the default share of one half flags nothing here; a lower share flags the outlier only when the sigma is small enough
        assertEquals(emptyList<Long>(), scan(MonitorConfig()))
        assertEquals(listOf(111L), scan(MonitorConfig(minShare = 0.2, sigma = 2.0)))
        assertEquals(emptyList<Long>(), scan(MonitorConfig(minShare = 0.2, sigma = 4.0)))
        // the minimum count of excluded reviewers
        assertEquals(emptyList<Long>(), scan(MonitorConfig(minShare = 0.2, sigma = 2.0, minExcluded = 6)))
        // the affinity that makes a reviewer qualified: at 80 nobody is qualified when the bar is 90
        assertEquals(emptyList<Long>(), scan(MonitorConfig(minShare = 0.2, sigma = 2.0, qualifiedAffinity = 90)))
        assertEquals(listOf(111L), scan(MonitorConfig(minShare = 0.2, sigma = 2.0, qualifiedAffinity = 80)), "the bar is inclusive")
    }

    @Test
    @Covers("prop:A1", "prop:A2", "prop:A3", "prop:A4", "prop:V1")
    fun `on random instances the audit never finds a violation`() {
        for (seed in 1..150) {
            val rnd = Random(seed)
            val ns = 4 + rnd.nextInt(6)
            val nj = 2 + rnd.nextInt(4)
            val nn = rnd.nextInt(4)
            val rs =
                (1..ns).map { sen(it.toLong(), cap = 1 + rnd.nextInt(4)) } + (1..nj).map { jun(10L + it, cap = 1 + rnd.nextInt(3)) } +
                    (1..nn).map {
                        nominee(
                            30L + it,
                            if (rnd.nextBoolean()) Tier.SENIOR else Tier.JUNIOR,
                            cap = 1 + rnd.nextInt(3),
                            owedSixths =
                                6 * rnd.nextInt(4),
                            accepted = rnd.nextInt(4) != 0,
                        )
                    }
            val ps =
                (1..(3 + rnd.nextInt(6))).map { i ->
                    paper(100L + i, authors = rs.filter { rnd.nextInt(6) == 0 }.map { it.who }, conflicts = rs.filter { rnd.nextInt(6) == 0 }.map { it.who })
                }
            val cs = rs.flatMap { r -> ps.filter { rnd.nextInt(4) != 0 }.map { p -> Candidate(r.who, p.pid, rnd.nextInt(101)) } }
            val pins = ps.take(2).flatMap { p -> rs.filter { rnd.nextInt(10) == 0 }.map { Pin(it.who, p.pid) } }
            val c = cfg(Q13.entries[rnd.nextInt(4)], Q14.entries[rnd.nextInt(2)], k = 2 + rnd.nextInt(2))
            val input = PlanInput(rs, ps, cs, pins)
            val r = Planner.solve(input, c)
            val problems = Planner.audit(input, c, r)
            assertEquals(emptyList<String>(), problems, "seed $seed")
            // determinism: the same input gives the same plan
            assertEquals(r.edges, Planner.solve(input, c).edges, "seed $seed")
        }
    }
}
