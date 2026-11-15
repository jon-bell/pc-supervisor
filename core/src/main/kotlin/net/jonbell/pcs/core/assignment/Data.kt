package net.jonbell.pcs.core.assignment

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import net.jonbell.pcs.core.config.Settings
import net.jonbell.pcs.core.imports.ImportKind
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.nominations.Decision
import net.jonbell.pcs.core.nominations.NominationData
import net.jonbell.pcs.core.nominations.NominationRules
import net.jonbell.pcs.core.readings.QId
import net.jonbell.pcs.core.readings.Readings
import net.jonbell.pcs.core.rules.Faults
import net.jonbell.pcs.core.rules.Member
import net.jonbell.pcs.core.rules.Tier
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.query

/*
 * The plan's input, read from the mirror and the latest imports (spec §10.3, §10.4 C). HotCRP holds the PC, the papers,
 * authors, conflicts and the reviews that exist; the appointments sheet holds who an AC accepted, classified and
 * who consented; `tpms-scores` holds affinity. Nothing here is a decision: it only assembles what the rules take.
 */

/** The settings the plan reads, from the conference file (spec §4.1). */
public data class AssignmentSettings(
    val loadMax: Map<String, Int>,
    val cycleMaxK: Int = 3,
    val topK: Int = 25,
    val hard: Boolean = false,
    val repairRounds: Int = DEFAULT_REPAIR_ROUNDS,
    val round: String? = null,
    val weights: Map<String, Double> = emptyMap(),
    /** The conflict-engineering monitor's numbers (M3): `PCS_M3_AFFINITY_MIN`, `PCS_M3_MIN_EXCLUDED`, `PCS_M3_MIN_SHARE`, `PCS_M3_SIGMA`. */
    val monitor: MonitorConfig = MonitorConfig(),
) {
    public companion object {
        public fun of(s: Settings): AssignmentSettings =
            AssignmentSettings(
                loadMax = s.loadMax,
                cycleMaxK = s.raw["PCS_CYCLE_MAX_K"]?.toIntOrNull()?.takeIf { it >= 1 } ?: 3,
                topK = s.raw["PCS_SOLVER_TOPK"]?.toIntOrNull()?.takeIf { it >= 1 } ?: 25,
                hard = s.raw["PCS_SOLVER_HARD"] == "1",
                repairRounds = s.raw["PCS_CYCLE_REPAIR_MAX_ROUNDS"]?.toIntOrNull()?.takeIf { it >= 0 } ?: DEFAULT_REPAIR_ROUNDS,
                monitor =
                    MonitorConfig(
                        qualifiedAffinity = s.raw["PCS_M3_AFFINITY_MIN"]?.toIntOrNull()?.takeIf { it in 0..100 } ?: MonitorConfig().qualifiedAffinity,
                        minShare = s.raw["PCS_M3_MIN_SHARE"]?.toDoubleOrNull()?.takeIf { it in 0.0..1.0 } ?: MonitorConfig().minShare,
                        minExcluded = s.raw["PCS_M3_MIN_EXCLUDED"]?.toIntOrNull()?.takeIf { it >= 1 } ?: MonitorConfig().minExcluded,
                        sigma = s.raw["PCS_M3_SIGMA"]?.toDoubleOrNull()?.takeIf { it >= 0.0 } ?: MonitorConfig().sigma,
                    ),
                round = s.raw["PCS_ASSIGN_ROUND"]?.takeIf { it.isNotBlank() },
                weights =
                    s.raw.filterKeys { it.startsWith("PCS_AFFINITY_WEIGHT_") }.mapNotNull { (k, v) ->
                        v.toDoubleOrNull()?.takeIf { it > 0 }?.let { k.removePrefix("PCS_AFFINITY_WEIGHT_").lowercase().replace('_', '-') to it }
                    }.toMap(),
            )
    }
}

/** What the plan is built from, with the names to turn ids back into people. */
public class AssignmentBuild(
    public val input: PlanInput,
    public val config: PlanConfig,
    public val emailOf: Map<Long, String>,
    public val tierOf: Map<Long, Tier?>,
    /** How many edges each affinity source supplied. */
    public val sources: Map<String, Int>,
    /** TPMS's own assignment, if imported, as edges to validate. */
    public val tpmsAssignment: List<Pin>,
    public val notes: List<String>,
    public val settings: AssignmentSettings,
) {
    public fun email(id: Long): String = emailOf[id] ?: "#$id"
}

public sealed interface AssignmentInput {
    public data class Blocked(val reasons: List<String>) : AssignmentInput

    public data class Ready(val build: AssignmentBuild) : AssignmentInput
}

