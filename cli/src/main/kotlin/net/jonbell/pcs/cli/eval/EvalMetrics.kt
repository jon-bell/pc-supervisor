package net.jonbell.pcs.cli.eval

import kotlinx.serialization.json.JsonPrimitive
import net.jonbell.pcs.core.assignment.Candidate
import net.jonbell.pcs.core.assignment.PlanConfig
import net.jonbell.pcs.core.assignment.PlanInput
import net.jonbell.pcs.core.assignment.PlanPaper
import net.jonbell.pcs.core.assignment.Planner
import net.jonbell.pcs.core.assignment.Reviewer
import net.jonbell.pcs.core.hotcrp.PaperRecord
import net.jonbell.pcs.core.hotcrp.Review
import net.jonbell.pcs.core.readings.Q13
import net.jonbell.pcs.core.readings.Q14
import net.jonbell.pcs.core.readings.Q15
import net.jonbell.pcs.core.rules.EarlyReject
import net.jonbell.pcs.core.rules.Member
import net.jonbell.pcs.core.rules.ScoreScale
import net.jonbell.pcs.core.rules.Tier

/** The numbers of the kit's report before any disclosure rule is applied. These never leave the process; [EvalReport] renders them under [Disclosure]. */
data class CheckRow(val check: String, val flagged: Int, val flaggedDesk: Int)

data class ChecksResult(
    val papersWithPdf: Int,
    val deskRejectedWithPdf: Int,
    val perCheck: List<CheckRow>,
    val any: Confusion,
    /** Total USD over every paper screened, and the calls made. */
    val costUsd: java.math.BigDecimal,
    val calls: Int,
)

data class TpmsResult(
    val pcMembers: Int,
    val pcWithProfile: Int,
    val papers: Int,
    val papersCovered: Int,
    val malformedRows: Int,
    val usableMin: Double,
    val needed: Int,
)

data class CompositionRow(val q13: Q13, val planned: Int, val composed: Int, val seniorShort: Int, val thirdShort: Int)

data class CompositionResult(val reviewers: Int, val juniors: Int, val planned: Int, val rows: List<CompositionRow>)

data class EarlyRejectRow(val q15: Q15, val candidates: Int, val candidatesRejected: Int)

data class EarlyRejectResult(val reviewed: Int, val rows: List<EarlyRejectRow>)

/** What the kit computes from a venue's own data (PLAN M21). Every function is deterministic: sorted inputs, no clock, no randomness. */
object EvalMetrics {
    /** A paper the recorded outcome says was desk rejected: its decision text contains [match] (the chair's HotCRP names the decision). */
    fun deskRejected(p: PaperRecord, match: String): Boolean = p.decision?.lowercase()?.contains(match.lowercase()) == true

    fun withdrawn(p: PaperRecord): Boolean = p.status?.lowercase() == "withdrawn" || p.status?.lowercase() == "draft"

    fun rejected(p: PaperRecord): Boolean = p.decision?.lowercase()?.contains("reject") == true

    /** Papers that went to reviewers: not withdrawn, not a draft, not desk rejected. */
    fun reviewed(papers: List<PaperRecord>, deskMatch: String): List<PaperRecord> = papers.filter { !withdrawn(it) && !deskRejected(it, deskMatch) }

    fun tpms(input: EvalInput, tpms: TpmsData, reviewsRequired: Int, usableMin: Double, deskMatch: String): TpmsResult {
        val pc = input.pc.map { it.email.lowercase() }.toSortedSet()
        val scored = tpms.scores.keys.map { it.second }.toSet() + tpms.registered
        val papers = reviewed(input.papers, deskMatch)
        val covered =
            papers.count { p ->
                val conflicts = p.pcConflicts.keys.map { it.lowercase() }.toSet()
                val authors = p.authors.map { it.lowercase() }.toSet()
                pc.count { e -> e !in conflicts && e !in authors && (tpms.scores[p.pid to e] ?: -1.0) >= usableMin } >= reviewsRequired
            }
        return TpmsResult(pc.size, pc.count { it in scored }, papers.size, covered, tpms.malformedRows, usableMin, reviewsRequired)
    }

