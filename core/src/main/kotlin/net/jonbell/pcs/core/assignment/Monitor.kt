package net.jonbell.pcs.core.assignment

import net.jonbell.pcs.core.rules.PaperFacts
import net.jonbell.pcs.core.rules.Pc
import kotlin.math.sqrt

/**
 * Conflict engineering (monitor M3, concepts §3.10, spec §10.4 C): a paper whose declared conflicts exclude an unusual
 * share of the qualified reviewers in its area is reported to the PC chairs. It is a collusion signal, never a ground:
 * nothing here removes, refers or reassigns anything, and the plan treats the conflicts as the facts they are.
 *
 * "Qualified" means a reviewer the rules would otherwise accept (accepted, consented, classified) whose affinity for the paper is
 * at least [MonitorConfig.qualifiedAffinity]: the affinity data is what says whom the paper's area contains. A paper is
 * flagged when it loses at least [MonitorConfig.minExcluded] qualified reviewers, at least [MonitorConfig.minShare]
 * of them, and a share more than [MonitorConfig.sigma] standard deviations above the mean over all papers.
 */
public data class MonitorConfig(val qualifiedAffinity: Int = 50, val minShare: Double = 0.5, val minExcluded: Int = 3, val sigma: Double = 2.0)

public data class ConflictSignal(val pid: Long, val qualified: Int, val excluded: Int, val share: Double, val threshold: Double)

public object ConflictMonitor {
    public fun scan(input: PlanInput, cfg: MonitorConfig = MonitorConfig()): List<ConflictSignal> {
        val by = input.reviewers.associateBy { it.who }
        val aff = input.candidates.groupBy { it.pid }
        val rows =
            input.papers.map { p ->
                val q =
                    aff[p.pid].orEmpty().filter { c ->
                        val m = by[c.who]?.member
                        m != null && m.tier != null && m.accepted && m.consented && c.who !in p.authors && c.aff >= cfg.qualifiedAffinity
                    }.map { it.who }.distinct()
                Triple(p.pid, q.size, q.count { it in p.conflicts })
            }
        val shares = rows.filter { it.second > 0 }.map { it.third.toDouble() / it.second }
        val mean = if (shares.isEmpty()) 0.0 else shares.average()
        val sd = if (shares.size < 2) 0.0 else sqrt(shares.sumOf { (it - mean) * (it - mean) } / shares.size)
        val threshold = maxOf(cfg.minShare, mean + cfg.sigma * sd)
        return rows.filter { it.second > 0 }.mapNotNull { (pid, q, x) ->
            val share = x.toDouble() / q
            if (x >= cfg.minExcluded && share >= threshold) ConflictSignal(pid, q, x, share, threshold) else null
        }
    }
}

/** What validating a TPMS assignment found about one imported edge. */
public data class TpmsIssue(val who: Long, val pid: Long, val problem: String)

public data class TpmsValidation(
    val imported: Int,
    val issues: List<TpmsIssue>,
    /** Papers that would have a composition gap if the import were applied as it is. */
    val compositionGaps: List<Pair<Long, String>>,
    val corrected: PlanResult,
    val kept: List<Pair<Long, Long>>,
    val dropped: List<Pair<Long, Long>>,
    val added: List<Pair<Long, Long>>,
)

/**
 * The TPMS round trip (spec §10.4 C): validate an imported TPMS assignment *before* it reaches HotCRP, and produce a corrected
 * plan. TPMS maximizes affinity under per-reviewer load only, so it assigns authors, conflicts and unaccepted nominees, breaks tier
 * composition, and makes reciprocal cycles. Every imported edge the rules allow is kept when the corrected solve can keep it (its affinity is
 * raised to the top of the scale, which makes it the cheapest), and everything else is solved around it.
 */
public object TpmsRoundTrip {
    public fun validate(imported: List<Pin>, input: PlanInput, cfg: PlanConfig): TpmsValidation {
        val by = input.reviewers.associateBy { it.who }
        val paper = input.papers.associateBy { it.pid }
        val issues = mutableListOf<TpmsIssue>()
        val valid = mutableListOf<Pin>()
        for (e in imported.distinct()) {
            val r = by[e.who]
            val p = paper[e.pid]
            val problem =
                when {
                    r == null -> "not a known person"
                    p == null -> "not a paper in review"
                    e.who in p.authors -> "an author of the paper (A2)"
                    e.who in p.conflicts -> "declared conflict (A2)"
                    !Pc.eligible(cfg.faults, r.member, factsOf(p)) -> "not accepted, consented and classified by an AC (V1)"
                    Planner.slotOf(cfg, r.member) == null -> "no seat for their tier under Q13 and Q14"
                    else -> null
                }
            if (problem != null) issues += TpmsIssue(e.who, e.pid, problem) else valid += e
        }
        // loads over a band: the lowest-affinity edges of a reviewer past their band are dropped
        val aff = input.candidates.associate { (it.who to it.pid) to it.aff }
        val keep = mutableListOf<Pin>()
        for ((who, es) in valid.groupBy { it.who }) {
            val cap = by.getValue(who).cap
            val ranked = es.sortedWith(compareByDescending<Pin> { aff[it.who to it.pid] ?: 0 }.thenBy { it.pid })
            keep += ranked.take(cap)
            ranked.drop(cap).forEach { issues += TpmsIssue(it.who, it.pid, "past their load band of $cap (A4)") }
        }
        val gaps = mutableListOf<Pair<Long, String>>()
        for (p in input.papers) {
            val ms = keep.filter { it.pid == p.pid }.map { by.getValue(it.who).member }
            if (!Pc.compositionOk(cfg.q13, cfg.q14, ms)) {
                val sen = ms.count { Pc.fillsSenior(cfg.q14, it) }
                gaps += p.pid to "$sen senior and ${ms.size - sen} other reviewers; composition needs two seniors and Q13's seats"
            }
        }
        for (cy in Cycles.find(keep.map { Candidate(it.who, it.pid, 100) }, input.papers, emptyList(), cfg.cycleMaxK, cfg.faults)) {
            issues +=
                TpmsIssue(cy.edges.first().first, cy.edges.first().second, "in a reciprocal cycle of papers ${cy.papers.joinToString(" > ") { "#$it" }} (A3)")
        }
        val warm = keep.map { Candidate(it.who, it.pid, 100) }
        val have = warm.map { it.who to it.pid }.toSet()
        val corrected = Planner.solve(input.copy(candidates = warm + input.candidates.filter { (it.who to it.pid) !in have }), cfg)
        val result = corrected.edges.map { it.who to it.pid }
        val importedSet = imported.map { it.who to it.pid }.toSet()
        return TpmsValidation(
            imported.distinct().size,
            issues,
            gaps,
            corrected,
            result.filter { it in importedSet },
            importedSet.filter { it !in result.toSet() },
            result.filter { it !in importedSet },
        )
    }

    private fun factsOf(p: PlanPaper) = PaperFacts(p.authors, p.conflicts)
}