public class AssignmentData(private val store: Store, private val imports: Imports) {
    public fun build(r: Readings, s: AssignmentSettings, faults: Faults = Faults.NONE): AssignmentInput {
        val nom = NominationData(store, imports).input()
        val (sheet, demoted) = NominationRules.effective(nom)
        val notes = demoted.map { "${it.subject}: ${it.message}" }.toMutableList()
        val byEmail = sheet.associateBy { it.email.trim().lowercase() }
        val nominees = sheet.any { it.origin == "nominee" && it.decision == Decision.ACCEPT }
        val blocked = mutableListOf<String>()
        if (r.q13 == null) blocked += "Q13 (the slots beyond the two senior ones) is unresolved"
        if (r.q14 == null) blocked += "Q14 (whether a senior nominee counts as senior) is unresolved"
        if (nominees) {
            for (q in listOf(QId.Q18, QId.Q19, QId.Q19B)) {
                if (r[q] ==
                    null
                ) {
                    blocked += "${q.code} (what a nominee owes) is unresolved, and the sheet has accepted nominees"
                }
            }
        }
        val scores = imports.latest(ImportKind.TPMS_SCORES)
        val tpmsAsg = imports.latest(ImportKind.TPMS_ASSIGNMENTS)
        if (scores == null && tpmsAsg == null) blocked += "no affinity source: import tpms-scores (or tpms-assignments)"
        if (blocked.isNotEmpty()) return AssignmentInput.Blocked(blocked)

        val pcEmails = store.conn.query("SELECT email FROM person WHERE gone_at IS NULL ORDER BY email") { it.getString(1).lowercase() }
        val everyone = (pcEmails + byEmail.keys).distinct().sorted()
        val id = everyone.withIndex().associate { it.value to it.index + 1L }
        val pcSet = pcEmails.toSet()

        // load bands: a tier's band for a PC member; a nominee's is what they owe, never above it (V2)
        val owes =
            if (nominees) {
                NominationRules.build(nom, r.base(), faults).obligations.associate { it.email to it.owes.decided }
            } else {
                emptyMap()
            }
        val named = if (nominees) NominationRules.build(nom, r.base(), faults).obligations.associate { it.email to it.papers.size } else emptyMap()
        val reviewers =
            everyone.mapNotNull { e ->
                val row = byEmail[e]
                if (row == null && e !in pcSet) return@mapNotNull null
                val nominee = row?.origin == "nominee"
                val tier = row?.tier ?: if (row == null) Tier.SENIOR else null
                val member =
                    Member(
                        id.getValue(e),
                        tier,
                        nominee = nominee,
                        accepted = row == null || row.decision == Decision.ACCEPT,
                        consented = row == null || row.consent == true,
                    )
                val band = tier?.let { s.loadMax[it.name.lowercase()] } ?: 0
                val (cap, owed) =
                    if (nominee && member.accepted) {
                        val o = owes[e] ?: (6 * net.jonbell.pcs.core.rules.K * (named[e] ?: 0))
                        minOf(band, (o + 5) / 6) to o
                    } else {
                        band to null
                    }
                Reviewer(member, cap, owed, onPc = e in pcSet)
            }

        val conflictsOf =
            store.conn.query(
                "SELECT pid, pc_conflicts FROM paper WHERE gone_at IS NULL AND decision IS NULL AND coalesce(status,'') NOT IN ('withdrawn','draft') ORDER BY pid",
            ) { rs ->
                rs.getLong(1) to Json.parseToJsonElement(rs.getString(2)).jsonObject.keys.map { it.lowercase() }
            }
        val authorsOf = nom.papers.associate { it.pid to it.authors.map { a -> a.trim().lowercase() } }
        val planPapers = conflictsOf.map { (pid, cs) -> PlanPaper(pid, authorsOf[pid].orEmpty().mapNotNull { id[it] }, cs.mapNotNull { id[it] }) }
        val paperIds = planPapers.map { it.pid }.toSet()

        // existing reviews, second-opinion members included: pinned. Only what a review is (who, which paper) is read, so
        // nothing a second opinion said can move the plan (S11).
        val pinned =
            store.conn.query("SELECT pid, email FROM review WHERE rtype != 5 AND gone_at IS NULL AND email IS NOT NULL") {
                it.getLong(1) to
                    it.getString(2).lowercase()
            }
                .mapNotNull { (pid, e) -> if (pid in paperIds) id[e]?.let { Pin(it, pid) } else null }.distinct()

        val unknown = mutableSetOf<String>()

        fun edges(kind: ImportKind): Map<Pair<Long, Long>, Double> =
            imports.latest(kind)?.rows.orEmpty().mapNotNull { row ->
                val pid = row.data["paper"]!!.toLong()
                val e = row.data["email"]!!.lowercase()
                val who = id[e]
                if (who == null) {
                    unknown += e
                    null
                } else {
                    (who to pid) to (row.data["score"]?.toDouble() ?: 1.0)
                }
            }.toMap()

        val sources = mutableListOf<AffinitySource>()
        if (scores != null) sources += AffinitySource.tpms(edges(ImportKind.TPMS_SCORES), s.weights["tpms-scores"] ?: 3.0)
        val warm = if (tpmsAsg != null) edges(ImportKind.TPMS_ASSIGNMENTS).keys.map { Pin(it.first, it.second) } else emptyList()
        // without scores, TPMS's own assignment is the affinity evidence: its edges are valued at a flat 0.8
        if (scores ==
            null
        ) {
            sources += AffinitySource("tpms-assignments", s.weights["tpms-assignments"] ?: 1.0, 0.0, 1.0, warm.associate { (it.who to it.pid) to 0.8 })
        }
        if (unknown.isNotEmpty()) notes += "${unknown.size} people in the affinity data are neither on the PC nor in the appointments sheet and were ignored"
        val aff = Affinity.combine(sources)
        val cands =
            aff.entries.filter {
                it.key.first in id.values && it.key.second in paperIds
            }.map { Candidate(it.key.first, it.key.second, it.value) }.sortedWith(compareBy({ it.pid }, { it.who }))

        val cfg =
            PlanConfig(
                r.q13!!,
                r.q14!!,
                faults,
                cycleMaxK = s.cycleMaxK,
                repairRounds = s.repairRounds,
                topK = s.topK,
                hard = s.hard,
            )
        return AssignmentInput.Ready(
            AssignmentBuild(
                PlanInput(reviewers, planPapers, cands, pinned),
                cfg,
                id.entries.associate { it.value to it.key },
                reviewers.associate { it.who to it.member.tier },
                Affinity.coverage(sources),
                warm,
                notes,
                s,
            ),
        )
    }
}
