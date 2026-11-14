package pcs.runner

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import pcs.core.hotcrp.HotcrpClient
import pcs.core.readings.QId
import pcs.core.readings.Readings
import pcs.core.rules.Conventions
import pcs.core.rules.DeskReject
import pcs.core.rules.Faults
import pcs.core.rules.Ground
import pcs.core.rules.Opinion
import pcs.core.rules.Referral
import pcs.core.rules.Stage
import pcs.core.rules.Trace
import pcs.core.store.Store
import pcs.core.store.Sync
import pcs.core.time.Clock
import pcs.runner.model.AccountabilityRequestsAction
import pcs.runner.model.AccountabilityRequestsCoach
import pcs.runner.model.AccountabilityRequestsDismiss
import pcs.runner.model.AccountabilityRequestsDispose
import pcs.runner.model.AccountabilityRequestsOpenCase
import pcs.runner.model.AccountabilityRequestsRemind
import pcs.runner.model.AccountabilityRequestsReply
import pcs.runner.model.AccountabilityRequestsSend
import pcs.runner.model.AccountabilityRequestsSetCriteria
import pcs.runner.model.AccountabilityRequestsSuggest
import pcs.runner.model.AccountabilityRequestsTick
import pcs.runner.model.AccountabilityRequestsUphold
import pcs.runner.model.AppointmentAndAssignmentAction
import pcs.runner.model.AppointmentAndAssignmentApply
import pcs.runner.model.AppointmentAndAssignmentClassify
import pcs.runner.model.AppointmentAndAssignmentConfirm
import pcs.runner.model.AppointmentAndAssignmentConsent
import pcs.runner.model.AppointmentAndAssignmentDryRun
import pcs.runner.model.AppointmentAndAssignmentSolve
import pcs.runner.model.AppointmentAndAssignmentSync
import pcs.runner.model.DeskRejectAction
import pcs.runner.model.DeskRejectAdvance
import pcs.runner.model.DeskRejectClockObs
import pcs.runner.model.DeskRejectCure
import pcs.runner.model.DeskRejectHotcrpObs
import pcs.runner.model.DeskRejectOfferRemedy
import pcs.runner.model.DeskRejectOpinion
import pcs.runner.model.DeskRejectRefer
import pcs.runner.model.DeskRejectRemove
import pcs.runner.model.DeskRejectRoleObs
import pcs.runner.model.DeskRejectStateObs
import pcs.runner.model.DeskRejectTick
import pcs.runner.model.DeskRejectWarn
import pcs.runner.model.EarlyRejectAction
import pcs.runner.model.EarlyRejectBump
import pcs.runner.model.EarlyRejectCloseWindow
import pcs.runner.model.EarlyRejectRemove
import pcs.runner.model.EarlyRejectReview
import pcs.runner.model.ModelAction
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant

/*
 * The bindings that don't need the app (PLAN §A4): the HotCRP actor, the clock, the file driver,
 * the state reader, the HotCRP reader, and the role reader. `core` stands in for the chair's UI
 * actions (the chair token). The bindings are test code, so each has a switchable fault
 * (PLAN §A8 binding mutants) that a control must catch.
 */

/** Faults in the bindings; each makes a broken system look correct unless a control notices. */
data class BindingFaults(
    val actorSkipsAction: Boolean = false,
    val clockDoesNotAdvance: Boolean = false,
    val roleReaderReadsAsChair: Boolean = false,
    val hotcrpReaderDropsLastRow: Boolean = false,
    val stateReaderStale: Boolean = false,
) {
    val name: String?
        get() =
            when {
                actorSkipsAction -> "actor-skips-action"
                clockDoesNotAdvance -> "clock-does-not-advance"
                roleReaderReadsAsChair -> "role-reader-reads-as-chair"
                hotcrpReaderDropsLastRow -> "hotcrp-reader-drops-last-row"
                stateReaderStale -> "state-reader-stale"
                else -> null
            }

    companion object {
        fun of(key: String): BindingFaults =
            when (key) {
                "actor-skips-action" -> BindingFaults(actorSkipsAction = true)
                "clock-does-not-advance" -> BindingFaults(clockDoesNotAdvance = true)
                "role-reader-reads-as-chair" -> BindingFaults(roleReaderReadsAsChair = true)
                "hotcrp-reader-drops-last-row" -> BindingFaults(hotcrpReaderDropsLastRow = true)
                "state-reader-stale" -> BindingFaults(stateReaderStale = true)
                else -> error("not a binding fault: $key")
            }
    }
}

