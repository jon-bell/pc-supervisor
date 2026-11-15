package net.jonbell.pcs.core.report

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.core.accountability.Tiers
import net.jonbell.pcs.core.discussion.DiscussionReports
import net.jonbell.pcs.core.discussion.DiscussionState
import net.jonbell.pcs.core.earlyreject.ErStatus
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.nominations.Decision
import net.jonbell.pcs.core.nominations.NominationData
import net.jonbell.pcs.core.nominations.Resolved
import net.jonbell.pcs.core.rules.Stage
import net.jonbell.pcs.core.rules.TriageChoice
import net.jonbell.pcs.core.session.EarlyRejectState
import net.jonbell.pcs.core.session.Session
import net.jonbell.pcs.core.store.query
import net.jonbell.pcs.core.triage.TriageReport
import net.jonbell.pcs.core.triage.TriageStatus
import net.jonbell.pcs.core.triage.triage
import java.time.Instant

/*
 * The process report (spec §10.4 G): what the conference's process did, as counts, timings and rule outcomes. It is assembled from what the
 * modules already compute (nominations, screening, assignment, reviewing progress, accountability, early reject, discussion) and holds no
 * person, no title, and no review or comment text: a section is a few small tables of numbers and enumerated labels. A part that cannot be
 * computed yet says why, and is never filled in with a default.
 */

public data class ReportTable(val title: String, val header: List<String>, val rows: List<List<String>>)

/** One module's part of the report; [available] is false (with [note]) when the module cannot be computed yet. */
public data class ReportSection(val id: String, val title: String, val available: Boolean, val note: String?, val tables: List<ReportTable>)

public data class ProcessReport(val now: Instant, val asOf: Instant?, val sections: List<ReportSection>) {
    public fun section(id: String): ReportSection = sections.first { it.id == id }
}

public object ProcessReports {
    private fun median(xs: List<Number>): Double? =
        if (xs.isEmpty()) {
            null
        } else {
            xs.map { it.toDouble() }.sorted().let { if (it.size % 2 == 1) it[it.size / 2] else (it[it.size / 2 - 1] + it[it.size / 2]) / 2 }
        }

    internal fun num(d: Double?): String = d?.let { if (it == Math.rint(it)) it.toLong().toString() else "%.1f".format(java.util.Locale.ROOT, it) } ?: "n/a"

    private fun pct(a: Int, b: Int): String = if (b == 0) "n/a" else "%.1f%%".format(java.util.Locale.ROOT, 100.0 * a / b)

    private fun count(title: String, key: String, m: Map<String, Int>) =
        ReportTable(
            title,
            listOf(key, "count"),
            m.toSortedMap().map {
                listOf(it.key, it.value.toString())
            },
        )

    private fun open(id: String, title: String, why: String) = ReportSection(id, title, false, why, emptyList())

    private fun <T> Resolved<T>.label(show: (T) -> String): String =
        when (this) {
            is Resolved.Decided -> show(value)
            is Resolved.Open -> "open (${by.joinToString { it.code }})"
        }

    public fun build(s: Session): ProcessReport =
        ProcessReport(
            s.clock.now(),
            s.lastSync()?.finishedAt,
            listOf(overview(s), nominations(s), screening(s), assignment(s), progress(s), accountability(s), earlyReject(s), discussion(s)),
        )

    private fun overview(s: Session): ReportSection {
        val c = s.store.conn

        fun n(sql: String) = c.query(sql) { it.getInt(1) }.single()
        val decisions =
            c.query("SELECT coalesce(decision, 'undecided'), count(*) FROM paper WHERE gone_at IS NULL GROUP BY 1") {
                it.getString(1) to
                    it.getInt(2)
            }.toMap()
        return ReportSection(
            "overview",
            "Overview",
            true,
            null,
            listOf(
                ReportTable(
                    "Mirror",
                    listOf("what", "count"),
                    listOf(
                        listOf("papers", n("SELECT count(*) FROM paper WHERE gone_at IS NULL").toString()),
                        listOf("people", n("SELECT count(*) FROM person WHERE gone_at IS NULL").toString()),
                        listOf("reviews (non-AC)", n("SELECT count(*) FROM review WHERE gone_at IS NULL AND rtype <> 5").toString()),
                        listOf("metareviews", n("SELECT count(*) FROM review WHERE gone_at IS NULL AND rtype = 5").toString()),
                        listOf("comments", n("SELECT count(*) FROM comment WHERE deleted_seen_at IS NULL AND draft = 0").toString()),
                    ),
                ),
                count("Papers by decision", "decision", decisions),
            ),
        )
    }

