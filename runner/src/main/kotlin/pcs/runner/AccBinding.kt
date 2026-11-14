package pcs.runner

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import pcs.core.accountability.AccConfig
import pcs.core.accountability.AccDrafts
import pcs.core.accountability.AccLoader
import pcs.core.accountability.AccLocal
import pcs.core.accountability.AccountabilityPlan
import pcs.core.accountability.AccountabilityReport
import pcs.core.accountability.Criterion
import pcs.core.accountability.ManualSuggestion
import pcs.core.accountability.Source
import pcs.core.accountability.SuggestionStatus
import pcs.core.accountability.Tiers
import pcs.core.readings.Q20
import pcs.core.rules.Accountability
import pcs.core.rules.Conventions
import pcs.core.rules.ReqDisposition
import pcs.core.rules.Request
import pcs.core.rules.Trace
import pcs.core.writeback.Artifact
import pcs.core.writeback.Writeback
import pcs.runner.model.AccountabilityRequestsAction
import pcs.runner.model.AccountabilityRequestsClockObs
import pcs.runner.model.AccountabilityRequestsCoach
import pcs.runner.model.AccountabilityRequestsDismiss
import pcs.runner.model.AccountabilityRequestsDispose
import pcs.runner.model.AccountabilityRequestsHotcrpObs
import pcs.runner.model.AccountabilityRequestsOpenCase
import pcs.runner.model.AccountabilityRequestsRemind
import pcs.runner.model.AccountabilityRequestsReply
import pcs.runner.model.AccountabilityRequestsSend
import pcs.runner.model.AccountabilityRequestsSetCriteria
import pcs.runner.model.AccountabilityRequestsStateObs
import pcs.runner.model.AccountabilityRequestsSuggest
import pcs.runner.model.AccountabilityRequestsTick
import pcs.runner.model.AccountabilityRequestsUphold
import java.time.Instant

/**
 * The accountability subsystem's bindings (PLAN §A4, M16). One paper, one reviewer (the model's person 7) whose review the
 * request is about. A person's action is that user's HotCRP call; a chair's UI action is `core` standing in, through
 * Writeback (a chair records the request tag after sending the mail, which PC Supervisor never sends); a heuristic
 * suggestion is what `core` derives from the review's metadata; a dismissal and a case's status are the local records.
 * A role with no way to act in HotCRP or in PC Supervisor is refused, and a role HotCRP knows is let try (forged traces, T6).
 */
class AccountabilityBinding(private val w: World) {
    private val api get() = w.api
    private val pid get() = w.pid

    // ---- the process files: the chairs' criteria list is a settings file the chair edits ----------------

    private val criteriaFile get() = w.files.dir.resolve("criteria-$pid.json")

    private val criteria: List<Criterion> =
        listOf(
            Criterion(1, "backs each weakness with evidence", setOf("thin")),
            Criterion(2, "tells the authors what would change the reviewer's mind", setOf("thin", "rated")),
        )

    private fun criteriaSet() = java.nio.file.Files.exists(criteriaFile)

    private fun config() = AccConfig(if (criteriaSet()) criteria else emptyList())

    /** The HotCRP user a role acts as in an attempt that HotCRP can refuse, or null when nobody could even try. */
    private fun hotcrpUser(role: String): String? =
        when (role) {
            "ac", "junior-pc-chair" -> Persons.AC_REFERRING
            "nominee" -> Persons.ACC_REVIEWER
            "pc-member" -> Persons.PC_MEMBER_OUTSIDER
            "author" -> w.author
            else -> null
        }

    // ---- derived state ----------------------------------------------------------------------------

    private fun report(): AccountabilityReport {
        w.sync()
        // the world holds one paper; the shared harness holds many, and the model's state is about this one
        val all = AccLoader.load(w.store, w.clock.now(), Tiers(emptyMap()), "OveMer")
        val input =
            all.copy(
                reviews = all.reviews.filter { it.pid == pid },
                paperTags = all.paperTags.filterKeys { it == pid },
                seen = all.seen.filter { it.pid == pid },
                dismissed = all.dismissed.filter { it.first == pid }.toSet(),
                manual = all.manual.filter { it.pid == pid },
            )
        return AccountabilityPlan.compute(input, config(), w.readings, emptyList(), w.implFaults)
    }

    private fun reviewOrdinal(): String? =
        w.store.conn.createStatement().use { st ->
            st.executeQuery("SELECT ordinal FROM review WHERE pid = $pid AND email = '${Persons.ACC_REVIEWER}' AND gone_at IS NULL AND ordinal IS NOT NULL").use { if (it.next()) it.getString(1) else null }
        }