/** The clock binding: model time is hours since [start]; `core` reads it as `PCS_NOW` would pin it. */
class ProcessClock(val start: Instant, private val faults: BindingFaults) : Clock {
    private var hours = 0L

    fun advance(by: Long) {
        if (!faults.clockDoesNotAdvance) hours += by
    }

    override fun now(): Instant = start.plusSeconds(hours * 3600)

    fun modelHours(at: Instant = now()): Long = (at.epochSecond - start.epochSecond) / 3600
}

/** The file driver: generated files the process reads. The model's stage lives in a file until M6's phase model exists. */
class FileDriver(val dir: Path) {
    fun writeStage(pid: Long, stage: Stage) {
        Files.writeString(dir.resolve("process-$pid.json"), """{"stage":"${stage.key}"}""")
    }

    fun readStage(pid: Long): Stage =
        dir.resolve("process-$pid.json").let { f ->
            if (!Files.exists(f)) {
                Stage.SCREENING
            } else {
                Stage.ofKey(Json.parseToJsonElement(Files.readString(f)).let { (it as JsonObject)["stage"]!!.jsonPrimitive.content })!!
            }
        }
}

/** What a binding's action did to the system: HotCRP's refusal is an outcome, not an error. */
enum class Outcome(val key: String) { EFFECTIVE("effective"), REFUSED("refused") }

/** A person who gave a second opinion, as the state reader derives it. */
data class Giver(val who: Long, val isAc: Boolean, val tier: pcs.core.rules.Tier?)

/** Raised for model actions whose binding needs a later milestone. The `when` stays exhaustive, so a new action can't be forgotten. */
class UnboundAction(val action: ModelAction, val needs: String) : RuntimeException("${action.subsystem}: ${action.label} needs $needs")

/**
 * Everything one scenario needs: the harness through the observer, a fresh store, the clock, the
 * file driver, and the paper under test.
 */