    private fun nominations(s: Session): ReportSection {
        val sheet = Imports(s.store, s.clock).latest(net.jonbell.pcs.core.imports.ImportKind.APPOINTMENTS)
        if (sheet == null) return open("nominations", "Nominations and appointments", "no appointments import yet")
        val r =
            runCatching { NominationData(s.store, Imports(s.store, s.clock)).report(s.answers().readings, venue = s.settings.venue) }
                .getOrElse { return open("nominations", "Nominations and appointments", "cannot be computed: ${it.javaClass.simpleName}") }
        val input = NominationData(s.store, Imports(s.store, s.clock)).input()
        val compliance = r.papers.groupingBy { it.compliance.label { c -> c.name.lowercase().replace('_', '-') } }.eachCount()
        val sheetRows = input.sheet
        val decided = sheetRows.count { it.decision != Decision.PENDING }
        val accepted = sheetRows.count { it.decision == Decision.ACCEPT }
        val declined = sheetRows.count { it.decision == Decision.DECLINE }
        val byOrigin = sheetRows.groupBy { it.origin }.toSortedMap()
        val onPc = sheetRows.count { it.onPcAt.isNotBlank() }
        return ReportSection(
            "nominations",
            "Nominations and appointments",
            true,
            null,
            listOf(
                count("Papers by nomination compliance (Q8)", "outcome", compliance),
                ReportTable(
                    "Candidates",
                    listOf("origin", "candidates", "accepted", "declined", "pending"),
                    byOrigin.map { (o, cs) ->
                        listOf(
                            o.ifBlank { "unknown" },
                            cs.size.toString(),
                            cs.count { it.decision == Decision.ACCEPT }.toString(),
                            cs.count { it.decision == Decision.DECLINE }.toString(),
                            cs.count { it.decision == Decision.PENDING }.toString(),
                        )
                    },
                ),
                ReportTable(
                    "Acceptance and dropout",
                    listOf("measure", "value"),
                    listOf(
                        listOf("decided candidates", decided.toString()),
                        listOf("acceptance rate (accepted of decided)", pct(accepted, decided)),
                        listOf("dropout rate (declined of decided)", pct(declined, decided)),
                        listOf("candidates on the PC", onPc.toString()),
                        listOf("nominators seen as a pattern (Q9)", r.patterns.size.toString()),
                        listOf("authors over the cap (Q17)", r.capCases.label { it.size.toString() }),
                        listOf("sheet anomalies", r.anomalies.size.toString()),
                    ),
                ),
            ),
        )
    }

    private fun screening(s: Session): ReportSection {
        val c = s.store.conn
        val desk = c.query("SELECT count(*) FROM paper WHERE gone_at IS NULL AND lower(coalesce(decision,'')) LIKE '%desk%'") { it.getInt(1) }.single()
        val triage = triageOutcomes(s)
        val protocol = HashMap<String, Int>()
        c.query("SELECT tags FROM paper WHERE gone_at IS NULL") { r ->
            Json.parseToJsonElement(r.getString(1)).jsonArray.map { it.jsonPrimitive.content.substringBefore('#') }.filter {
                it.startsWith("pcs-") ||
                    it.startsWith("~~pcs-")
            }
        }.flatten().forEach { t -> protocol.merge(t.replace(Regex("[0-9]+$"), "<n>"), 1, Int::plus) }
        return ReportSection(
            "screening",
            "Screening and desk reject",
            true,
            triage.note,
            listOf(
                ReportTable("Desk rejects", listOf("measure", "value"), listOf(listOf("papers with a desk-reject decision", desk.toString()))),
                count("Papers carrying PC Supervisor tags", "tag", protocol),
            ) + triage.tables,
        )
    }

    private class TriagePart(val note: String?, val tables: List<ReportTable>)