    private fun reviewWords(): Int =
        w.store.conn.createStatement().use { st ->
            st.executeQuery("SELECT word_count FROM review WHERE pid = $pid AND email = '${Persons.ACC_REVIEWER}' AND gone_at IS NULL").use { if (it.next()) it.getInt(1) else 0 }
        }

    private fun chairTags(): List<Trace> = Conventions.decode(pid, api.call("GET", "$pid/tags")["tags"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty())

    private fun mirrorTags(): List<Trace> =
        w.store.conn.createStatement().use { st ->
            st.executeQuery("SELECT tags FROM paper WHERE pid = $pid").use { if (it.next()) it.getString(1) else "[]" }
        }.let { Conventions.decode(pid, Json.parseToJsonElement(it).jsonArray.map { t -> t.jsonPrimitive.content }) }

    private fun key(d: ReqDisposition?): String =
        when (d) {
            null -> "none"
            ReqDisposition.REVISED -> "revised"
            ReqDisposition.EXPLAINED -> "explained"
            ReqDisposition.DECLINED -> "declined"
            ReqDisposition.NO_REPLY -> "no-reply"
            ReqDisposition.DISPUTED -> "disputed"
        }

    private fun nowH() = w.clock.modelHours()

    /** The reviewer's review, written by that user: thin (a heuristic fires) or substantial (none does). */
    private fun ensureReview(thin: Boolean) {
        if (reviewOrdinal() != null) return
        val words = if (thin) 20 else 200
        val text = "Synthetic review text. " + (1..words).joinToString(" ") { "word$it" }
        check(api.ok(api.assign("""{"pid":$pid,"action":"pcreview","user":"${Persons.ACC_REVIEWER}"}""")))
        check(w.tryReview(Persons.ACC_REVIEWER, """{"object":"review","OveMer":3,"RevExp":3,"PapSum":"$text","status":"complete"}"""))
        w.sync()
    }

    private fun record(a: Artifact) {
        val wb = Writeback(w.store, w.clock, api.base, w.token)
        val id = wb.draft(a)
        wb.dryRun(id)
        wb.confirm(id)
        wb.apply(id)
        w.sync()
    }

    private fun outcome(ok: Boolean) = if (ok) Outcome.EFFECTIVE else Outcome.REFUSED

    /** A hidden-tag write attempted as a user who is not a chair: HotCRP refuses it (spec §11, forged traces). */
    private fun forged(role: String, tag: String): Outcome {
        val user = hotcrpUser(role) ?: return Outcome.REFUSED
        return outcome(api.ok(api.call("POST", "$pid/tags", actas = user, form = "addtags=" + java.net.URLEncoder.encode(tag, Charsets.UTF_8))))
    }

    private fun isPerson(role: String?) = role == "ac" || role == "junior-pc-chair"

    // ---- actions ----------------------------------------------------------------------------------

    fun perform(a: AccountabilityRequestsAction, role: String?): Outcome =
        when (a) {
            is AccountabilityRequestsSetCriteria ->
                if (role == "pc-chair" && !criteriaSet()) {
                    java.nio.file.Files.writeString(criteriaFile, "[1,2]")
                    Outcome.EFFECTIVE
                } else {
                    Outcome.REFUSED
                }
            is AccountabilityRequestsSuggest -> suggest(role!!)
            is AccountabilityRequestsDismiss -> {
                val s = if (role in setOf("ac", "junior-pc-chair", "pcs")) report().suggestions.firstOrNull() else null
                if (s != null && s.status == SuggestionStatus.OPEN) {
                    AccLocal.dismiss(w.store, s.pid, s.ordinal, role, w.clock.now())
                    Outcome.EFFECTIVE
                } else {
                    Outcome.REFUSED
                }
            }
            is AccountabilityRequestsCoach ->
                if (isPerson(role) && !coached()) {
                    outcome(api.ok(api.call("POST", "$pid/comment", actas = Persons.AC_REFERRING, json = """{"text":"Synthetic coaching note for the reviewers.","visibility":"rev"}""")).also { w.sync() })
                } else {
                    Outcome.REFUSED
                }
            is AccountabilityRequestsSend -> send(role!!)
            is AccountabilityRequestsRemind -> remind(role!!)
            is AccountabilityRequestsReply -> reply(role!!)
            is AccountabilityRequestsDispose -> dispose(ReqDisposition.valueOf(a.disposition.uppercase().replace('-', '_')), role!!)
            is AccountabilityRequestsTick ->
                if (nowH() < 200) {
                    w.clock.advance(50)
                    Outcome.EFFECTIVE
                } else {
                    Outcome.REFUSED
                }
            is AccountabilityRequestsOpenCase -> {
                val r = report()
                val may = Accountability.caseMayOpen(w.implFaults, w.readings.q20 ?: Q20.entries.first(), false, r.modelRequests)
                if ((role == "pcs" || role == "process-chair") && !caseOpen() && may) {
                    AccLocal.setCase(w.store, Persons.ACC_REVIEWER, "open", w.clock.now())
                    Outcome.EFFECTIVE
                } else {
                    Outcome.REFUSED
                }
            }
            is AccountabilityRequestsUphold ->
                when {
                    role == "pc-chair" ->
                        if (caseOpen() && mirrorTags().none { it is Trace.Case && it.outcome == 1 }) {
                            record(AccDrafts.recordCase(listOf(pid), 1, upheld = true))
                            Outcome.EFFECTIVE
                        } else {
                            Outcome.REFUSED
                        }
                    else -> forged(role!!, "~~pcs-case-1#1")
                }
        }

    private fun coached(): Boolean = w.store.conn.createStatement().use { st ->
        st.executeQuery("SELECT count(*) FROM comment WHERE pid = $pid AND visibility = 'rev' AND lower(email) = '${Persons.AC_REFERRING}' AND deleted_seen_at IS NULL").use {
            it.next()
            it.getInt(1) > 0
        }
    }

    private fun caseOpen(): Boolean = w.store.conn.createStatement().use { st ->
        st.executeQuery("SELECT status FROM acc_case WHERE nominee = '${Persons.ACC_REVIEWER}'").use { it.next() && it.getString(1) == "open" }
    }

    private fun suggest(role: String): Outcome {
        val before = report().suggestions.firstOrNull()
        return when (role) {
            "pcs" -> {
                if (before != null) return Outcome.REFUSED
                ensureReview(thin = true)
                outcome(report().suggestions.isNotEmpty())
            }
            "ac", "junior-pc-chair" -> {
                if (before != null) return Outcome.REFUSED
                ensureReview(thin = false)
                AccLocal.suggest(
                    w.store,
                    ManualSuggestion(pid, reviewOrdinal()!!, if (role == "ac") Source.AC else Source.JUNIOR_PC_CHAIR, listOf(1), listOf("the AC asked for a request")),
                    w.clock.now(),
                )
                Outcome.EFFECTIVE
            }
            else -> Outcome.REFUSED
        }
    }

    private fun send(role: String): Outcome {
        if (!isPerson(role)) return forged(role, "pcs-req-C1#0")
        if (!criteriaSet() || report().requests.isNotEmpty()) return Outcome.REFUSED
        ensureReview(thin = false)
        record(AccDrafts.recordSent(pid, reviewOrdinal()!!))
        return Outcome.EFFECTIVE
    }

    private fun remind(role: String): Outcome {
        if (!isPerson(role)) return forged(role, "pcs-remind-C1")
        val req = report().requests.firstOrNull() ?: return Outcome.REFUSED
        if (!req.mayRemind || req.remindedAt != null || req.revised) return Outcome.REFUSED
        record(AccDrafts.recordReminder(pid, req.ordinal, req.n))
        return Outcome.EFFECTIVE
    }

    /** The reviewer answers by revising the review; the request's first-seen time is a sync earlier, so the revision is seen after it. */
    private fun reply(role: String): Outcome {
        if (role == "nominee" || role == "pc-member") {
            val req = report().requests.firstOrNull() ?: return Outcome.REFUSED
            if (req.revised || req.disposition != null) return Outcome.REFUSED
            w.clock.nudge(60)
            // a revision keeps the review in the size class it was in, so a heuristic that fired still fires
            val thin = reviewWords() < 150
            val text = "Synthetic revised review. " + (1..(if (thin) 8 else 230)).joinToString(" ") { "extra$it" }
            val ok = w.tryReview(Persons.ACC_REVIEWER, """{"object":"review","PapSum":"$text","status":"complete"}""")
            w.sync()
            return outcome(ok)
        }
        // anyone else tries to change the review as themselves
        val user = hotcrpUser(role) ?: return Outcome.REFUSED
        return outcome(w.tryReview(user, """{"object":"review","PapSum":"Synthetic forged revision.","status":"complete"}"""))
    }

    private fun dispose(d: ReqDisposition, role: String): Outcome {
        if (!isPerson(role)) return forged(role, "pcs-req-C1#${Conventions.DISPOSITION_CODES.entries.first { it.value == d }.key}")
        val req = report().requests.firstOrNull() ?: return Outcome.REFUSED
        val q = Request(7, 1, due = hoursOf(req.due), remindedAt = req.remindedAt?.let(::hoursOf), replied = repliedFor(req), disp = null)
        if (req.disposition != null || !Accountability.mayDispose(q, d, Math.floorDiv(w.clock.now().epochSecond, 3600L))) return Outcome.REFUSED
        record(AccDrafts.recordDisposition(pid, req.ordinal, req.n, d))
        return Outcome.EFFECTIVE
    }

    private fun hoursOf(i: Instant) = Math.floorDiv(i.epochSecond, 3600L)

    /** The model's `replied`: the reviewer revised, or a reply was accepted (a disposition other than "no reply"). */
    private fun repliedFor(r: pcs.core.accountability.AccRequest) = r.revised || (r.disposition != null && r.disposition != ReqDisposition.NO_REPLY)

    // ---- readers ----------------------------------------------------------------------------------

    private fun state(o: AccountabilityRequestsStateObs, r: AccountabilityReport): JsonElement {
        val req = r.requests.firstOrNull()
        val eng = r.engagement.firstOrNull()
        return when (o) {
            AccountabilityRequestsStateObs.CRITERIA_SET -> JsonPrimitive(criteriaSet())
            AccountabilityRequestsStateObs.SUGGESTION ->
                JsonPrimitive(
                    when (r.suggestions.firstOrNull()?.status) {
                        null -> "none"
                        SuggestionStatus.DISMISSED -> "dismissed"
                        else -> "open"
                    },
                )
            AccountabilityRequestsStateObs.COACHED -> JsonPrimitive(coached())
            AccountabilityRequestsStateObs.SENT -> JsonPrimitive(eng != null && eng.requests > 0)
            AccountabilityRequestsStateObs.REMINDED -> JsonPrimitive(req?.remindedAt != null)
            AccountabilityRequestsStateObs.REPLIED -> JsonPrimitive(req != null && repliedFor(req))
            AccountabilityRequestsStateObs.DISPOSITION -> JsonPrimitive(key(req?.disposition))
            AccountabilityRequestsStateObs.NOW -> JsonPrimitive(nowH())
            AccountabilityRequestsStateObs.MAY_NO_REPLY ->
                JsonPrimitive(req != null && Accountability.mayDispose(Request(7, 1, hoursOf(req.due), req.remindedAt?.let(::hoursOf), repliedFor(req), null), ReqDisposition.NO_REPLY, Math.floorDiv(w.clock.now().epochSecond, 3600L)))
            AccountabilityRequestsStateObs.ENGAGED -> JsonPrimitive(eng?.engaged ?: 0)
            AccountabilityRequestsStateObs.NOT_ENGAGED -> JsonPrimitive(eng?.notEngaged ?: 0)
            AccountabilityRequestsStateObs.CASE_MAY_OPEN ->
                JsonPrimitive(Accountability.caseMayOpen(w.implFaults, w.readings.q20 ?: Q20.entries.first(), false, r.modelRequests))
            AccountabilityRequestsStateObs.CASE_OPEN -> JsonPrimitive(caseOpen())
            AccountabilityRequestsStateObs.CASE_UPHELD -> JsonPrimitive(mirrorTags().any { it is Trace.Case && it.outcome == 1 })
        }
    }

    private fun hotcrp(o: AccountabilityRequestsHotcrpObs, tags: List<Trace>): JsonElement =
        when (o) {
            AccountabilityRequestsHotcrpObs.COACHED ->
                JsonPrimitive(
                    api.call("GET", "$pid/comments")["comments"]?.jsonArray.orEmpty().any {
                        val c = it as JsonObject
                        c.str("visibility") == "rev" && c.str("author_email")?.lowercase() == Persons.AC_REFERRING
                    },
                )
            AccountabilityRequestsHotcrpObs.SENT -> JsonPrimitive(tags.any { it is Trace.RequestSent })
            AccountabilityRequestsHotcrpObs.REMINDED -> JsonPrimitive(tags.any { it is Trace.Reminder })
            AccountabilityRequestsHotcrpObs.DISPOSITION -> JsonPrimitive(key(tags.filterIsInstance<Trace.RequestSent>().firstOrNull()?.disposition))
            AccountabilityRequestsHotcrpObs.CASE_UPHELD -> JsonPrimitive(tags.any { it is Trace.Case && it.outcome == 1 })
        }

    fun observe(): JsonObject {
        val by = linkedMapOf<String, MutableMap<String, JsonElement>>()

        fun put(key: String, reader: String, v: JsonElement) {
            by.getOrPut(key) { linkedMapOf() }[reader] = v
        }
        val r = report()
        AccountabilityRequestsStateObs.entries.forEach { put(it.key, "state", state(it, r)) }
        val tags = chairTags()
        AccountabilityRequestsHotcrpObs.entries.forEach { put(it.key, "hotcrp", hotcrp(it, tags)) }
        AccountabilityRequestsClockObs.entries.forEach { put(it.key, "clock", JsonPrimitive(nowH())) }
        return JsonObject(by.mapValues { (_, m) -> JsonObject(m) })
    }
}
