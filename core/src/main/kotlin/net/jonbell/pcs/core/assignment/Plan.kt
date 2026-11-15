package net.jonbell.pcs.core.assignment

import net.jonbell.pcs.core.readings.Q13
import net.jonbell.pcs.core.readings.Q14
import net.jonbell.pcs.core.rules.Faults
import net.jonbell.pcs.core.rules.JuniorSeats
import net.jonbell.pcs.core.rules.Member
import net.jonbell.pcs.core.rules.PaperFacts
import net.jonbell.pcs.core.rules.Pc
import net.jonbell.pcs.core.rules.Tier
import net.jonbell.pcs.core.solver.FlowNetwork

/*
 * The assignment plan (spec §10.4 C and §10.5; concepts Plan). One min-cost max-flow solve on the §10.5
 * network, then repair passes for what flow can't express, then an assessment. The network, the cost
 * shapes and the repair rule follow the Lean reference (`model/ReviewProcess/Solver.lean`), whose
 * report this one is tested against on the model's synthetic conference. Eligibility (V1, A2) and
 * composition are the model's rules in `Pc`; nothing here re-derives them.
 */

/** Which kind of seat a reviewer fills on a paper: Q14 decides who may fill a senior one. */
public enum class Slot { SENIOR, THIRD }

/**
 * Someone the plan may assign. [cap] is their band: the tier's `PCS_LOAD_<TIER>_MAX` for a PC member, and for an
 * accepted nominee what they owe (rounded up to a whole review), never more than the band (V2). [onPc] says whether
 * HotCRP already has them on the PC; the rest can't be sent assignments until their membership is applied.
 */
public data class Reviewer(
    val member: Member,
    val cap: Int,
    val owedSixths: Int? = null,
    val onPc: Boolean = true,
    /** Second-partition key (an institution), if any is known. */
    val institution: String? = null,
) {
    val who: Long get() = member.who
}

public data class PlanPaper(val pid: Long, val authors: List<Long> = emptyList(), val conflicts: List<Long> = emptyList())

/** A candidate edge with its affinity on the common 0 to 100 scale. */
public data class Candidate(val who: Long, val pid: Long, val aff: Int)

/** An assignment that already exists in HotCRP (a review made, a second-opinion member under Q5). It is never moved. */
public data class Pin(val who: Long, val pid: Long)

public data class PlanInput(
    val reviewers: List<Reviewer>,
    val papers: List<PlanPaper>,
    val candidates: List<Candidate>,
    val pinned: List<Pin> = emptyList(),
)

/** The owner's ruling (2026-11-15): repair until no ring remains, with a safety cap of 10 rounds. */
public const val DEFAULT_REPAIR_ROUNDS: Int = 10

public data class PlanConfig(
    val q13: Q13,
    val q14: Q14,
    val faults: Faults = Faults.NONE,
    /** `PCS_CYCLE_MAX_K`: cycles of up to this many papers are repaired. */
    val cycleMaxK: Int = 3,
    /**
     * `PCS_CYCLE_REPAIR_MAX_ROUNDS`: repair repeats until no ring of up to [cycleMaxK] papers remains (and no
     * institution group is over its limit); this is the safety cap. What is left after it is reported (A3).
     */
    val repairRounds: Int = DEFAULT_REPAIR_ROUNDS,
    /** `PCS_SOLVER_TOPK`. */
    val topK: Int = 25,
    /** `PCS_SOLVER_HARD`: slots are true lower bounds, so one unstaffable paper makes the solve infeasible. */
    val hard: Boolean = false,
    /** At most this many reviewers of one paper from one institution (a second partition); null = no rule. */
    val maxPerInstitution: Int? = null,
    /** A paper whose best candidate is below this affinity is reported as a weak match. */
    val weakAffinity: Int = 40,
    /** `PCS_JUNIOR_SEATS`, or the chair's choice in the Assignment tab: who takes the optional seats under Q13's "zero to two juniors". */
    val juniorSeats: JuniorSeats = JuniorSeats.FILL,
)