    /** Triage outcomes as counts of enumerated labels (status, ground, stage, reading); never a pid, title, person or text. */
    private fun triageOutcomes(s: Session): TriagePart =
        when (val t = s.triage()) {
            is TriageReport.Blocked ->
                TriagePart("Triage outcomes are not computed: ${t.reasons.size} of the questions they depend on are unresolved.", emptyList())
            is TriageReport.Ready -> {
                val rows = t.rows
                val q3 = s.answers().readings.q3?.key ?: "unresolved"
                val choice = rows.mapNotNull { it.facts?.choice }
                val removed = rows.filter { it.status == TriageStatus.REMOVED }
                val outcomes =
                    listOf(
                        "papers in the triage queue" to rows.size,
                        "kept by the AC" to choice.count { it is TriageChoice.Keep },
                        "referred by the AC" to choice.count { it is TriageChoice.Refer },
                        "referred, with a second opinion given" to rows.count { r -> r.facts?.opinions?.any { !it.isAcNote } == true },
                        "second opinion requested, not yet given" to rows.count { it.status == TriageStatus.OPINION_PENDING },
                        "referred, second opinion still to ask for" to rows.count { it.status == TriageStatus.NEEDS_SECOND_OPINION },
                        "removed (desk rejected)" to removed.size,
                    )
                TriagePart(
                    null,
                    listOf(
                        ReportTable("Triage outcomes", listOf("measure", "papers"), outcomes.map { listOf(it.first, it.second.toString()) }),
                        count("Triage status of each queued paper", "status", rows.groupingBy { it.status.label }.eachCount()),
                        count("Referrals by ground", "ground", rows.mapNotNull { it.facts?.ground?.key }.groupingBy { it }.eachCount()),
                        count("Removed by ground", "ground", removed.mapNotNull { it.grounds.firstOrNull()?.key }.groupingBy { it }.eachCount()),
                        ReportTable(
                            "Timing of removals (Q3 reading: $q3)",
                            listOf("measure", "papers"),
                            Stage.entries.map { st -> listOf("removed at the ${st.key} stage", removed.count { it.stage == st }.toString()) } +
                                listOf(listOf("removed late (after the desk-reject date)", removed.count { it.late }.toString())),
                        ),
                    ),
                )
            }
        }

    private fun groups(s: Session): (String) -> String {
        val c = s.store.conn
        val tags =
            c.query("SELECT lower(email), tags FROM person WHERE gone_at IS NULL") {
                it.getString(1) to Json.parseToJsonElement(it.getString(2)).jsonArray.map { t -> t.jsonPrimitive.content }
            }.toMap()
        val sheet = NominationData(s.store, Imports(s.store, s.clock)).input().sheet
        val tiers = Tiers.build(sheet, tags, s.settings.tierTags)
        return { tiers.of(it).group }
    }

    private class Rev(val pid: Long, val who: String, val group: String, val complete: Boolean, val words: Int, val ratings: List<String>, val merit: Int?)

    private fun reviews(s: Session): List<Rev> {
        val g = groups(s)
        val merit = s.settings.fieldMerit
        return s.store.conn.query(
            "SELECT pid, email, status, word_count, ratings, scores FROM review WHERE gone_at IS NULL AND rtype <> 5 AND email IS NOT NULL",
        ) { r ->
            Rev(
                r.getLong(1),
                r.getString(2).lowercase(),
                g(r.getString(2)),
                r.getString(3) == "complete",
                r.getInt(4),
                Json.parseToJsonElement(r.getString(5)).jsonArray.map { it.jsonPrimitive.content },
                runCatching {
                    Json.parseToJsonElement(r.getString(6)).let { e ->
                        (e as kotlinx.serialization.json.JsonObject)[merit]?.jsonPrimitive?.content?.toIntOrNull()
                    }
                }.getOrNull(),
            )
        }
    }

