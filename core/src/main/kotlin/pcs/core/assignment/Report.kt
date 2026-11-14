package pcs.core.assignment

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import pcs.core.rules.Tier
import pcs.core.writeback.AssignmentArtifact

/*
 * What the plan hands the chairs (spec §10.5 Outputs): a HotCRP bulk-assign CSV, always applied by a chair through
 * Writeback with a dry run first, and a solve report. Both are data; nothing here touches HotCRP.
 */

/** The bulk-assign CSV (`paper,action,email[,round]`): seniors first, then the third slot, a paper at a time. */
public data class AssignCsv(val rows: List<Map<String, String>>, val awaitingMembership: List<Pair<Long, String>>, val round: String?) {
    public fun toCsv(): String {
        val cols = listOf("paper", "action", "email") + if (round != null) listOf("round") else emptyList()
        return cols.joinToString(",") + "\n" + rows.joinToString("") { r -> cols.joinToString(",") { csv(r[it].orEmpty()) } + "\n" }
    }

    /** The artifact Writeback drafts, dry-runs, and applies. */
    public fun toArtifact(label: String = "Assignment plan"): AssignmentArtifact = AssignmentArtifact(rows, label)

    private fun csv(s: String) = if (s.any { it == ',' || it == '"' || it == '\n' }) "\"" + s.replace("\"", "\"\"") + "\"" else s
}

public object AssignmentOutput {
    /**
     * Rows for the plan's new edges. A senior-slot reviewer is assigned as `primary` and a third-slot reviewer as `secondary`; both are
     * ordinary PC reviews. Reviewers not yet on the HotCRP PC are listed, not assigned: HotCRP would refuse them.
     */
    public fun csv(plan: PlanResult, b: AssignmentBuild): AssignCsv {
        val by = b.input.reviewers.associateBy { it.who }
        val round = b.settings.round
        val rows = mutableListOf<Map<String, String>>()
        val waiting = mutableListOf<Pair<Long, String>>()
        val edges = plan.edges.groupBy { it.pid }
        for (pid in edges.keys.sorted()) {
            val es = edges.getValue(pid)
            val seniors = es.filter { Planner.slotOf(b.config, by.getValue(it.who).member) == Slot.SENIOR }.sortedBy { b.email(it.who) }
            val others = es.filter { it !in seniors }.sortedBy { b.email(it.who) }
            for ((slot, group) in listOf(Slot.SENIOR to seniors, Slot.THIRD to others)) {
                for (e in group) {
                    if (!by.getValue(e.who).onPc) {
                        waiting += pid to b.email(e.who)
                        continue
                    }
                    val row = mutableMapOf("paper" to pid.toString(), "action" to if (slot == Slot.SENIOR) "primary" else "secondary", "email" to b.email(e.who))
                    if (round != null) row["round"] = round
                    rows += row
                }
            }
        }
        return AssignCsv(rows, waiting, round)
    }
}