/** One repair: an edge forbidden, and why. */
public data class Repair(val who: Long, val pid: Long, val aff: Int, val round: Int, val reason: String)

/** A cycle of papers the plan has: each author of a paper reviews the next one. [edges] are the review edges that make the hops. */
public data class PaperCycle(val papers: List<Long>, val edges: List<Pair<Long, Long>>)

/** The plan for one paper: who sits in which slot, pinned reviewers included. */
public data class PaperPlan(val pid: Long, val seniors: List<Long>, val thirds: List<Long>, val neither: List<Long>, val composed: Boolean)

/** Why a slot is short. */
public data class Shortfall(val pid: Long, val slot: Slot, val needed: Int, val filled: Int, val reason: String)

/** The load of a nominee against what they owe (V5). */
public data class NomineeLoad(val who: Long, val load: Int, val cap: Int, val owedSixths: Int?, val withinOne: Boolean, val reason: String?)

public data class PlanResult(
    /** New edges the plan adds, in solve order. */
    val edges: List<Candidate>,
    val papers: List<PaperPlan>,
    val loads: Map<Long, Int>,
    val shortfalls: List<Shortfall>,
    val repairs: List<Repair>,
    val cyclesFirst: Int,
    /** Cycles still in the plan after the last round: reported, never silent (A3). */
    val cyclesLeft: List<PaperCycle>,
    val partitionLeft: List<Pair<Long, String>>,
    val bandViolations: List<Pair<Long, Int>>,
    val nominees: List<NomineeLoad>,
    val objective: Long,
    val candidateEdges: Int,
    val infeasible: Boolean,
    val weakMatches: List<Pair<Long, Int>>,
    /** Pinned edges the rules would not have allowed, shown so a chair can chase them. */
    val ineligiblePinned: List<Pin>,
) {
    public val composed: Int get() = papers.count { it.composed }
    public val seniorShort: Int get() = shortfalls.filter { it.slot == Slot.SENIOR }.sumOf { it.needed - it.filled }
    public val thirdShort: Int get() = shortfalls.filter { it.slot == Slot.THIRD }.sumOf { it.needed - it.filled }
}

public object Planner {
    private const val SENIOR_SEATS = 2

    public fun slotOf(c: PlanConfig, m: Member): Slot? =
        when {
            Pc.fillsSenior(c.q14, m) -> Slot.SENIOR
            Pc.fillsThird(c.q13, c.q14, m) -> Slot.THIRD
            else -> null
        }

    private fun cost(aff: Int): Long = ((100 - aff) / 5).toLong()

    private class Raw(val cand: Candidate, val slot: Slot)

