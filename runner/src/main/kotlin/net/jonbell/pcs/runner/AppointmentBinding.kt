package net.jonbell.pcs.runner

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import net.jonbell.pcs.core.assignment.Assignment
import net.jonbell.pcs.core.assignment.AssignmentBuild
import net.jonbell.pcs.core.assignment.AssignmentData
import net.jonbell.pcs.core.assignment.AssignmentInput
import net.jonbell.pcs.core.assignment.AssignmentSettings
import net.jonbell.pcs.core.assignment.SolveReport
import net.jonbell.pcs.core.imports.ImportKind
import net.jonbell.pcs.core.imports.ImportResult
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.nominations.Candidate
import net.jonbell.pcs.core.nominations.Decision
import net.jonbell.pcs.core.nominations.NominationData
import net.jonbell.pcs.core.nominations.NominationRules
import net.jonbell.pcs.core.writeback.AssignmentArtifact
import net.jonbell.pcs.core.writeback.Writeback
import net.jonbell.pcs.core.writeback.WritebackException
import net.jonbell.pcs.core.writeback.WritebackStatus
import net.jonbell.pcs.runner.model.AppointmentAndAssignmentAction
import net.jonbell.pcs.runner.model.AppointmentAndAssignmentApply
import net.jonbell.pcs.runner.model.AppointmentAndAssignmentClassify
import net.jonbell.pcs.runner.model.AppointmentAndAssignmentConfirm
import net.jonbell.pcs.runner.model.AppointmentAndAssignmentConsent
import net.jonbell.pcs.runner.model.AppointmentAndAssignmentDryRun
import net.jonbell.pcs.runner.model.AppointmentAndAssignmentHotcrpObs
import net.jonbell.pcs.runner.model.AppointmentAndAssignmentSolve
import net.jonbell.pcs.runner.model.AppointmentAndAssignmentStateObs
import net.jonbell.pcs.runner.model.AppointmentAndAssignmentSync
import java.time.Instant

/**
 * The bindings of the appointment-and-assignment subsystem (PLAN M15; spec §10.4 A and C). One trace is about one nominee and one paper:
 *
 * - the AC's classification and the nominee's consent are rows of the appointments sheet, imported as a new version each time
 *   (`classify` is effective when `core` then reads the nominee as accepted; a row an AC didn't write is never acted on);
 * - `sync` is `core`'s sync of the harness; `solve` is `core`'s plan for this paper, from the mirror and the imports, with the
 *   implementation fault switched on if the control asks for one;
 * - `dry-run`, `confirm` and `apply` are Writeback on the plan's bulk-assign CSV, with the chair token, and HotCRP's own refusal is an outcome.
 *
 * The state reader reads what `core` derived (the effective sheet, its store, the plan, the artifact); the HotCRP reader reads
 * whether the planned reviewers are on the paper in HotCRP.
 */
class AppointmentBinding(private val w: World) {
    private val nominee = Persons.NOMINEE_OUTSIDER
    private val others = Persons.EARLY_PC_MEMBERS + "r6@example.org"
    private var started = false
    private var openSync: Instant = Instant.EPOCH
    private var decision = "pending"
    private var tier = ""
    private var consent = ""
    private var acEmail = ""
    private var syncedByAction = false
    private var report: SolveReport? = null
    private var artifact: Long? = null
    private var rows: List<Map<String, String>> = emptyList()

    private val imports get() = Imports(w.store, w.clock)
    private val writeback get() = Writeback(w.store, w.clock, w.api.base, w.token)

    /** The first action: a sync (so the paper's AC is in the mirror), and the affinity of the people the plan can choose from. */
    private fun start() {
        if (started) return
        started = true
        w.sync()
        openSync = lastSync()
        val csv = "paper,email,score\n${w.pid},$nominee,0.95\n" + others.joinToString("") { "${w.pid},$it,0.50\n" }
        check(imports.import(ImportKind.TPMS_SCORES, csv.toByteArray(), "scores-${w.pid}.csv") is ImportResult.Accepted)
        // the paper's authors nominated this person, so the sheet has a pending row for them from the start
        writeSheet()
    }

