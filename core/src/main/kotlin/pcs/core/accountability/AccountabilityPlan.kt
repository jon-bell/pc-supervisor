package pcs.core.accountability

import pcs.core.nominations.Obligation
import pcs.core.nominations.Resolved
import pcs.core.readings.QId
import pcs.core.readings.Readings
import pcs.core.rules.AccFlow
import pcs.core.rules.Accountability
import pcs.core.rules.Conventions
import pcs.core.rules.Faults
import pcs.core.rules.ReqDisposition
import pcs.core.rules.Request
import pcs.core.rules.Share
import pcs.core.rules.Suggestion
import pcs.core.rules.Tier
import pcs.core.rules.Trace
import java.time.Duration
import java.time.Instant

/**
 * Progress by tier, the coaching queue, suggestions, requests, the engagement record and Accountability cases
 * (spec §10.4 D). A pure function of the mirror's rows ([AccInput]), the nominations report, the chairs' readings and the
 * clock. The decision rules are `Accountability` and `AccFlow` (checked against the Lean model); this file assembles inputs.
 *
 * Time in the rules is whole hours since the epoch, so a request's due date and its grace period compare as the model's do.
 */
public object AccountabilityPlan {
    private fun hours(i: Instant): Long = Math.floorDiv(i.epochSecond, 3600L)

    private fun isReviewer(r: AccReview) = r.rtype != 5 && r.round != "screen"