/** The solve report (spec §10.5): composition, shortfalls with reasons, load histograms, repairs, and the checks on the plan itself. */
public class SolveReport(
    public val plan: PlanResult,
    public val build: AssignmentBuild,
    public val signals: List<ConflictSignal>,
    /** What the independent audit found wrong with the plan; empty is the point. */
    public val audit: List<String>,
    public val tpms: TpmsValidation?,
    public val csv: AssignCsv,
) {
    /** Histogram of loads by tier: load -> number of reviewers. */
    public val loadByTier: Map<String, Map<Int, Int>>
        get() =
            build.input.reviewers.groupBy { it.member.tier?.name?.lowercase() ?: "unclassified" }.mapValues { (_, rs) ->
                rs.groupingBy { plan.loads[it.who] ?: 0 }.eachCount().toSortedMap()
            }.toSortedMap()

    public val papers: Int get() = build.input.papers.size

    public fun toJson(): JsonObject =
        buildJsonObject {
            put("composed", plan.composed)
            put("papers", papers)
            put("seniorShort", plan.seniorShort)
            put("thirdShort", plan.thirdShort)
            put("objective", plan.objective)
            put("repairs", plan.repairs.size)
            put("cyclesFirst", plan.cyclesFirst)
            put("cyclesLeft", plan.cyclesLeft.size)
            put("bandViolations", plan.bandViolations.size)
            put("audit", JsonArray(audit.map { kotlinx.serialization.json.JsonPrimitive(it) }))
        }

    public fun render(): String =
        buildString {
            appendLine("# Assignment plan")
            appendLine("composed ${plan.composed} of $papers papers; senior seats unfilled ${plan.seniorShort}; other seats unfilled ${plan.thirdShort}; objective ${plan.objective}; ${plan.candidateEdges} candidate edges")
            appendLine("affinity sources: ${build.sources.entries.joinToString { "${it.key} (${it.value} edges)" }.ifEmpty { "none" }}")
            if (plan.infeasible) appendLine("HARD MODE: the lower bounds can't be met; the plan below is the soft solve, shown to explain why")
            appendLine("## Papers that don't meet their composition")
            val short = plan.shortfalls.sortedWith(compareBy({ it.pid }, { it.slot }))
            if (short.isEmpty()) appendLine("none")
            short.forEach { appendLine("#${it.pid}: ${it.reason}") }
            appendLine("## Load by tier (reviews: reviewers)")
            loadByTier.forEach { (t, h) -> appendLine("$t: ${h.entries.joinToString(", ") { "${it.key}: ${it.value}" }}") }
            if (plan.bandViolations.isEmpty()) appendLine("no band exceeded") else plan.bandViolations.forEach { appendLine("OVER BAND: ${build.email(it.first)} has ${it.second} reviews (existing reviews count)") }
            appendLine("## Nominees against what they owe")
            if (plan.nominees.isEmpty()) appendLine("no accepted nominees")
            plan.nominees.forEach { n ->
                appendLine(
                    "${build.email(n.who)}: ${n.load} planned of ${n.owedSixths?.let { pcs.core.rules.Nominations.showSixths(it) } ?: "a pooled share"} owed (band ${n.cap})" +
                        (n.reason?.let { "; more than one review short: $it" } ?: ""),
                )
            }
            appendLine("## Repairs")
            if (plan.repairs.isEmpty()) appendLine("none: ${plan.cyclesFirst} cycles in the first solve")
            plan.repairs.forEach { appendLine("round ${it.round}: forbade ${build.email(it.who)} on #${it.pid} (affinity ${it.aff}): ${it.reason}") }
            plan.cyclesLeft.forEach { appendLine("STILL IN THE PLAN: cycle ${it.papers.joinToString(" > ") { p -> "#$p" }}") }
            if (plan.ineligiblePinned.isNotEmpty()) {
                appendLine("## Existing assignments the rules would not allow")
                plan.ineligiblePinned.forEach { appendLine("${build.email(it.who)} on #${it.pid}") }
            }
            appendLine("## Weak matches (best affinity below the threshold)")
            if (plan.weakMatches.isEmpty()) appendLine("none") else plan.weakMatches.forEach { appendLine("#${it.first}: best affinity ${it.second}") }
            appendLine("## Conflict engineering (for the PC chairs; never a ground)")
            if (signals.isEmpty()) appendLine("none") else signals.forEach { appendLine("#${it.pid}: declared conflicts exclude ${it.excluded} of ${it.qualified} qualified reviewers (${(it.share * 100).toInt()}%, threshold ${(it.threshold * 100).toInt()}%)") }
            tpms?.let { t ->
                appendLine("## TPMS round trip")
                appendLine("${t.imported} imported edges; ${t.issues.size} problems; kept ${t.kept.size}, dropped ${t.dropped.size}, added ${t.added.size}")
                t.issues.forEach { appendLine("${build.email(it.who)} on #${it.pid}: ${it.problem}") }
                t.compositionGaps.forEach { appendLine("#${it.first}: ${it.second}") }
            }
            appendLine("## CSV")
            appendLine("${csv.rows.size} rows" + if (csv.awaitingMembership.isNotEmpty()) "; ${csv.awaitingMembership.size} edges wait for a PC membership (not in the CSV)" else "")
            appendLine("## Audit")
            if (audit.isEmpty()) appendLine("every edge is to an eligible reviewer (V1, A2), every band is respected or reported (A4), every cycle is repaired or reported (A3), every paper meets its composition or has a reason (A1)") else audit.forEach { appendLine("VIOLATION: $it") }
        }
}

/** The whole pipeline from the mirror: build, solve, check, and write. */
public object Assignment {
    public fun report(b: AssignmentBuild, withTpms: Boolean = true): SolveReport {
        val plan = Planner.solve(b.input, b.config)
        val audit = Planner.audit(b.input, b.config, plan)
        val tpms = if (withTpms && b.tpmsAssignment.isNotEmpty()) TpmsRoundTrip.validate(b.tpmsAssignment, b.input, b.config) else null
        return SolveReport(plan, b, ConflictMonitor.scan(b.input), audit, tpms, AssignmentOutput.csv(plan, b))
    }

    public fun tierName(t: Tier?): String = t?.name?.lowercase() ?: "unclassified"
}