    private fun assignment(s: Session): ReportSection {
        val rs = reviews(s)
        val papers = s.store.conn.query("SELECT count(*) FROM paper WHERE gone_at IS NULL") { it.getInt(1) }.single()
        val perPaper = rs.groupBy { it.pid }.mapValues { it.value.size }
        val dist =
            (0..perPaper.values.maxOrNull().let { it ?: 0 }).associate { k ->
                k.toString() to
                    (if (k == 0) papers - perPaper.size else perPaper.values.count { it == k })
            }
        val mix = rs.groupBy { it.pid }.values.map { v -> v.groupBy { it.group }.mapValues { it.value.size } }
        val groupsSeen = rs.map { it.group }.distinct().sorted()
        return ReportSection(
            "assignment",
            "Assignment",
            true,
            null,
            listOf(
                ReportTable("Reviews per paper", listOf("reviews", "papers"), dist.map { listOf(it.key, it.value.toString()) }),
                ReportTable(
                    "Reviewer mix per paper",
                    listOf("group", "reviews", "reviewers", "median per paper (papers with any)", "papers with any"),
                    groupsSeen.map { gr ->
                        val per = mix.mapNotNull { it[gr] }
                        listOf(
                            gr,
                            rs.count {
                                it.group == gr
                            }.toString(),
                            rs.filter { it.group == gr }.map { it.who }.distinct().size.toString(),
                            num(median(per)),
                            per.size.toString(),
                        )
                    },
                ),
            ),
        )
    }

    private fun progress(s: Session): ReportSection {
        val acc =
            runCatching {
                s.accountability()
            }.getOrElse { return open("progress", "Reviewing progress", "cannot be computed: ${it.javaClass.simpleName}") }
        val rs = reviews(s).filter { it.complete }
        val floor = s.settings.raw["PCS_THRESH_MIN_WORDS"]?.toIntOrNull() ?: 150
        val negative = DiscussionReports.NEGATIVE.split(' ').toSet()
        val gs = (acc.progress.map { it.group } + rs.map { it.group }).distinct().sorted()
        val spread =
            rs.groupBy { it.pid }.values.mapNotNull { v ->
                v.mapNotNull { it.merit }.takeIf { it.size >= 2 }?.let { it.max() - it.min() }
            }.groupingBy { it.toString() }.eachCount()
        return ReportSection(
            "progress",
            "Reviewing progress",
            true,
            if (acc.dating.isNotEmpty()) "Lateness is dated partly from first-seen times: ${acc.dating.size} review(s) are approximate." else null,
            listOf(
                ReportTable(
                    "Timeliness by group",
                    listOf("group", "reviewers", "assigned", "submitted", "outstanding", "late", "late share of assigned"),
                    acc.progress.sortedBy { it.group }.map {
                        listOf(
                            it.group,
                            it.reviewers.toString(),
                            it.assigned.toString(),
                            it.submitted.toString(),
                            it.outstanding.toString(),
                            it.late.toString(),
                            pct(it.late, it.assigned),
                        )
                    },
                ),
                ReportTable(
                    "Depth and rating flags by group (complete reviews)",
                    listOf("group", "reviews", "median words", "under the floor ($floor words)", "negative flags", "positive flags", "flags per review"),
                    gs.map { gr ->
                        val m = rs.filter { it.group == gr }
                        val flags = m.flatMap { it.ratings }
                        val neg = flags.count { it in negative }
                        listOf(
                            gr,
                            m.size.toString(),
                            num(median(m.map { it.words })),
                            m.count { it.words < floor }.toString(),
                            neg.toString(),
                            (
                                flags.size -
                                    neg
                            ).toString(),
                            num(if (m.isEmpty()) null else flags.size.toDouble() / m.size),
                        )
                    },
                ),
                ReportTable(
                    "Score agreement: papers by spread of merit (max minus min)",
                    listOf("spread", "papers"),
                    spread.toSortedMap(
                        compareBy {
                            it.toInt()
                        },
                    ).map { listOf(it.key, it.value.toString()) },
                ),
            ),
        )
    }

    private fun accountability(s: Session): ReportSection {
        val acc =
            runCatching {
                s.accountability()
            }.getOrElse { return open("accountability", "Accountability requests", "cannot be computed: ${it.javaClass.simpleName}") }
        return ReportSection(
            "accountability",
            "Accountability requests",
            true,
            acc.notes.takeIf { it.isNotEmpty() }?.joinToString("; "),
            listOf(
                count("Suggestions by status", "status", acc.suggestions.groupingBy { it.status.name.lowercase() }.eachCount()),
                count("Requests by disposition", "disposition", acc.requests.groupingBy { it.disposition?.name?.lowercase() ?: "none yet" }.eachCount()),
                count("Requests by group", "group", acc.requests.groupingBy { it.group }.eachCount()),
                ReportTable(
                    "Engagement (counts of dispositions, no one named)",
                    listOf("measure", "value"),
                    listOf(
                        listOf("reviewers with a request", acc.engagement.size.toString()),
                        listOf("engaged", acc.engagement.sumOf { it.engaged }.toString()),
                        listOf("not engaged", acc.engagement.sumOf { it.notEngaged }.toString()),
                        listOf("disputed", acc.engagement.sumOf { it.disputed }.toString()),
                    ),
                ),
                count("Cases by status", "status", acc.cases.groupingBy { it.status.name.lowercase() }.eachCount()),
            ),
        )
    }

