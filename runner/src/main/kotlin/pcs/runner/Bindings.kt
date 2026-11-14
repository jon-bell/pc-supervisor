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
import pcs.core.earlyreject.EarlyRejectPlan
import pcs.core.earlyreject.ErConfig
import pcs.core.earlyreject.ErStatus
import pcs.core.earlyreject.ErWindow
import pcs.core.hotcrp.HotcrpClient
import pcs.core.readings.Q15
import pcs.core.readings.Q16
import pcs.core.readings.QId
import pcs.core.readings.Readings
import pcs.core.rules.Conventions
import pcs.core.rules.DeskReject
import pcs.core.rules.ERCase
import pcs.core.rules.EarlyReject
import pcs.core.rules.Faults
import pcs.core.rules.Ground
import pcs.core.rules.Opinion
import pcs.core.rules.Referral
import pcs.core.rules.Score
import pcs.core.rules.ScoreScale
import pcs.core.rules.Stage
import pcs.core.rules.Trace
import pcs.core.store.Store
import pcs.core.store.Sync
import pcs.core.time.Clock
import pcs.runner.model.AccountabilityRequestsAction
import pcs.runner.model.AppointmentAndAssignmentAction
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
import pcs.runner.model.EarlyRejectHotcrpObs
import pcs.runner.model.EarlyRejectRemove
import pcs.runner.model.EarlyRejectReview
import pcs.runner.model.EarlyRejectStateObs
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

    private var seconds = 0L

    fun advance(by: Long) {
        if (!faults.clockDoesNotAdvance) hours += by
    }

    /** A moment later, inside the same model hour: lets a reviewer's revision be seen after the sync that saw a request. */
    fun nudge(bySeconds: Long) {
        if (!faults.clockDoesNotAdvance) seconds += bySeconds
    }

    override fun now(): Instant = start.plusSeconds(hours * 3600 + seconds)

    fun modelHours(at: Instant = now()): Long = (at.epochSecond - start.epochSecond) / 3600
}

/** The file driver: generated files the process reads. The model's stage lives in a file until M6's phase model exists. */
class FileDriver(val dir: Path) {
    fun writeStage(pid: Long, stage: Stage) {
        Files.writeString(dir.resolve("process-$pid.json"), """{"stage":"${stage.key}"}""")
    }

    /** The early-reject window opened at this instant (epoch seconds): the chair's "open", written when the initial reviews are in. */
    fun writeWindow(pid: Long, openedAt: Long) {
        Files.writeString(dir.resolve("window-$pid.json"), """{"openedAt":$openedAt}""")
    }