    public fun solve(input: PlanInput, cfg: PlanConfig): PlanResult {
        val by = input.reviewers.associateBy { it.who }
        val paper = input.papers.associateBy { it.pid }
        val third = Pc.thirdSlots(cfg.q13)
        val thirdCap = Pc.thirdCap(cfg.q13)
        val pinned = input.pinned.filter { it.who in by && it.pid in paper }.distinct()
        val pinLoad = pinned.groupingBy { it.who }.eachCount()
        val pinSlot = pinned.groupBy { it.pid }.mapValues { (_, ps) -> ps.mapNotNull { slotOf(cfg, by.getValue(it.who).member) } }
        val ineligiblePinned = pinned.filter { !Pc.eligible(Faults.NONE, by.getValue(it.who).member, facts(paper.getValue(it.pid))) }

        // candidates the network may use: eligible (V1, A2), with a seat, not already pinned
        val pinSet = pinned.map { it.who to it.pid }.toSet()
        val pool = input.candidates.filter { it.who in by && it.pid in paper && (it.who to it.pid) !in pinSet }
        val eligible =
            pool.mapNotNull { c ->
                val r = by.getValue(c.who)
                if (!Pc.eligible(cfg.faults, r.member, facts(paper.getValue(c.pid)))) return@mapNotNull null
                slotOf(cfg, r.member)?.let { Raw(c, it) }
            }
        val forbidden = HashSet<Pair<Long, Long>>()
        val repairs = mutableListOf<Repair>()

        /** The seats of one paper in one solve: the capacity, and the lower bound the hard mode puts on it. */
        class Seat(val cap: Long, val low: Long = 0)

        /** One min-cost max-flow on the §10.5 network over [live] candidates, with each paper's senior and third seats from [seats]. */
        fun network(usable: List<Raw>, seats: (PlanPaper) -> Pair<Seat, Seat>): Pair<List<Raw>, Triple<Long, Boolean, Int>> {
            val node = HashMap<Long, Int>()
            for (r in input.reviewers) {
                val room = r.cap - (pinLoad[r.who] ?: 0)
                if (room > 0) node[r.who] = 2 + node.size
            }
            val nr = node.size
            val ppIndex = input.papers.withIndex().associate { it.value.pid to it.index }

            fun slotNode(pid: Long, s: Slot) = 2 + nr + 2 * ppIndex.getValue(pid) + if (s == Slot.SENIOR) 0 else 1
            val net = FlowNetwork(2 + nr + 2 * input.papers.size)
            for (r in input.reviewers) {
                val n = node[r.who] ?: continue
                val room = r.cap - (pinLoad[r.who] ?: 0)
                val nominee = r.member.nominee
                for (i in 0 until room) net.addArc(0, n, 1, if (nominee) 0 else 1L + i)
            }
            val first = net.arcs
            val live = usable.filter { it.cand.who in node }
            for (e in live) net.addArc(node.getValue(e.cand.who), slotNode(e.cand.pid, e.slot), 1, cost(e.cand.aff))
            for (p in input.papers) {
                val (sen, thd) = seats(p)
                // hard: the seat is a lower bound; a paper with no candidate for it makes the whole solve infeasible
                net.addArc(slotNode(p.pid, Slot.SENIOR), 1, sen.cap, 0, if (cfg.hard) sen.low else 0)
                net.addArc(slotNode(p.pid, Slot.THIRD), 1, thd.cap, 0, if (cfg.hard) thd.low else 0)
            }
            val res = net.solve(0, 1)
            val used = live.filterIndexed { j, _ -> res.flow[first + j] > 0 }
            return used to Triple(res.cost, res.feasible, live.size)
        }

        /** The seats the solve may fill (pinned juniors, reciprocal ones included, count toward the cap) and the ones it must. */
        fun seniorSeat(p: PlanPaper): Seat = maxOf(0, SENIOR_SEATS - pinSlot[p.pid].orEmpty().count { it == Slot.SENIOR }).toLong().let { Seat(it, it) }

        fun solveOnce(): Pair<List<Raw>, Triple<Long, Boolean, Int>> {
            val usable = prune(eligible.filter { (it.cand.who to it.cand.pid) !in forbidden }, cfg.topK)
            if (cfg.q13 != Q13.ZERO_TO_TWO_JUNIORS || cfg.juniorSeats == JuniorSeats.FILL) {
                val (used, meta) =
                    network(usable) { p ->
                        val thirds = pinSlot[p.pid].orEmpty().count { it == Slot.THIRD }
                        seniorSeat(p) to Seat(maxOf(0, thirdCap - thirds).toLong(), maxOf(0, third - thirds).toLong())
                    }
                return used to meta
            }
            // "zero to two juniors" with a chair's choice of who takes the optional seats: the seats are filled in stages, seniors first, each stage's
            // room read from what the earlier ones placed (`Pc.juniorRoom`; the model's `solveOnce`). Reviewers and seats of different stages don't overlap.
            val none = Seat(0)
            val (s1, m1) = network(usable.filter { it.slot == Slot.SENIOR }) { p -> seniorSeat(p) to none }
            val seniors = s1.groupingBy { it.cand.pid }.eachCount()

            fun seniorsOn(p: PlanPaper) = pinSlot[p.pid].orEmpty().count { it == Slot.SENIOR } + (seniors[p.pid] ?: 0)

            fun pinnedThirds(p: PlanPaper) = pinSlot[p.pid].orEmpty().count { it == Slot.THIRD }
            var cost = m1.first
            var feasible = m1.second
            var live = m1.third
            val used = s1.toMutableList()

            fun stage(pick: (Raw) -> Boolean, nominee: Boolean, placed: Map<Long, Int>): List<Raw> {
                val (u, m) =
                    network(usable.filter { it.slot == Slot.THIRD && pick(it) }) { p ->
                        none to Seat(Pc.juniorRoom(cfg.juniorSeats, nominee, thirdCap, seniorsOn(p), pinnedThirds(p) + (placed[p.pid] ?: 0)).toLong())
                    }
                used += u
                cost += m.first
                feasible = feasible && m.second
                live += m.third
                return u
            }
            if (cfg.juniorSeats == JuniorSeats.RECIPROCAL_ONLY) {
                val nominees = stage({ by.getValue(it.cand.who).member.nominee }, true, emptyMap())
                stage({ !by.getValue(it.cand.who).member.nominee }, false, nominees.groupingBy { it.cand.pid }.eachCount())
            } else {
                stage({ true }, false, emptyMap())
            }
            return used to Triple(cost, feasible, live)
        }

        var (used, meta) = solveOnce()
        val infeasible = !meta.second
        if (infeasible) {
            // report why from a soft solve; no plan comes of a hard one that can't be met
            val soft = solveSoft(input, cfg)
            return soft.copy(infeasible = true)
        }
        var cycles = Cycles.find(used.map { it.cand }, input.papers, pinned, cfg.cycleMaxK, cfg.faults)
        val cyclesFirst = cycles.size
        var partition = Partition.violations(used.map { it.cand }, pinned, by, cfg.maxPerInstitution)
        var round = 0
        while (round < cfg.repairRounds && (cycles.isNotEmpty() || partition.isNotEmpty())) {
            round++
            val before = forbidden.size
            for (cy in cycles) {
                val weak = weakest(cy.edges, used.map { it.cand }, forbidden) ?: continue
                if (forbidden.add(weak.who to weak.pid)) {
                    repairs +=
                        Repair(
                            weak.who,
                            weak.pid,
                            weak.aff,
                            round,
                            "reciprocal cycle of ${cy.papers.size} papers (${cy.papers.joinToString(" > ") {
                                "#$it"
                            }})",
                        )
                }
            }
            for ((pid, inst) in partition) {
                val group = used.map { it.cand }.filter { it.pid == pid && by.getValue(it.who).institution == inst }
                val weak = group.filter { (it.who to it.pid) !in forbidden }.minWithOrNull(compareBy<Candidate> { it.aff }.thenByDescending { it.who })
                if (weak != null && forbidden.add(weak.who to weak.pid)) {
                    repairs += Repair(weak.who, weak.pid, weak.aff, round, "more than ${cfg.maxPerInstitution} reviewers of #$pid from $inst")
                }
            }
            if (forbidden.size == before) break
            val next = solveOnce()
            used = next.first
            meta = next.second
            cycles = Cycles.find(used.map { it.cand }, input.papers, pinned, cfg.cycleMaxK, cfg.faults)
            partition = Partition.violations(used.map { it.cand }, pinned, by, cfg.maxPerInstitution)
        }
        return assess(
            input,
            cfg,
            by,
            pinned,
            ineligiblePinned,
            used.map {
                it.cand
            },
            eligible.map { it.cand },
            forbidden,
            repairs,
            cyclesFirst,
            cycles,
            partition,
            meta.first,
            meta.third,
            infeasible,
        )
    }

    /** The soft solve used only to explain an infeasible hard one. */
    private fun solveSoft(input: PlanInput, cfg: PlanConfig): PlanResult = solve(input, cfg.copy(hard = false))

    private fun facts(p: PlanPaper) = PaperFacts(p.authors, p.conflicts)

    /** The best [k] per paper and seat by affinity (ties by id, so the pruning is deterministic). */
    private fun prune(es: List<Raw>, k: Int): List<Raw> {
        val keep = HashSet<Raw>()
        for ((_, g) in es.groupBy { it.cand.pid to it.slot }) {
            if (g.size <= k) keep += g else keep += g.sortedWith(compareByDescending<Raw> { it.cand.aff }.thenBy { it.cand.who }).take(k)
        }
        return es.filter { it in keep }
    }

    /** The lowest-affinity edge of a cycle that a repair may forbid; ties go to the edge into the higher-numbered paper (the model's rule). */
    private fun weakest(edges: List<Pair<Long, Long>>, plan: List<Candidate>, forbidden: Set<Pair<Long, Long>>): Candidate? =
        edges.mapNotNull { e -> plan.firstOrNull { it.who == e.first && it.pid == e.second } }
            .filter { (it.who to it.pid) !in forbidden }
            .minWithOrNull(compareBy<Candidate> { it.aff }.thenByDescending { it.pid }.thenByDescending { it.who })

    private fun assess(
        input: PlanInput,
        cfg: PlanConfig,
        by: Map<Long, Reviewer>,
        pinned: List<Pin>,
        ineligiblePinned: List<Pin>,
        plan: List<Candidate>,
        eligible: List<Candidate>,
        forbidden: Set<Pair<Long, Long>>,
        repairs: List<Repair>,
        cyclesFirst: Int,
        cycles: List<PaperCycle>,
        partition: List<Pair<Long, String>>,
        objective: Long,
        candidateEdges: Int,
        infeasible: Boolean,
    ): PlanResult {
        val third = Pc.thirdSlots(cfg.q13)
        val seatsOf = HashMap<Long, MutableList<Long>>()
        for (p in pinned) seatsOf.getOrPut(p.pid) { mutableListOf() } += p.who
        for (e in plan) seatsOf.getOrPut(e.pid) { mutableListOf() } += e.who
        val loads = HashMap<Long, Int>()
        for (who in seatsOf.values.flatten()) loads.merge(who, 1, Int::plus)
        val papers =
            input.papers.map { p ->
                val ws = seatsOf[p.pid].orEmpty()
                val members = ws.map { by.getValue(it).member }
                PaperPlan(
                    p.pid,
                    ws.filter { Pc.fillsSenior(cfg.q14, by.getValue(it).member) },
                    ws.filter { slotOf(cfg, by.getValue(it).member) == Slot.THIRD },
                    ws.filter { slotOf(cfg, by.getValue(it).member) == null },
                    Pc.compositionOk(cfg.q13, cfg.q14, members),
                )
            }
        val short = mutableListOf<Shortfall>()
        // the candidates and the papers, indexed once: a scan per paper is quadratic, which at 4,000 papers and 240,000 edges is most of the solve (M19)
        val paperOf = input.papers.associateBy { it.pid }
        val candsOf = input.candidates.filter { it.who in by }.groupBy { it.pid }
        for (pp in papers) {
            val p = paperOf.getValue(pp.pid)
            for ((slot, need, got) in listOf(Triple(Slot.SENIOR, SENIOR_SEATS, pp.seniors.size), Triple(Slot.THIRD, third, pp.thirds.size))) {
                if (got >= need) continue
                short += Shortfall(pp.pid, slot, need, got, reason(cfg, by, p, slot, need, got, candsOf[p.pid].orEmpty(), forbidden, loads))
            }
        }
        // a paper whose seats are all filled can still miss Q13 and Q14, through existing assignments the rules would not have made
        for (pp in papers.filter { !it.composed && short.none { s -> s.pid == it.pid } }) {
            short +=
                Shortfall(
                    pp.pid,
                    Slot.SENIOR,
                    pp.seniors.size,
                    pp.seniors.size,
                    "the reviewers don't fit Q13 and Q14: ${pp.seniors.size} in senior seats, ${pp.thirds.size} in the other seats, ${pp.neither.size} with no seat (existing assignments are never moved)",
                )
        }
        val violations = input.reviewers.filter { (loads[it.who] ?: 0) > it.cap }.map { it.who to (loads[it.who] ?: 0) }
        val eligibleCount by lazy { eligible.filter { (it.who to it.pid) !in forbidden }.groupingBy { it.who }.eachCount().withDefault { 0 } }
        val nominees =
            input.reviewers.filter { it.member.nominee && it.member.accepted }.map { r ->
                val load = loads[r.who] ?: 0
                val owed = r.owedSixths
                // within one review of what they owe (rounded up), or the report says why (V5)
                val target = if (owed == null) r.cap else minOf(r.cap, (owed + 5) / 6)
                val ok = load + 1 >= target
                val why =
                    if (ok) {
                        null
                    } else {
                        val cands = eligibleCount.getValue(r.who)
                        when {
                            cands < target -> "only $cands eligible candidate papers for ${r.who}"
                            else -> "the seats on its candidate papers were taken by others"
                        }
                    }
                NomineeLoad(r.who, load, r.cap, owed, ok, why)
            }
        val weak =
            input.papers.mapNotNull { p ->
                val best = candsOf[p.pid]?.maxOfOrNull { it.aff } ?: return@mapNotNull null
                if (best < cfg.weakAffinity) p.pid to best else null
            }
        return PlanResult(
            plan,
            papers,
            loads,
            short,
            repairs,
            cyclesFirst,
            cycles,
            partition,
            violations,
            nominees,
            objective,
            candidateEdges,
            infeasible,
            weak,
            ineligiblePinned,
        )
    }

    private fun reason(
        cfg: PlanConfig,
        by: Map<Long, Reviewer>,
        p: PlanPaper,
        slot: Slot,
        need: Int,
        got: Int,
        raw: List<Candidate>,
        forbidden: Set<Pair<Long, Long>>,
        loads: Map<Long, Int>,
    ): String {
        val label = if (slot == Slot.SENIOR) "senior" else "non-senior"
        val ofSlot = raw.filter { by.getValue(it.who).member.let { m -> slotOf(cfg, m) } == slot }
        val unseated = raw.filter { slotOf(cfg, by.getValue(it.who).member) == null }
        val facts = facts(p)
        val bad = ofSlot.filter { !Pc.eligible(cfg.faults, by.getValue(it.who).member, facts) }
        val why = mutableMapOf<String, Int>()
        for (c in bad) {
            val m = by.getValue(c.who).member
            val k =
                when {
                    c.who in p.authors -> "an author"
                    c.who in p.conflicts -> "conflicted"
                    !m.accepted -> "not accepted"
                    !m.consented -> "not consented"
                    else -> "not classified"
                }
            why.merge(k, 1, Int::plus)
        }
        val ok = ofSlot.size - bad.size
        val forb = ofSlot.count { (it.who to it.pid) in forbidden }
        val full =
            ofSlot.count {
                Pc.eligible(cfg.faults, by.getValue(it.who).member, facts) &&
                    (it.who to it.pid) !in forbidden &&
                    (loads[it.who] ?: 0) >= by.getValue(it.who).cap
            }
        val parts = mutableListOf<String>()
        parts += "$label seats: $got of $need filled"
        parts += if (ofSlot.isEmpty()) "no $label candidates have any affinity data for it" else "${ofSlot.size} $label candidates, $ok eligible"
        if (why.isNotEmpty()) parts += why.entries.joinToString(", ") { "${it.value} ${it.key}" } + " excluded"
        if (forb > 0) parts += "$forb forbidden by cycle repair"
        if (ok > 0 && forb < ok) parts += "$full of the eligible are at their load band"
        if (unseated.isNotEmpty() && ofSlot.isEmpty()) parts += "${unseated.size} candidates have no seat under Q13 and Q14"
        return parts.joinToString("; ")
    }

    /** Test and audit helper: is [plan]'s every edge to an eligible reviewer, by the signed rules? Returns the violations. */
    public fun audit(input: PlanInput, cfg: PlanConfig, plan: PlanResult): List<String> {
        val by = input.reviewers.associateBy { it.who }
        val paper = input.papers.associateBy { it.pid }
        val out = mutableListOf<String>()
        for (e in plan.edges) {
            val r =
                by[e.who] ?: run {
                    out += "V1: ${e.who} is not a known reviewer"
                    continue
                }
            val p = paper.getValue(e.pid)
            if (!Pc.eligible(Faults.NONE, r.member, facts(p))) out += "V1/A2: ${e.who} is not eligible for #${e.pid}"
            if (slotOf(cfg.copy(faults = Faults.NONE), r.member) == null) out += "Q13/Q14: ${e.who} has no seat on #${e.pid}"
        }
        for ((who, load) in plan.loads) {
            val r = by[who] ?: continue
            if (load > r.cap && (who to load) !in plan.bandViolations) out += "A4: $who load $load exceeds band ${r.cap} and is not reported"
        }
        val noCycle =
            Cycles.find(
                plan.edges +
                    input.pinned.map {
                        Candidate(it.who, it.pid, 100)
                    },
                input.papers,
                emptyList(),
                cfg.cycleMaxK.coerceAtLeast(2),
                Faults.NONE,
            )
        for (cy in noCycle) if (plan.cyclesLeft.none { it.papers.toSet() == cy.papers.toSet() }) out += "A3: unreported cycle ${cy.papers}"
        for (pp in plan.papers) {
            if (!pp.composed && plan.shortfalls.none { it.pid == pp.pid }) out += "A1: #${pp.pid} is not composed and has no reason"
        }
        // the chair's choice of who takes the optional seats (Q13 "zero to two juniors"): what the plan added never exceeds the room that choice leaves
        if (cfg.q13 == Q13.ZERO_TO_TWO_JUNIORS && cfg.juniorSeats != JuniorSeats.FILL) {
            val cap = Pc.thirdCap(cfg.q13)
            val planned = plan.edges.filter { by[it.who]?.let { r -> slotOf(cfg, r.member) } == Slot.THIRD }.groupBy { it.pid }
            for (pp in plan.papers) {
                val added = planned[pp.pid].orEmpty()
                val nominees = added.count { by.getValue(it.who).member.nominee }
                val pc = added.size - nominees
                val before = pp.thirds.size - added.size
                val seniors = pp.seniors.size
                val roomN = if (cfg.juniorSeats == JuniorSeats.RECIPROCAL_ONLY) Pc.juniorRoom(cfg.juniorSeats, true, cap, seniors, before) else Int.MAX_VALUE
                val roomAll = Pc.juniorRoom(cfg.juniorSeats, false, cap, seniors, before)
                val roomPc =
                    if (cfg.juniorSeats ==
                        JuniorSeats.RECIPROCAL_ONLY
                    ) {
                        Pc.juniorRoom(cfg.juniorSeats, false, cap, seniors, before + nominees)
                    } else {
                        roomAll
                    }
                if (nominees > roomN ||
                    (cfg.juniorSeats == JuniorSeats.RECIPROCAL_ONLY && pc > roomPc) ||
                    (cfg.juniorSeats == JuniorSeats.WHEN_SHORT && added.size > roomAll)
                ) {
                    out +=
                        "junior seats (${cfg.juniorSeats.key}): #${pp.pid} was given $nominees reciprocal and $pc PC juniors with $seniors seniors and $before juniors before"
                }
            }
        }
        return out
    }
}