    private fun lastSync(): Instant =
        w.store.conn.createStatement().use { st ->
            st.executeQuery("SELECT now_used FROM sync_run ORDER BY id DESC LIMIT 1").use {
                if (it.next()) Instant.ofEpochSecond(it.getLong(1)) else Instant.EPOCH
            }
        }

    /** The nominee's row as `core` reads it: a decision by someone who is not an AC of the paper is pending. */
    private fun sheetRow(): Candidate? {
        val input = NominationData(w.store, imports).input()
        return NominationRules.effective(input).first.firstOrNull { it.email.equals(nominee, true) }
    }

    private fun writeSheet() {
        val csv =
            "email,origin,nominated_by,area,ac_email,decision,tier,consent,on_pc_at\n" +
                "$nominee,nominee,${w.pid},testing,$acEmail,$decision,$tier,$consent,\n"
        check(imports.import(ImportKind.APPOINTMENTS, csv.toByteArray(), "sheet-${w.pid}.csv") is ImportResult.Accepted)
    }

    private fun outcome(ok: Boolean) = if (ok) Outcome.EFFECTIVE else Outcome.REFUSED

    private fun asChair(role: String?) = role == "process-chair" || role == "pc-chair"

    fun perform(a: AppointmentAndAssignmentAction, role: String?): Outcome {
        start()
        return when (a) {
            is AppointmentAndAssignmentClassify -> {
                val before = sheetRow()?.decision == Decision.ACCEPT
                decision = "accept"
                tier = a.tier
                acEmail =
                    when (role) {
                        "ac" -> Persons.AC_REFERRING
                        "pc-chair" -> Persons.PC_CHAIR
                        else -> Persons.PC_MEMBER_OUTSIDER
                    }
                writeSheet()
                outcome(!before && sheetRow()?.decision == Decision.ACCEPT)
            }
            is AppointmentAndAssignmentConsent -> {
                if (consent == "yes") {
                    Outcome.REFUSED
                } else {
                    consent = "yes"
                    writeSheet()
                    Outcome.EFFECTIVE
                }
            }
            is AppointmentAndAssignmentSync ->
                if (syncedByAction || !asChair(role)) {
                    Outcome.REFUSED
                } else {
                    w.clock.advance(1)
                    w.sync()
                    syncedByAction = true
                    Outcome.EFFECTIVE
                }
            is AppointmentAndAssignmentSolve ->
                if (!syncedByAction || report != null || !asChair(role)) {
                    Outcome.REFUSED
                } else {
                    solve()
                    Outcome.EFFECTIVE
                }
            is AppointmentAndAssignmentDryRun ->
                if (report == null || !asChair(role) || status() in DRY_RUN_DONE) {
                    Outcome.REFUSED
                } else {
                    val id = artifact ?: writeback.draft(AssignmentArtifact(rows, "Assignment plan for #${w.pid}")).also { artifact = it }
                    outcome(writeback.dryRun(id).valid)
                }
            is AppointmentAndAssignmentConfirm ->
                if (report == null || !asChair(role) || artifact == null || status() in CONFIRMED_DONE) {
                    Outcome.REFUSED
                } else {
                    try {
                        writeback.confirm(artifact!!)
                        Outcome.EFFECTIVE
                    } catch (e: WritebackException) {
                        Outcome.REFUSED
                    }
                }
            is AppointmentAndAssignmentApply ->
                if (!asChair(role)) {
                    // anyone else goes to HotCRP, which only a chair's assignments are allowed through
                    val row = rows.firstOrNull() ?: return Outcome.REFUSED
                    val user = if (role == "pc-member") Persons.PC_MEMBER_OUTSIDER else Persons.NOMINEE_OUTSIDER
                    val body = """[{"pid":${row["paper"]},"action":"${row["action"]}","user":"${row["email"]}"}]"""
                    outcome(w.api.ok(w.api.call("POST", "assign", json = body, actas = user)))
                } else if (artifact == null) {
                    Outcome.REFUSED
                } else {
                    try {
                        outcome(writeback.apply(artifact!!).status in APPLIED)
                    } catch (e: WritebackException) {
                        Outcome.REFUSED
                    }
                }
        }
    }