    fun readWindow(pid: Long): Long? =
        dir.resolve("window-$pid.json").takeIf { Files.exists(it) }?.let {
            (Json.parseToJsonElement(Files.readString(it)) as JsonObject)["openedAt"]!!.jsonPrimitive.content.toLong()
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
        // the harness keeps HotCRP's rate limits: when the client has given up on a 429, wait a minute and sync again
        repeat(6) { attempt ->
            try {
                runBlocking { HotcrpClient(api.base, token, chunk = 100, strict = true).use { Sync(store, clock).run(it) } }
                return
            } catch (e: IllegalStateException) {
                if (attempt == 5 || e.message?.contains("HTTP 429") != true) throw e
                Thread.sleep(60_000)
            }
        }
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

    internal fun tryReview(email: String, fields: String): Boolean {
        val mine = api.reviews(pid, actas = email).firstOrNull { it.str("reviewer_email") == email }
        val r = mine?.str("rid") ?: "new"
        return api.ok(api.call("POST", "$pid/review", mapOf("r" to r), actas = email, json = fields))
    }

    private val acc by lazy { AccountabilityBinding(this) }

    /** Perform one model action through the bindings. */
    fun perform(a: ModelAction, role: String?): Outcome =
        when (a) {
            is DeskRejectAction -> desk(a, role)
            is EarlyRejectAction -> early(a, role)
            is AccountabilityRequestsAction -> acc.perform(a, role)
            is AppointmentAndAssignmentAction -> appointment.perform(a, role)
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
                outcome(
                    api.ok(
                        api.call(
                            "POST",
                            "$pid/tags",
                            form =
                                "addtags=" + java.net.URLEncoder.encode(Conventions.encode(Trace.RemedyDue(pid, due)), Charsets.UTF_8),
                        ),
                    ),
                )
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

    // ---- early reject (M17) ------------------------------------------------------------------

    private val earlyReviewers = mutableListOf<String>()
    private val earlyMerits = mutableMapOf<String, Int>()

    private val config: ErConfig get() = ErConfig(readings.q15 ?: Q15.entries.first(), readings.q16 ?: Q16.entries.first(), EARLY_SCALE)

    /** The window as `core` is told it: opened by the chair when the initial reviews are in; closed after [WINDOW_H] hours under a bump-window reading. */
    private fun window(): ErWindow? =
        files.readWindow(pid)?.let { open ->
            ErWindow(Instant.ofEpochSecond(open), if (config.q16 == Q16.BUMP_WINDOW) Instant.ofEpochSecond(open + WINDOW_H * 3600) else null)
        }

    private fun reviewerFor(role: String): String {
        val pool = if (role == "nominee") Persons.EARLY_NOMINEES else Persons.EARLY_PC_MEMBERS
        return pool.first { it !in earlyReviewers }
    }

    private fun early(a: EarlyRejectAction, role: String?): Outcome =
        when (a) {
            is EarlyRejectReview -> {
                clock.advance(1)
                val email = reviewerFor(role!!)
                val merit = EARLY_SCALE.meritOf(Score.ofKey(a.score)!!)!!
                check(api.ok(api.assign("""{"pid":$pid,"action":"pcreview","user":"$email"}""")))
                val ok = tryReview(email, """{"object":"review","OveMer":$merit,"RevExp":3,"PapSum":"$reviewText","status":"complete"}""")
                if (ok) {
                    earlyReviewers += email
                    earlyMerits[email] = merit
                    sync()
                    // the third initial review is in: the chair opens the window, and the mirror just synced is its snapshot
                    if (earlyReviewers.size == config.reviewsRequired && files.readWindow(pid) == null) files.writeWindow(pid, clock.now().epochSecond)
                }
                outcome(ok)
            }
            is EarlyRejectBump -> {
                // the reviewers were asked for a last word only while the window is open, and each bumps once
                val w = window()
                if (w == null ||
                    w.closedAt(clock.now()) ||
                    config.q16 != Q16.BUMP_WINDOW ||
                    EarlyRejectPlan.bumpedBy(store, config, w, clock.now(), pid).isNotEmpty()
                ) {
                    Outcome.REFUSED
                } else {
                    clock.advance(1)
                    val email = earlyReviewers.first()
                    val merit = earlyMerits.getValue(email).let { if (it < 4) it + 1 else it - 1 }
                    outcome(tryReview(email, """{"object":"review","OveMer":$merit,"status":"complete"}"""))
                }
            }
            is EarlyRejectCloseWindow -> {
                val w = window()
                val close = w?.close
                if (close == null || w.closedAt(clock.now())) {
                    Outcome.REFUSED
                } else {
                    clock.advance((close.epochSecond - clock.now().epochSecond) / 3600)
                    Outcome.EFFECTIVE
                }
            }
            is EarlyRejectRemove ->
                if (role == "pc-chair") {
                    sync()
                    val w = window()
                    val ready =
                        w != null &&
                            EarlyRejectPlan.compute(store, config, w, clock.now(), implFaults).candidates.any { it.pid == pid && it.status == ErStatus.READY }
                    if (ready) outcome(api.ok(api.call("POST", "$pid/decision", mapOf("decision" to "Reject")))) else Outcome.REFUSED
                } else {
                    outcome(api.ok(api.call("POST", "$pid/decision", mapOf("decision" to "Reject"), actas = userOf(role!!))))
                }
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
    val earlyHotcrp = EarlyHotcrpReader()
    val earlyState = EarlyStateReader()
    val appointment = AppointmentBinding(this)

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

        fun lastSync(): Instant =
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
                DeskRejectStateObs.NOW -> JsonPrimitive(clock.modelHours(lastSync()))
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

    /** What HotCRP holds for the early-reject subsystem, as a chair. */
    inner class EarlyHotcrpReader {
        fun read(o: EarlyRejectHotcrpObs): JsonElement =
            when (o) {
                EarlyRejectHotcrpObs.REVIEWS -> JsonPrimitive(api.reviews(pid).count { it.str("rtype") != "5" && it.str("status") == "complete" })
                EarlyRejectHotcrpObs.DISPOSITION -> JsonPrimitive(if (api.paper(pid).str("decision") == "Rejected") "early-rejected" else "in-review")
            }
    }

    /** What `core` derived for the early-reject subsystem: from its mirror after a sync, with the window as the chair opened it. */
    inner class EarlyStateReader {
        private fun now(): Instant = state.lastSync()

        /** The initial reviews: the snapshot at the opening once the window is open, else the reviews so far. */
        private fun scores(): List<Score> = EarlyRejectPlan.scoresAt(store, config, pid, window()?.open ?: now())

        private fun bumped(): Boolean = window()?.let { EarlyRejectPlan.bumpedBy(store, config, it, now(), pid).isNotEmpty() } ?: false

        private fun closed(): Boolean = window()?.closedAt(now()) ?: false

        fun read(o: EarlyRejectStateObs): JsonElement =
            when (o) {
                EarlyRejectStateObs.REVIEWS ->
                    JsonPrimitive(
                        store.conn.createStatement().use { st ->
                            st.executeQuery("SELECT count(*) FROM review WHERE pid = $pid AND rtype != 5 AND status = 'complete' AND gone_at IS NULL").use {
                                it.next()
                                it.getInt(1)
                            }
                        },
                    )
                EarlyRejectStateObs.SCORES -> JsonArray(scores().map { JsonPrimitive(it.key) })
                EarlyRejectStateObs.CANDIDATE ->
                    JsonPrimitive(window()?.let { w -> EarlyRejectPlan.compute(store, config, w, now()).candidates.any { it.pid == pid } } ?: false)
                EarlyRejectStateObs.BUMPED -> JsonPrimitive(bumped())
                EarlyRejectStateObs.WINDOW_CLOSED -> JsonPrimitive(closed())
                EarlyRejectStateObs.MAY_EARLY_REJECT ->
                    JsonPrimitive(
                        EarlyReject.mayEarlyReject(
                            implFaults,
                            config.q15,
                            config.q16,
                            ERCase(scores(), bumped(), closed(), EarlyRejectPlan.objects(store, pid)),
                        ),
                    )
                EarlyRejectStateObs.DISPOSITION ->
                    JsonPrimitive(
                        store.conn.createStatement().use { st ->
                            st.executeQuery("SELECT decision FROM paper WHERE pid = $pid").use { if (it.next()) it.getString(1) else null }
                        }.let { if (it == "Rejected") "early-rejected" else "in-review" },
                    )
            }
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

    /** Every observation of [subsystem], from every reader the model names for it. */
    fun observe(subsystem: String = "desk reject"): JsonObject {
        if (subsystem == "early reject") return observeEarly()
        if (subsystem == "appointment and assignment") return appointment.observe()
        if (subsystem == "accountability requests") return acc.observe()
        return observeDesk()
    }

    private fun observeEarly(): JsonObject {
        val by = linkedMapOf<String, MutableMap<String, JsonElement>>()

        fun put(key: String, reader: String, v: JsonElement) {
            by.getOrPut(key) { linkedMapOf() }[reader] = v
        }
        sync()
        EarlyRejectHotcrpObs.entries.forEach { put(it.key, "hotcrp", earlyHotcrp.read(it)) }
        EarlyRejectStateObs.entries.forEach { put(it.key, "state", earlyState.read(it)) }
        return JsonObject(by.mapValues { (_, m) -> JsonObject(m) })
    }

    private fun observeDesk(): JsonObject {
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
        /** The runner's review form reads merit 1-4 as reject, weak reject, borderline, accept (a venue's `PCS_SCORE_MAP`). */
        val EARLY_SCALE = ScoreScale(mapOf(1 to Score.REJECT, 2 to Score.WEAK_REJECT, 3 to Score.BORDERLINE, 4 to Score.ACCEPT, 5 to Score.STRONG_ACCEPT))

        /** Q16's last-word window, in model hours. */
        const val WINDOW_H = 48L

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