/** Reciprocal and longer cycles in a plan (spec §10.5; concepts rule `cycle-free`, A3). */
public object Cycles {
    private const val MAX_COMBOS = 64

    /**
     * Cycles of 2 to [maxK] papers. A paper A points to B when an author of A reviews B; a cycle is a ring of distinct
     * papers. Each [PaperCycle] lists the review edges that make its hops, one witness per hop (every combination is its own cycle,
     * so breaking one witness of a hop doesn't hide the other). Pinned edges count as reviews but are never forbidden.
     * With the "cycle K = 1" fault nothing is checked (model mutant 9).
     */
    public fun find(plan: List<Candidate>, papers: List<PlanPaper>, pinned: List<Pin>, maxK: Int, faults: Faults = Faults.NONE): List<PaperCycle> {
        val k = if (faults.cycleK1) 1 else maxK
        if (k < 2) return emptyList()
        val authors = papers.associate { it.pid to it.authors.toSet() }
        val edges = plan.map { it.who to it.pid } + pinned.map { it.who to it.pid }
        val reviewsOf = edges.groupBy({ it.second }, { it.first })
        // hop A -> B: witnesses (u, B) with u an author of A
        val hop = HashMap<Pair<Long, Long>, List<Pair<Long, Long>>>()
        val next = HashMap<Long, MutableList<Long>>()
        // through an index of who wrote what, so the work follows the reviews, not the pairs of papers (4,000 papers are 16 million pairs)
        val authoredBy = HashMap<Long, MutableList<Long>>()
        for (a in papers) for (u in a.authors.toSet()) authoredBy.getOrPut(u) { mutableListOf() } += a.pid
        for (b in papers) {
            val witnesses = HashMap<Long, MutableList<Pair<Long, Long>>>()
            for (u in reviewsOf[b.pid].orEmpty().distinct()) {
                for (a in authoredBy[u].orEmpty()) if (a != b.pid) witnesses.getOrPut(a) { mutableListOf() } += u to b.pid
            }
            for ((a, w) in witnesses) {
                hop[a to b.pid] = w
                next.getOrPut(a) { mutableListOf() } += b.pid
            }
        }
        val out = mutableListOf<PaperCycle>()

        fun dfs(start: Long, cur: Long, path: List<Long>) {
            for (n in next[cur].orEmpty()) {
                if (n == start && path.size >= 2) {
                    var combos: List<List<Pair<Long, Long>>> = listOf(emptyList())
                    val ring = path + start
                    for (i in 0 until path.size) {
                        val w = hop.getValue(ring[i] to ring[i + 1])
                        combos = combos.flatMap { c -> w.map { c + it } }.take(MAX_COMBOS)
                    }
                    combos.forEach { out += PaperCycle(path, it) }
                } else if (n > start && n !in path && path.size < k) {
                    dfs(start, n, path + n)
                }
            }
        }
        for (a in papers.map { it.pid }.sorted()) dfs(a, a, listOf(a))
        return out
    }
}

/** The second partition: at most [max] reviewers of a paper from one institution. */
public object Partition {
    public fun violations(plan: List<Candidate>, pinned: List<Pin>, by: Map<Long, Reviewer>, max: Int?): List<Pair<Long, String>> {
        if (max == null) return emptyList()
        val all = plan.map { it.who to it.pid } + pinned.map { it.who to it.pid }
        return all.mapNotNull { (w, pid) -> by[w]?.institution?.let { pid to it } }.groupingBy { it }.eachCount().filter { it.value > max }.keys.toList()
    }
}

/** The tiers a plan's reviewers have, for the load histogram. */
public fun Reviewer.tier(): Tier? = member.tier