    /**
     * The assignment solver on the venue's real conflicts: every PC member who is not a conflict or an author of a paper is a candidate for it at one
     * flat affinity, so what limits the plan is conflicts, tiers and load bands alone. Tiers come from the tier tags (`PCS_TIER_TAGS`); a PC
     * member with neither tag counts as senior. One solve per reading of Q13, with Q14 "tier decides"; existing assignments are not read.
     */
    fun composition(input: EvalInput, tierTags: Map<String, String>, loadMax: Map<String, Int>, deskMatch: String, topK: Int = 25): CompositionResult {
        val pc = input.pc.sortedBy { it.email.lowercase() }
        val junior = tierTags["junior"]?.lowercase()
        val id = pc.withIndex().associate { it.value.email.lowercase() to it.index + 1L }
        val reviewers =
            pc.map { m ->
                val tier = if (junior != null && m.tags.any { it.lowercase() == junior }) Tier.JUNIOR else Tier.SENIOR
                Reviewer(Member(id.getValue(m.email.lowercase()), tier), loadMax[tier.name.lowercase()] ?: 15)
            }
        val papers =
            reviewed(input.papers, deskMatch).sortedBy { it.pid }.map { p ->
                PlanPaper(
                    p.pid,
                    p.authors.mapNotNull { id[it.lowercase()] },
                    p.pcConflicts.keys.mapNotNull { id[it.lowercase()] },
                )
            }
        val candidates =
            papers.flatMap { p ->
                reviewers.filter { it.who !in p.conflicts && it.who !in p.authors }.map { Candidate(it.who, p.pid, FLAT_AFFINITY) }
            }
        val plan = PlanInput(reviewers, papers, candidates)
        val rows =
            Q13.entries.map { q ->
                val r = Planner.solve(plan, PlanConfig(q, Q14.TIER_DECIDES, topK = topK))
                CompositionRow(q, papers.size, r.composed, r.seniorShort, r.thirdShort)
            }
        return CompositionResult(reviewers.size, reviewers.count { it.member.tier == Tier.JUNIOR }, papers.size, rows)
    }

    /**
     * The early-reject rate under each Q15 reading: of the papers that went to review, how many have at least [reviewsRequired] complete reviews, all
     * negative (every merit value on the score scale and negative under the reading). This reads the final scores, not the snapshot
     * at a window's opening, so it is the rate at which the rule would have had a candidate at all; a score changed during review is not modelled.
     */
    fun earlyReject(
        input: EvalInput,
        scale: ScoreScale,
        meritField: String,
        reviewsRequired: Int,
        deskMatch: String,
    ): EarlyRejectResult {
        val byPaper = input.reviews.filter { initial(it) }.groupBy { it.pid }
        val reviewed = reviewed(input.papers, deskMatch)
        val rows =
            Q15.entries.map { q ->
                val cand =
                    reviewed.filter { p ->
                        val rs = byPaper[p.pid].orEmpty()
                        val ss = rs.map { scale.of(merit(it, meritField)) }
                        rs.size >= reviewsRequired && ss.none { it == null } && ss.all { s -> EarlyReject.negative(q, s!!) }
                    }
                EarlyRejectRow(q, cand.size, cand.count { rejected(it) })
            }
        return EarlyRejectResult(reviewed.size, rows)
    }

    /** An initial review: a complete review that is not the AC's metareview (rtype 5) and not in the screening round. */
    private fun initial(r: Review): Boolean = r.status == "complete" && r.rtype in 1..4 && r.round != "screen"

    private fun merit(r: Review, field: String): Int? = (r.fields[field] as? JsonPrimitive)?.content?.toIntOrNull()

    /** The recorded outcome against the checks: [flagged] are the pids any check flagged, among [screened]. */
    fun confusion(screened: Set<Long>, flagged: Set<Long>, desk: Set<Long>): Confusion {
        val tp = flagged.count { it in desk }
        return Confusion(tp, flagged.size - tp, desk.count { it in screened } - tp)
    }

    const val FLAT_AFFINITY = 50
}