    private fun earlyReject(s: Session): ReportSection =
        runCatching { s.earlyReject() }.getOrElse { return open("early-reject", "Early reject", "cannot be computed: ${it.javaClass.simpleName}") }.let { st ->
            when (st) {
                is EarlyRejectState.Blocked -> open("early-reject", "Early reject", st.reasons.joinToString("; "))
                is EarlyRejectState.Ready -> {
                    val r = st.report
                    val papers = s.store.conn.query("SELECT count(*) FROM paper WHERE gone_at IS NULL") { it.getInt(1) }.single()
                    val by = r.candidates.groupingBy { it.status.label }.eachCount()
                    ReportSection(
                        "early-reject",
                        "Early reject",
                        true,
                        if (st.gap !=
                            null
                        ) {
                            "The mirror has no review snapshot at the window's opening, so the initial scores may be missing (${st.gap.reviewsToBackfill} reviews to backfill)."
                        } else {
                            null
                        },
                        listOf(
                            count("Candidates by status", "status", ErStatus.entries.associate { it.label to (by[it.label] ?: 0) }),
                            ReportTable(
                                "Yield",
                                listOf("measure", "value"),
                                listOf(
                                    listOf("window closed", r.windowClosed.toString()),
                                    listOf("candidates", r.candidates.size.toString()),
                                    listOf("candidates of all papers", pct(r.candidates.size, papers)),
                                    listOf("bumped by a reviewer's re-read", r.bumped.size.toString()),
                                    listOf("reviewers who never responded", r.neverResponded.size.toString()),
                                ),
                            ),
                        ),
                    )
                }
            }
        }

    private fun discussion(s: Session): ReportSection =
        when (val d = runCatching { s.discussion() }.getOrElse { return open("discussion", "Discussion", "cannot be computed: ${it.javaClass.simpleName}") }) {
            is DiscussionState.Blocked -> open("discussion", "Discussion", d.reasons.joinToString("; "))
            is DiscussionState.Ready -> {
                val r = d.report
                val gs = r.reviewers.map { it.group }.distinct().sorted()
                ReportSection(
                    "discussion",
                    "Discussion",
                    true,
                    d.notes.takeIf { it.isNotEmpty() }?.joinToString("; "),
                    listOf(
                        count("Papers by stage", "stage", r.overview.stages.entries.associate { it.key.label to it.value }),
                        ReportTable(
                            "Participation by group",
                            listOf("group", "reviewers", "papers in discussion (sum)", "commented (sum)", "participation", "median response (hours)"),
                            gs.map { g ->
                                val rows = r.reviewers.filter { it.group == g }
                                val inD = rows.sumOf { it.inDiscussion }
                                val cm = rows.sumOf { it.commented }
                                listOf(
                                    g,
                                    rows.size.toString(),
                                    inD.toString(),
                                    cm.toString(),
                                    pct(cm, inD),
                                    num(
                                        median(
                                            rows.mapNotNull {
                                                it.medianResponseHours
                                            },
                                        ),
                                    ),
                                )
                            },
                        ),
                        ReportTable(
                            "ACs",
                            listOf("measure", "value"),
                            listOf(
                                listOf("ACs", r.acs.size.toString()),
                                listOf("paper assignments", r.acs.sumOf { it.papers }.toString()),
                                listOf("with a comment from their AC since discussion opened", pct(r.acs.sumOf { it.covered }, r.acs.sumOf { it.papers })),
                                listOf("median hours to an AC's first post", num(median(r.acs.mapNotNull { it.medianHoursToFirstPost }))),
                                listOf("undecided papers still split", r.overview.openNoConsensus.toString()),
                            ),
                        ),
                    ),
                )
            }
        }
}