    public fun compute(
        input: AccInput,
        cfg: AccConfig,
        readings: Readings,
        obligations: List<Obligation>,
        f: Faults = Faults.NONE,
    ): AccountabilityReport {
        val now = input.now
        val notes = mutableListOf<String>()
        if (cfg.criteria.isEmpty()) notes += "The PC chairs have not set the criteria list (PCS_CRITERION_<n>), so no request can cite criteria (AR1)."
        val reviews = input.reviews.filter(::isReviewer)

        fun name(email: String) = input.names[email] ?: email

        fun group(email: String) = input.tiers.of(email).group
        val due = cfg.signal.reviewDue

        // ---- progress by tier, with the nominee view
        val progress =
            listOf("senior", "junior", "nominee").map { g ->
                val rs = reviews.filter { group(it.email) == g }
                val outstanding = rs.filter { it.status != "complete" }
                ProgressRow(
                    g,
                    rs.map { it.email }.distinct().size,
                    rs.size,
                    rs.size - outstanding.size,
                    outstanding.size,
                    if (due != null && now.isAfter(due)) outstanding.size else 0,
                )
            }
        val outstanding =
            reviews.filter { it.status != "complete" }.map {
                OutstandingReview(
                    it.email,
                    name(it.email),
                    group(it.email),
                    it.pid,
                    it.ordinal,
                    it.status,
                    if (due != null && now.isAfter(due)) Duration.between(due, now).toDays() else null,
                )
            }.sortedWith(compareByDescending<OutstandingReview> { it.lateDays ?: -1 }.thenBy { it.group }.thenBy { it.pid })

        // ---- how each complete review was dated (the owner's ruling, 2026-11-15): by HotCRP's timestamps; first-seen is a cross-check
        val dating = mutableListOf<String>()
        val intervalS = cfg.syncIntervalMin * 60
        val unknown = reviews.filter { it.submitted(due) == Submitted.Unknown }
        if (unknown.isNotEmpty()) {
            dating +=
                "${unknown.size} complete review(s) were revised after the review deadline, so HotCRP's original submission time is not in the mirror " +
                    "and they are not flagged late: read the review history (Backfill) to date them (" +
                    unknown.take(5).joinToString { "#${it.pid} ${it.ordinal ?: it.rid}" } + (if (unknown.size > 5) ", ..." else "") + ")."
        }
        val apart =
            reviews.mapNotNull { r ->
                val d = r.submitted(due) as? Submitted.At ?: return@mapNotNull null
                val seen = r.firstCompleteAt ?: return@mapNotNull null
                val diff = seen.epochSecond - d.at.epochSecond
                // the mirror saw it later than HotCRP says it was submitted; or, with the history read, earlier (a clock or sync problem)
                if (diff > intervalS || (d.exact && -diff > intervalS)) Triple(r, d.at, diff) else null
            }
        if (apart.isNotEmpty()) {
            dating +=
                "${apart.size} review(s) were first seen complete more than ${cfg.syncIntervalMin} minutes from HotCRP's own submission time; " +
                    "HotCRP's time is used for lateness (" +
                    apart.take(5).joinToString { (r, at, diff) ->
                        "#${r.pid} ${r.ordinal ?: r.rid}: HotCRP $at, first seen ${Duration.ofSeconds(diff).abs().toHours()} h ${if (diff > 0) "later" else "earlier"}"
                    } + (if (apart.size > 5) ", ..." else "") + ")."
        }

        // ---- metadata for the heuristics (AR3: nothing in it holds review text)
        val completeByPaper = reviews.filter { it.status == "complete" }.groupBy { it.pid }
        val metas =
            reviews.filter { it.status == "complete" }.map { r ->
                ReviewMeta(
                    r.pid,
                    r.rid,
                    r.ordinal,
                    r.email,
                    group(r.email),
                    true,
                    r.words,
                    r.merit,
                    completeByPaper[r.pid].orEmpty().filter { it.rid != r.rid }.mapNotNull { it.merit },
                    r.filled,
                    r.ratings,
                    (r.submitted(due) as? Submitted.At)?.at,
                )
            }

        // ---- coaching queue: junior and nominee reviews below the depth floor or rated short/vague
        val coaching =
            metas.filter { it.group != "senior" }.mapNotNull { m ->
                val reasons = Suggestions.signals(m, cfg.signal).filter { it.signal == "thin" || it.signal == "rated" }.map { it.reason }
                if (reasons.isEmpty()) {
                    null
                } else {
                    CoachingItem(m.pid, m.ordinal, m.reviewer, name(m.reviewer), m.group, m.words, reasons, m.pid in input.coachedPapers)
                }
            }.sortedWith(compareBy({ it.pid }, { it.ordinal.orEmpty() }))

        // ---- requests, from the tags a chair recorded (spec §11)
        val reviewByOrdinal = reviews.filter { it.ordinal != null }.associateBy { it.pid to it.ordinal!! }
        val seenByName = input.seen.associateBy { it.pid to it.name }
        val traces = input.paperTags.flatMap { (pid, tags) -> Conventions.decode(pid, tags) }
        val reminders = traces.filterIsInstance<Trace.Reminder>().associateBy { Triple(it.pid, it.ordinal, it.n) }
        val requests =
            traces.filterIsInstance<Trace.RequestSent>().mapNotNull { t ->
                val rv = reviewByOrdinal[t.pid to t.ordinal] ?: return@mapNotNull null
                val seen = seenByName[t.pid to "pcs-req-${t.ordinal}${t.n}"] ?: return@mapNotNull null
                val sentAt = Instant.ofEpochSecond(seen.firstSeenAt)
                val dueAt = sentAt.plus(Duration.ofHours(cfg.dueH))
                val remindedAt =
                    if (reminders.containsKey(Triple(t.pid, t.ordinal, t.n))) {
                        seenByName[t.pid to "pcs-remind-${t.ordinal}${t.n}"]?.let {
                            Instant.ofEpochSecond(it.firstSeenAt)
                        }
                    } else {
                        null
                    }
                val revised = rv.versionSeenAt.any { it > seen.firstSeenAt }
                val replied = revised || (t.disposition != null && t.disposition != ReqDisposition.NO_REPLY)
                val q = Request(0, sentBy = 1, due = hours(sentAt) + cfg.dueH, remindedAt = remindedAt?.let(::hours), replied = replied, disp = t.disposition)
                val nowH = hours(now)
                val noReplyFrom = remindedAt?.let { maxOf(it, dueAt.plus(Duration.ofHours(cfg.graceH))) }
                AccRequest(
                    t.pid,
                    t.ordinal,
                    t.n,
                    rv.email,
                    name(rv.email),
                    group(rv.email),
                    sentAt,
                    dueAt,
                    remindedAt,
                    revised,
                    t.disposition,
                    when {
                        t.disposition != null -> ReqStatus.DISPOSED
                        replied -> ReqStatus.REPLIED
                        remindedAt != null -> ReqStatus.REMINDED
                        else -> ReqStatus.SENT
                    },
                    AccFlow.mayRemind(q, nowH),
                    Accountability.mayDispose(q, ReqDisposition.NO_REPLY, nowH, cfg.graceH),
                    noReplyFrom,
                )
            }.sortedWith(compareBy({ it.pid }, { it.ordinal }, { it.n }))

        // ---- suggestions: signals on metadata, and what an AC or the junior PC chair asked for
        val requested = requests.map { it.pid to it.ordinal }.toSet()

        fun status(pid: Long, ord: String) =
            when {
                (pid to ord) in requested -> SuggestionStatus.SENT
                (pid to ord) in input.dismissed -> SuggestionStatus.DISMISSED
                else -> SuggestionStatus.OPEN
            }
        val heuristic =
            metas.filter { it.ordinal != null }.mapNotNull { m ->
                val fired = Suggestions.signals(m, cfg.signal)
                if (fired.isEmpty()) {
                    null
                } else {
                    ReqSuggestion(
                        m.pid,
                        m.ordinal!!,
                        m.reviewer,
                        name(m.reviewer),
                        m.group,
                        Source.HEURISTIC,
                        Suggestions.criteriaFor(fired, cfg.criteria),
                        fired.map { it.reason },
                        status(m.pid, m.ordinal),
                    )
                }
            }
        val manual =
            input.manual.mapNotNull { s ->
                val rv = reviewByOrdinal[s.pid to s.ordinal] ?: return@mapNotNull null
                ReqSuggestion(
                    s.pid,
                    s.ordinal,
                    rv.email,
                    name(rv.email),
                    group(rv.email),
                    s.source,
                    s.criteria.filter { c ->
                        cfg.criteria.any { it.id == c }
                    },
                    s.reasons,
                    status(s.pid, s.ordinal),
                )
            }
        val suggestions =
            (
                manual +
                    heuristic.filter { h ->
                        manual.none { it.pid == h.pid && it.ordinal == h.ordinal }
                    }
            ).sortedWith(compareBy({ it.pid }, { it.ordinal }))

        // ---- the engagement record (AR4): dispositions only; a dismissed suggestion is not an input
        val emails = (requests.map { it.reviewer } + suggestions.map { it.reviewer }).distinct().sorted()
        val id = emails.withIndex().associate { (i, e) -> e to (i + 1L) }
        // the model's view: a request a person sent, and (so the mutants are observable) a suggestion as a request nobody sent
        val modelReqs =
            requests.map { Request(id.getValue(it.reviewer), sentBy = 1, disp = it.disposition) } +
                suggestions.filter { it.status == SuggestionStatus.OPEN }.map { Request(id.getValue(it.reviewer), sentBy = null) }
        val modelSugs = suggestions.filter { it.status == SuggestionStatus.DISMISSED }.map { Suggestion(id.getValue(it.reviewer), dismissed = true) }
        val sentModel = Accountability.sentRequests(f, modelReqs)
        val pidsBy = requests.groupBy({ it.reviewer }, { it.pid })
        val engagement =
            emails.map { e ->
                val (engaged, not) = Accountability.engagement(f, modelReqs, modelSugs, id.getValue(e))
                val mine = sentModel.filter { it.reviewer == id.getValue(e) }
                Engagement(
                    e,
                    name(e),
                    group(e),
                    engaged,
                    not,
                    mine.count { it.disp == ReqDisposition.DISPUTED },
                    mine.count { it.disp == null },
                    mine.size,
                    pidsBy[e].orEmpty().distinct().sorted(),
                )
            }.filter { it.requests > 0 || it.engaged + it.notEngaged > 0 }

        // ---- Accountability cases about accepted nominees (Q11, Q20, X10)
        val nominees = obligations.filter { it.accepted }.sortedBy { it.email.lowercase() }
        val upheld = traces.filterIsInstance<Trace.Case>()
        val coachingByReviewer = coaching.groupBy { it.reviewer }
        val cases =
            nominees.mapIndexedNotNull { i, ob ->
                val email = ob.email.lowercase()
                val mine = reviews.filter { it.email == email }
                val missing = mine.any { it.status != "complete" } && due != null && now.isAfter(due)
                val quality = coachingByReviewer[email].orEmpty().isNotEmpty()
                val number = i + 1
                val tagged = upheld.filter { it.n == number }
                if (!missing && !quality && tagged.isEmpty()) return@mapIndexedNotNull null
                val myReqs = modelReqs.filter { it.reviewer == id[email] }
                val caseNotes = mutableListOf<String>()
                val owedSixths = ob.owes.decided
                val shares =
                    if (owedSixths != null) {
                        val per = ob.papers.size.coerceAtLeast(1)
                        var left = mine.count { it.status == "complete" } * 6
                        ob.papers.sorted().mapIndexed { k, p ->
                            val owed = owedSixths / per + if (k < owedSixths % per) 1 else 0
                            val done = minOf(left, owed)
                            left -= done
                            Share(p, owed, done)
                        }
                    } else {
                        caseNotes +=
                            "What this nominee owes turns on an unanswered question (Q18/Q19), so the papers listed are every paper that nominated them."
                        ob.papers.map { Share(it, 1, if (missing) 0 else 1) }
                    }
                val listed =
                    if (missing ||
                        shares.any { it.done < it.owed }
                    ) {
                        Accountability.unmetPapers(shares).ifEmpty { ob.papers.sorted() }
                    } else {
                        ob.papers.sorted()
                    }
                val status =
                    when {
                        tagged.any { it.outcome == 1 } -> CaseStatus.UPHELD
                        tagged.any { it.outcome == 2 } || input.caseRows[email] == "dismissed" -> CaseStatus.DISMISSED
                        input.caseRows[email] == "open" -> CaseStatus.OPEN
                        else -> CaseStatus.CANDIDATE
                    }
                AccCase(
                    ob.email,
                    name(ob.email),
                    number,
                    listed,
                    missing,
                    quality,
                    Resolved.of(readings, listOf(QId.Q20)) { r -> Accountability.caseMayOpen(f, r.q20!!, missing, myReqs) },
                    Resolved.of(readings, listOf(QId.Q11)) { r -> Accountability.consequence(r.q11!!) },
                    status,
                    caseNotes,
                )
            }
        return AccountabilityReport(progress, outstanding, coaching, suggestions, requests, engagement, cases, cfg.criteria, notes, input.acsByPaper, modelReqs, dating)
    }

    /** Which readings the report's cases turn on: Q11 (consequence), Q20 (quality needs a request), Q21 (the record's life). */
    public val QUESTIONS: List<QId> = listOf(QId.Q11, QId.Q20, QId.Q21)

    /** What happens to engagement records when the conference ends, under each reading of Q21 (C7). */
    public fun q21Outcome(readings: Readings): Resolved<String> =
        Resolved.of(readings, listOf(QId.Q21)) { r ->
            if (r.q21 == pcs.core.readings.Q21.THIS_CONFERENCE) "engagement records deleted" else "a summary goes to the next chairs"
        }

    /** Tier of a nominee, for tests and the view. */
    internal fun tierOf(t: PersonTier): Tier = t.tier
}