class World(
    val api: HotcrpApi,
    val token: String,
    val storeDir: Path,
    val dbKey: String,
    val readings: Readings,
    val faults: BindingFaults,
    val implFaults: Faults,
    val clock: ProcessClock,
    val files: FileDriver,
    /** What a second opinion says; the runner plants the review-text canary in it (PLAN §A6). */
    val reviewText: String = "Synthetic second opinion.",
) : AutoCloseable {
    lateinit var store: Store
    var pid: Long = 0
    var author: String = ""
    private var askedAt: Long = 0
    private val given = mutableSetOf<Long>()
    private val stateCache = mutableMapOf<String, JsonElement>()

    fun open(pid: Long, author: String) {
        this.pid = pid
        this.author = author
        store = Store.open(storeDir.resolve("pcs-$pid.db"), dbKey)
    }

    override fun close() {
        if (this::store.isInitialized) store.close()
    }

    fun sync() {
        runBlocking { HotcrpClient(api.base, token, chunk = 100, strict = true).use { Sync(store, clock).run(it) } }
    }

    // ---- the HotCRP actor ---------------------------------------------------------------

    private fun userOf(role: String, who: Long? = null): String =
        when (role) {
            "ac" -> Persons.AC_REFERRING
            "pc-member" -> who?.let { Persons.byWho(it).email } ?: Persons.PC_MEMBER_OUTSIDER
            "nominee" -> Persons.NOMINEE_OUTSIDER
            "author" -> author
            else -> error("no harness user stands for role $role")
        }

    /** The chair's action for a paper arriving: the AC's screening metareview in the `screen` round (spec §11). */
    fun assignScreening() {
        check(api.ok(api.assign("""{"pid":$pid,"action":"metareview","user":"${Persons.AC_REFERRING}","round":"screen"}""")))
    }

    private fun tryReview(email: String, fields: String): Boolean {
        val mine = api.reviews(pid, actas = email).firstOrNull { it.str("reviewer_email") == email }
        val r = mine?.str("rid") ?: "new"
        return api.ok(api.call("POST", "$pid/review", mapOf("r" to r), actas = email, json = fields))
    }

    /** Perform one model action through the bindings. */
    fun perform(a: ModelAction, role: String?): Outcome =
        when (a) {
            is DeskRejectAction -> desk(a, role)
            is EarlyRejectAction -> unboundEarly(a)
            is AccountabilityRequestsAction -> unboundAccountability(a)
            is AppointmentAndAssignmentAction -> unboundAppointment(a)
        }

    private fun desk(a: DeskRejectAction, role: String?): Outcome =
        when (a) {
            is DeskRejectRefer -> {
                val symbol = Ground.ofKey(a.ground)!!.ordinal + 2
                val ok = tryReview(userOf(role!!), """{"object":"review","Tri":$symbol,"status":"complete"}""")
                if (ok) mirrorTriage()
                outcome(ok)
            }
            is DeskRejectOpinion -> {
                if (faults.actorSkipsAction) {
                    Outcome.EFFECTIVE // the mutant: HotCRP is never touched, and the actor reports success
                } else if (role == "pc-member") {
                    val who = Persons.byWho(a.who)
                    if (given.add(a.who)) {
                        if (askedAt == 0L) askedAt = clock.modelHours()
                        check(api.ok(api.assign("""{"pid":$pid,"action":"pcreview","user":"${who.email}","round":"screen"}""")))
                    }
                    outcome(tryReview(who.email, """{"object":"review","ComPC":"$reviewText","status":"complete"}"""))
                } else {
                    outcome(tryReview(userOf(role!!), """{"object":"review","ComPC":"$reviewText","status":"complete"}"""))
                }
            }
            is DeskRejectOfferRemedy -> {
                val due = clock.now().epochSecond + 72 * 3600
                outcome(api.ok(api.call("POST", "$pid/tags", form = "addtags=pcs-remedy-due%23$due")))
            }
            is DeskRejectWarn -> outcome(api.ok(api.call("POST", "$pid/tags", form = "addtags=pcs-warned")))
            is DeskRejectCure -> {
                val ok =
                    api.ok(
                        api.call(
                            "POST",
                            "paper",
                            mapOf("p" to "$pid"),
                            actas = userOf(role!!),
                            json = """{"object":"paper","pid":$pid,"abstract":"$CURED_ABSTRACT"}""",
                        ),
                    )
                outcome(ok)
            }
            is DeskRejectTick -> {
                clock.advance(100)
                Outcome.EFFECTIVE
            }
            is DeskRejectAdvance -> {
                val next = Stage.entries.getOrNull(files.readStage(pid).ordinal + 1) ?: return Outcome.REFUSED
                files.writeStage(pid, next)
                Outcome.EFFECTIVE
            }
            is DeskRejectRemove ->
                if (role ==
                    "pc-chair"
                ) {
                    chairRemove()
                } else {
                    outcome(api.ok(api.call("POST", "$pid/decision", mapOf("decision" to "Reject"), actas = userOf(role!!))))
                }
        }

    private fun outcome(ok: Boolean) = if (ok) Outcome.EFFECTIVE else Outcome.REFUSED

    private fun unboundEarly(a: EarlyRejectAction): Nothing =
        when (a) {
            is EarlyRejectReview, is EarlyRejectBump, is EarlyRejectCloseWindow, is EarlyRejectRemove -> throw UnboundAction(a, "M17 (early reject)")
        }

    private fun unboundAccountability(a: AccountabilityRequestsAction): Nothing =
        when (a) {
            is AccountabilityRequestsSetCriteria, is AccountabilityRequestsSuggest, is AccountabilityRequestsDismiss,
            is AccountabilityRequestsCoach, is AccountabilityRequestsSend, is AccountabilityRequestsRemind,
            is AccountabilityRequestsReply, is AccountabilityRequestsDispose, is AccountabilityRequestsTick,
            is AccountabilityRequestsOpenCase, is AccountabilityRequestsUphold,
            -> throw UnboundAction(a, "M16 (accountability requests)")
        }

    private fun unboundAppointment(a: AppointmentAndAssignmentAction): Nothing =
        when (a) {
            is AppointmentAndAssignmentClassify, is AppointmentAndAssignmentConsent, is AppointmentAndAssignmentSync,
            is AppointmentAndAssignmentSolve, is AppointmentAndAssignmentDryRun, is AppointmentAndAssignmentConfirm,
            is AppointmentAndAssignmentApply,
            -> throw UnboundAction(a, "M7/M15 (appointment and assignment)")
        }

    // ---- `core` standing in for the chair's UI actions (the chair token) --------------------------------

    /** PC Supervisor reads the AC's triage and mirrors it into the hidden tag (spec §11, conv:1). */
    private fun mirrorTriage() {
        val tri = hotcrp.referral() ?: return
        api.call("POST", "$pid/tags", form = "addtags=pcs-refer-${tri.key}")
        sync()
    }

    private fun chairRemove(): Outcome {
        sync()
        val ref = referral() ?: return Outcome.REFUSED
        if (!DeskReject.mayRemove(implFaults, readings, ref)) return Outcome.REFUSED
        return outcome(api.ok(api.call("POST", "$pid/decision", mapOf("decision" to "Reject"))))
    }

    /** The referral as `core` derives it from the synced mirror (and the one fact only HotCRP's paper holds: the cure). */
    private fun referral(): Referral? {
        val tags = state.traces()
        val ground = tags.filterIsInstance<Trace.Refer>().firstOrNull()?.ground ?: return null
        val due = tags.filterIsInstance<Trace.RemedyDue>().firstOrNull()?.dueEpoch
        return Referral(
            ac = 1,
            ground = ground,
            opinions = state.opinionPersons().map { Opinion(it.who, it.isAc, it.tier) },
            stage = files.readStage(pid),
            remedyOffered = due != null,
            remedyDue = due?.let { (it - clock.start.epochSecond) / 3600 } ?: 0,
            cured = hotcrp.cured(),
            warned = tags.any { it is Trace.Warned },
            askedAt = askedAt,
            now = clock.modelHours(),
        )
    }

    // ---- readers -----------------------------------------------------------------------------

    val hotcrp = HotcrpReader()
    val state = StateReader()
    val role = RoleReader()

    /** What HotCRP holds, as a chair. */
    inner class HotcrpReader {
        private fun reviews(): List<JsonObject> = api.reviews(pid).let { if (faults.hotcrpReaderDropsLastRow) it.dropLast(1) else it }

        fun referral(): Ground? =
            reviews().firstOrNull { it.str("reviewer_email") == Persons.AC_REFERRING }?.str("Tri")?.toIntOrNull()?.let { s -> Ground.entries.getOrNull(s - 2) }

        fun cured(): Boolean = api.paper(pid).str("abstract") == CURED_ABSTRACT

        fun read(o: DeskRejectHotcrpObs): JsonElement =
            when (o) {
                DeskRejectHotcrpObs.REFERRED -> JsonPrimitive(referral() != null)
                DeskRejectHotcrpObs.GROUND -> referral()?.let { JsonPrimitive(it.key) } ?: JsonNull
                DeskRejectHotcrpObs.OPINIONS ->
                    JsonArray(
                        reviews().filter { it.str("rtype") != "5" && it.str("status") == "complete" }
                            .mapNotNull { r -> r.str("reviewer_email")?.let { Persons.byEmail(it) } }.map { it.who }.sorted().map { JsonPrimitive(it) },
                    )
                DeskRejectHotcrpObs.CURED -> JsonPrimitive(cured())
                DeskRejectHotcrpObs.DISPOSITION -> JsonPrimitive(disposition(api.paper(pid).str("decision"), referral()))
            }
    }

    private fun disposition(decision: String?, ground: Ground?): String = if (decision == "Rejected") "removed:${ground?.key ?: "?"}" else "in-review"

    /** What `core` derived: its store after a sync, plus the process files and the clock it was given. */
    inner class StateReader {
        fun traces(): List<Trace> {
            val tags =
                store.conn.createStatement().use { st ->
                    st.executeQuery("SELECT tags FROM paper WHERE pid = $pid").use { if (it.next()) it.getString(1) else "[]" }
                }
            return Conventions.decode(pid, Json.parseToJsonElement(tags).jsonArray.map { it.jsonPrimitive.content })
        }

        fun opinionPersons(): List<Giver> =
            store.conn.createStatement().use { st ->
                st.executeQuery("SELECT email FROM review WHERE pid = $pid AND rtype != 5 AND status = 'complete' AND gone_at IS NULL").use { rs ->
                    buildList { while (rs.next()) Persons.byEmail(rs.getString(1))?.let { add(Giver(it.who, it.isAc, it.tier)) } }
                }
            }.sortedBy { it.who }

        private fun lastSyncNow(): Instant =
            store.conn.createStatement().use { st ->
                st.executeQuery("SELECT now_used FROM sync_run ORDER BY id DESC LIMIT 1").use {
                    if (it.next()) Instant.ofEpochSecond(it.getLong(1)) else clock.start
                }
            }

        private fun fresh(o: DeskRejectStateObs): JsonElement {
            val tr = traces()
            val ground = tr.filterIsInstance<Trace.Refer>().firstOrNull()?.ground
            return when (o) {
                DeskRejectStateObs.REFERRED -> JsonPrimitive(ground != null)
                DeskRejectStateObs.GROUND -> ground?.let { JsonPrimitive(it.key) } ?: JsonNull
                DeskRejectStateObs.OPINIONS -> JsonArray(opinionPersons().map { JsonPrimitive(it.who) })
                DeskRejectStateObs.STAGE -> JsonPrimitive(files.readStage(pid).key)
                DeskRejectStateObs.REMEDY_DUE ->
                    tr.filterIsInstance<Trace.RemedyDue>().firstOrNull()?.let { JsonPrimitive((it.dueEpoch - clock.start.epochSecond) / 3600) } ?: JsonNull
                DeskRejectStateObs.WARNED -> JsonPrimitive(tr.any { it is Trace.Warned })
                DeskRejectStateObs.NOW -> JsonPrimitive(clock.modelHours(lastSyncNow()))
                DeskRejectStateObs.DISPOSITION ->
                    JsonPrimitive(
                        disposition(
                            store.conn.createStatement().use { st ->
                                st.executeQuery("SELECT decision FROM paper WHERE pid = $pid").use { if (it.next()) it.getString(1) else null }
                            },
                            ground,
                        ),
                    )
            }
        }

        fun read(o: DeskRejectStateObs): JsonElement =
            // the mutant never refreshes: it answers from the first value it read
            if (faults.stateReaderStale) stateCache.getOrPut(o.key) { fresh(o) } else fresh(o)
    }

    /** What a non-chair role can see: the API as that user (spec §11; policy cell `see-review-text`). */
    inner class RoleReader {
        private fun sees(email: String): Boolean =
            api.reviews(pid, actas = if (faults.roleReaderReadsAsChair) null else email)
                .any { it.str("Tri") != null || !it.str("ComPC").isNullOrBlank() }

        fun read(o: DeskRejectRoleObs): JsonElement =
            when (o) {
                DeskRejectRoleObs.ROLE_SEES_PC_MEMBER -> JsonPrimitive(sees(Persons.PC_MEMBER_OUTSIDER))
                DeskRejectRoleObs.ROLE_SEES_NOMINEE -> JsonPrimitive(sees(Persons.NOMINEE_OUTSIDER))
            }
    }

    fun readClock(o: DeskRejectClockObs): JsonElement =
        when (o) {
            DeskRejectClockObs.NOW -> JsonPrimitive(clock.modelHours())
        }

    /** Every observation, from every reader the model names for it. */
    fun observe(): JsonObject {
        val by = linkedMapOf<String, MutableMap<String, JsonElement>>()

        fun put(key: String, reader: String, v: JsonElement) {
            by.getOrPut(key) { linkedMapOf() }[reader] = v
        }
        if (!faults.stateReaderStale || stateCache.isEmpty()) sync()
        DeskRejectHotcrpObs.entries.forEach { put(it.key, "hotcrp", hotcrp.read(it)) }
        DeskRejectStateObs.entries.forEach { put(it.key, "state", state.read(it)) }
        DeskRejectClockObs.entries.forEach { put(it.key, "clock", readClock(it)) }
        DeskRejectRoleObs.entries.forEach { put(it.key, "role", role.read(it)) }
        return JsonObject(by.mapValues { (_, m) -> JsonObject(m) })
    }

    companion object {
        const val CURED_ABSTRACT = "Fixed: the violation was corrected in a new version."

        fun readingsOf(reading: JsonObject): Readings =
            reading.entries.fold(Readings()) { r, (q, v) -> r.with(QId.ofCode(q)!!, v.jsonPrimitive.content) ?: error("bad reading $q=$v") }

        fun settingsJson(): String {
            val values =
                (listOf("Keep") + Ground.entries.map { "Refer: ${it.key}" }).mapIndexed {
                    i,
                    n,
                    ->
                    """{"name":"$n","symbol":${i + 1}}"""
                }.joinToString(",")
            return """{"tag_hidden":"pcs-*","review":[{"name":"screen"}],"review_visibility_pc":"after_review",""" +
                """"rf":[{"id":"s90","name":"Triage","type":"radio","required":false,"visibility":"admin","condition":"round:screen","values":[$values]},""" +
                """{"id":"s01","condition":"round:unnamed"},{"id":"s02","condition":"round:unnamed"}],""" +
                """"submission_open":true,"submission_registration":"2099-01-01","submission_done":"2099-01-02"}"""
        }
    }
}