    private fun solve() {
        val readings = w.readings
        val settings = AssignmentSettings(loadMax = mapOf("senior" to 15, "junior" to 8))
        val built = (AssignmentData(w.store, imports).build(readings, settings, w.implFaults) as AssignmentInput.Ready).build
        // the plan for this paper only: the harness holds the golden papers too
        val input = built.input.copy(papers = built.input.papers.filter { it.pid == w.pid })
        val b = AssignmentBuild(input, built.config, built.emailOf, built.tierOf, built.sources, emptyList(), built.notes, built.settings)
        val r = Assignment.report(b, withTpms = false)
        report = r
        rows = r.csv.rows
    }

    private fun status(): WritebackStatus? = artifact?.let { writeback.get(it).status }

    private fun nomineeId(): Long? = report?.build?.emailOf?.entries?.firstOrNull { it.value.equals(nominee, true) }?.key

    private fun inPlan(): Boolean = report?.let { r -> nomineeId()?.let { id -> r.plan.edges.any { it.who == id && it.pid == w.pid } } } ?: false

    private fun applied(): Boolean = status() in APPLIED

    /** HotCRP's truth: the planned reviewers are on the paper. */
    private fun onPaper(email: String): Boolean =
        w.api.reviews(w.pid).any { it.str("reviewer_email").equals(email, true) && it.str("rtype") != "5" }

    fun readHotcrp(o: AppointmentAndAssignmentHotcrpObs): JsonElement =
        when (o) {
            AppointmentAndAssignmentHotcrpObs.APPLIED -> JsonPrimitive(rows.isNotEmpty() && applied() && rows.all { onPaper(it.getValue("email")) })
            AppointmentAndAssignmentHotcrpObs.NOMINEE_ASSIGNED -> JsonPrimitive(onPaper(nominee))
        }

    fun readState(o: AppointmentAndAssignmentStateObs): JsonElement {
        val row = sheetRow()
        val accepted = row?.decision == Decision.ACCEPT
        return when (o) {
            AppointmentAndAssignmentStateObs.ACCEPTED -> JsonPrimitive(accepted)
            AppointmentAndAssignmentStateObs.TIER ->
                row?.tier?.takeIf { accepted }?.let { JsonPrimitive(it.name.lowercase()) }
                    ?: kotlinx.serialization.json.JsonNull
            AppointmentAndAssignmentStateObs.CONSENTED -> JsonPrimitive(row?.consent == true)
            AppointmentAndAssignmentStateObs.SYNCED -> JsonPrimitive(lastSync().isAfter(openSync))
            AppointmentAndAssignmentStateObs.SOLVED -> JsonPrimitive(report != null)
            AppointmentAndAssignmentStateObs.IN_PLAN -> JsonPrimitive(inPlan())
            AppointmentAndAssignmentStateObs.DRY_RUN_OK -> JsonPrimitive(status() in DRY_RUN_DONE)
            AppointmentAndAssignmentStateObs.CONFIRMED -> JsonPrimitive(status() in CONFIRMED_DONE)
            AppointmentAndAssignmentStateObs.APPLIED -> JsonPrimitive(applied())
            AppointmentAndAssignmentStateObs.NOMINEE_ASSIGNED -> JsonPrimitive(applied() && inPlan())
        }
    }

    /** Every observation of the subsystem from every reader the model names for it. Nothing here syncs: `synced` is something the trace does. */
    fun observe(): JsonObject {
        val by = linkedMapOf<String, MutableMap<String, JsonElement>>()
        if (started) {
            AppointmentAndAssignmentHotcrpObs.entries.forEach { by.getOrPut(it.key) { linkedMapOf() }["hotcrp"] = readHotcrp(it) }
            AppointmentAndAssignmentStateObs.entries.forEach { by.getOrPut(it.key) { linkedMapOf() }["state"] = readState(it) }
        }
        return JsonObject(by.mapValues { (_, m) -> JsonObject(m) })
    }

    private companion object {
        val DRY_RUN_DONE = setOf(WritebackStatus.DRY_RUN, WritebackStatus.CONFIRMED, WritebackStatus.APPLIED, WritebackStatus.OBSERVED)
        val CONFIRMED_DONE = setOf(WritebackStatus.CONFIRMED, WritebackStatus.APPLIED, WritebackStatus.OBSERVED)
        val APPLIED = setOf(WritebackStatus.APPLIED, WritebackStatus.OBSERVED)
    }
}
