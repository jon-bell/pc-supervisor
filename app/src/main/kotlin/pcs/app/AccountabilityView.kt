package pcs.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.launch
import pcs.core.accountability.AccConfig
import pcs.core.accountability.AccDrafts
import pcs.core.accountability.AccLocal
import pcs.core.accountability.AccRequest
import pcs.core.accountability.AccountabilityPlan
import pcs.core.accountability.AccountabilityReport
import pcs.core.accountability.CaseStatus
import pcs.core.accountability.ReqStatus
import pcs.core.accountability.ReqSuggestion
import pcs.core.accountability.SuggestionStatus
import pcs.core.accountability.Viewer
import pcs.core.nominations.Resolved
import pcs.core.rules.ReqDisposition
import pcs.core.session.Session
import pcs.core.writeback.Artifact
import java.awt.datatransfer.StringSelection
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Test tags of the reviewing and accountability screen; the view reader reads it back through them. */
object AccTags {
    const val SCREEN = "accountability"
    const val NOTES = "acc-notes"
    const val DATING = "acc-dating"
    const val STATUS = "acc-status"
    const val DRAFT_SUBJECT = "acc-draft-subject"
    const val DRAFT_BODY = "acc-draft-body"
    const val DRAFT_SEARCH = "acc-draft-search"
    const val Q21 = "acc-q21"

    fun section(name: String) = "acc-section-$name"

    fun row(section: String, key: String) = "acc-$section-row-$key"

    fun action(name: String, key: String) = "acc-$name-$key"
}

enum class AccSection(val label: String) {
    Progress("Progress"),
    Coaching("Coaching"),
    Suggestions("Suggestions"),
    Requests("Requests"),
    Engagement("Engagement"),
    Cases("Cases"),
}

private val stamp = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm z")

private fun dispositionLabel(d: ReqDisposition) = d.name.lowercase().replace('_', ' ')

internal fun requestLine(r: AccRequest, zone: ZoneId): String {
    val f = stamp.withZone(zone)
    val state =
        when {
            r.disposition != null -> "disposition: ${dispositionLabel(r.disposition!!)}"
            r.status == ReqStatus.REPLIED -> "the reviewer revised the review"
            r.status == ReqStatus.REMINDED ->
                "reminded ${f.format(r.remindedAt!!)}; " +
                    (r.noReplyFrom?.let { "no reply can be recorded after ${f.format(it)}" } ?: "")
            else -> "sent ${f.format(r.sentAt)}, due ${f.format(r.due)}"
        }
    return "#${r.pid}${r.ordinal} ${r.name} (${r.group}): $state"
}

internal fun <T> resolvedLine(r: Resolved<T>, show: (T) -> String): String =
    when (r) {
        is Resolved.Decided -> show(r.value)
        is Resolved.Open ->
            "depends on ${r.by.joinToString { it.code }}: " +
                r.cases.joinToString("; ") { (m, v) -> m.values.joinToString("/") + " → " + show(v) }
    }

/**
 * Reviewing progress and accountability requests (spec §10.4 D). PC Supervisor drafts and records; a chair sends each message from
 * HotCRP's Mail tool, and everything written to HotCRP goes through a Writeback artifact the chair confirms on the Writeback tab.
 * A dismissal is local to this copy of the app and leaves no trace anywhere else (AR4).
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun AccountabilityView(session: Session, opener: UrlOpener, version: Int, onChanged: () -> Unit) {
    val state by produceRows(version) { listOf(session.accountability()) }
    var section by remember { mutableStateOf(AccSection.Progress) }
    var status by remember { mutableStateOf<String?>(null) }
    var draft by remember { mutableStateOf<ReqSuggestion?>(null) }
    val report = state.firstOrNull()
    Column(Modifier.fillMaxSize().testTag(AccTags.SCREEN), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (report == null) {
            Text("Computing…", style = MaterialTheme.typography.bodyMedium)
            return@Column
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            AccSection.entries.forEach { s ->
                val on = s == section
                val b = Modifier.testTag(AccTags.section(s.name.lowercase()))
                if (on) Button({ section = s }, b) { Text(s.label) } else OutlinedButton({ section = s }, b) { Text(s.label) }
            }
        }
        report.notes.forEach { Text(it, Modifier.testTag(AccTags.NOTES), color = MaterialTheme.colorScheme.error) }
        report.dating.forEach { Text(it, Modifier.testTag(AccTags.DATING), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary) }
        status?.let { Text(it, Modifier.testTag(AccTags.STATUS), style = MaterialTheme.typography.labelLarge) }

        fun drafted(a: Artifact, what: String) {
            val id = session.writeback().draft(a)
            status = "$what: drafted Writeback artifact #$id; confirm it on the Writeback tab."
            onChanged()
        }
        val zone = session.settings.zone
        when (section) {
            AccSection.Progress -> ProgressSection(report)
            AccSection.Coaching ->
                LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    items(report.coaching, key = { "${it.pid}-${it.ordinal}-${it.reviewer}" }) { c ->
                        Column(Modifier.fillMaxWidth()) {
                            Text(
                                "#${c.pid}${c.ordinal.orEmpty()} ${c.name} (${c.group}), ${c.words} words${if (c.coached) ", already coached" else ""}",
                                Modifier.testTag(AccTags.row("coaching", "${c.pid}${c.ordinal.orEmpty()}")),
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            Text(c.reasons.joinToString("; "), style = MaterialTheme.typography.bodySmall)
                            OutlinedButton({
                                opener.open(session.links.paper(c.pid))
                            }, Modifier.testTag(AccTags.action("open", "${c.pid}${c.ordinal.orEmpty()}"))) { Text("Open in HotCRP") }
                        }
                    }
                }
            AccSection.Suggestions -> {
                val open = report.suggestions.filter { it.status == SuggestionStatus.OPEN }
                Text(
                    "${open.size} open, ${report.suggestions.count {
                        it.status == SuggestionStatus.DISMISSED
                    }} dismissed, ${report.suggestions.count { it.status == SuggestionStatus.SENT }} sent. " +
                        "Suggestions come from review metadata and structure only; a dismissal stays on this machine.",
                    style = MaterialTheme.typography.bodySmall,
                )
                val d = draft
                if (d != null) {
                    DraftPanel(session, report, d, { draft = null }, {
                        drafted(AccDrafts.recordSent(d.pid, d.ordinal), "Request sent for #${d.pid}${d.ordinal}")
                        draft =
                            null
                    })
                }
                LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    items(open, key = { "${it.pid}-${it.ordinal}" }) { s ->
                        val key = "${s.pid}${s.ordinal}"
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Column(Modifier.weight(1f)) {
                                Text(
                                    "#$key ${s.name} (${s.group}), from the ${s.source.key}; criteria ${s.criteria.joinToString().ifEmpty { "none yet" }}",
                                    Modifier.testTag(AccTags.row("suggestions", key)),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                                Text(s.reasons.joinToString("; "), Modifier.testTag(AccTags.row("reasons", key)), style = MaterialTheme.typography.bodySmall)
                            }
                            OutlinedButton({ draft = s }, Modifier.testTag(AccTags.action("draft", key))) { Text("Draft request") }
                            OutlinedButton({
                                AccLocal.dismiss(session.store, s.pid, s.ordinal, null, session.clock.now())
                                status = "Dismissed #$key. Nothing was written to HotCRP, and the reviewer's record is unchanged."
                                onChanged()
                            }, Modifier.testTag(AccTags.action("dismiss", key))) { Text("Dismiss") }
                        }
                    }
                }
            }
            AccSection.Requests ->
                LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(report.requests, key = { "${it.pid}-${it.ordinal}-${it.n}" }) { r -> RequestRow(r, zone, ::drafted) }
                }
            AccSection.Engagement -> {
                Text(
                    "Counts of recorded dispositions only (never suggestions). The PC chairs see every record; an AC sees requests about their own papers, the junior PC chair junior reviewers.",
                    style = MaterialTheme.typography.bodySmall,
                )
                Text(
                    resolvedLine(AccountabilityPlan.q21Outcome(session.answers().readings)) { it },
                    Modifier.testTag(AccTags.Q21),
                    style = MaterialTheme.typography.bodySmall,
                )
                LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                    items(report.engagementFor(Viewer.PcChair), key = { it.reviewer }) { e ->
                        Text(
                            "${e.name} (${e.group}): ${e.engaged} engaged, ${e.notEngaged} not engaged, ${e.disputed} disputed, ${e.open} open",
                            Modifier.testTag(AccTags.row("engagement", e.reviewer)),
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                }
            }
            AccSection.Cases ->
                LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(report.cases, key = { it.nominee }) { c ->
                        val key = c.number.toString()
                        Column {
                            Text(
                                "Case $key: ${c.name}, status ${c.status.name.lowercase()}, papers ${c.papers.joinToString()}",
                                Modifier.testTag(AccTags.row("cases", key)),
                                style = MaterialTheme.typography.titleSmall,
                            )
                            Text(
                                (if (c.missingReview) "a review is missing" else "") +
                                    (if (c.qualityConcern) (if (c.missingReview) "; " else "") + "review quality concern" else ""),
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Text(
                                "May open: " +
                                    resolvedLine(c.mayOpen) { if (it) "yes" else "no, a request disposed declined or no reply must come first (Q20)" },
                                Modifier.testTag(AccTags.row("may-open", key)),
                                style = MaterialTheme.typography.bodySmall,
                            )
                            Text(
                                "Consequence: " +
                                    resolvedLine(c.consequence) {
                                        it
                                    },
                                Modifier.testTag(AccTags.row("consequence", key)),
                                style = MaterialTheme.typography.bodySmall,
                            )
                            c.notes.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                if (c.status == CaseStatus.CANDIDATE && c.mayOpen.decided == true) {
                                    OutlinedButton({
                                        AccLocal.setCase(session.store, c.nominee, "open", session.clock.now())
                                        onChanged()
                                    }, Modifier.testTag(AccTags.action("open-case", key))) { Text("Open case") }
                                }
                                if (c.status == CaseStatus.OPEN) {
                                    OutlinedButton(
                                        { drafted(AccDrafts.recordCase(c.papers, c.number, upheld = true), "Case $key upheld") },
                                        Modifier.testTag(AccTags.action("uphold", key)),
                                    ) { Text("Record upheld (a PC chair applies it)") }
                                    OutlinedButton({
                                        AccLocal.setCase(session.store, c.nominee, "dismissed", session.clock.now())
                                        onChanged()
                                    }, Modifier.testTag(AccTags.action("dismiss-case", key))) { Text("Dismiss case") }
                                }
                            }
                            HorizontalDivider()
                        }
                    }
                }
        }
    }
}

@Composable
private fun ProgressSection(report: AccountabilityReport) {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        report.progress.forEach { p ->
            Text(
                "${p.group}: ${p.reviewers} reviewers, ${p.assigned} assigned, ${p.submitted} submitted, ${p.outstanding} outstanding, ${p.late} late",
                Modifier.testTag(AccTags.row("progress", p.group)),
                style = MaterialTheme.typography.bodyMedium,
            )
        }
        Text("Nominees with reviews outstanding", style = MaterialTheme.typography.labelLarge)
        LazyColumn(Modifier.fillMaxWidth().padding(top = 4.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            items(report.nomineeOutstanding, key = { "${it.pid}-${it.email}" }) { o ->
                Text(
                    "#${o.pid}${o.ordinal.orEmpty()} ${o.name}: ${o.status}" + (o.lateDays?.let { ", $it day(s) late" } ?: ""),
                    Modifier.testTag(AccTags.row("nominee", "${o.pid}-${o.email}")),
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun DraftPanel(session: Session, report: AccountabilityReport, s: ReqSuggestion, onClose: () -> Unit, onRecordSent: () -> Unit) {
    var chosen by remember(s) { mutableStateOf(s.criteria.toSet()) }
    var words by remember(s) { mutableStateOf("") }
    val dueH = AccConfig.from(session.settings).dueH
    val clip = LocalClipboard.current
    val scope = rememberCoroutineScope()
    Column(Modifier.fillMaxWidth().padding(4.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text("Request for #${s.pid}${s.ordinal} to ${s.name}: cite criteria from the PC chairs' list only", style = MaterialTheme.typography.titleSmall)
        report.criteria.forEach { c ->
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Checkbox(c.id in chosen, { on ->
                    chosen = if (on) chosen + c.id else chosen - c.id
                }, Modifier.testTag(AccTags.action("criterion", c.id.toString())))
                Text("${c.id}. ${c.text}", style = MaterialTheme.typography.bodyMedium)
            }
        }
        OutlinedTextField(words, { words = it }, Modifier.fillMaxWidth().testTag("acc-words"), label = { Text("Your own words (optional)") })
        val d = if (chosen.isEmpty()) null else AccDrafts.draft(s, chosen.toList(), report.criteria, words, dueH, session.links)
        if (d == null) {
            Text("Choose at least one criterion.", style = MaterialTheme.typography.bodySmall)
        } else {
            SelectionContainer {
                Column {
                    Text(d.subject, Modifier.testTag(AccTags.DRAFT_SUBJECT), style = MaterialTheme.typography.titleSmall)
                    Text(d.body, Modifier.testTag(AccTags.DRAFT_BODY), style = MaterialTheme.typography.bodySmall)
                    Text(d.search, Modifier.testTag(AccTags.DRAFT_SEARCH))
                }
            }
            d.steps.forEach { Text(it, style = MaterialTheme.typography.bodySmall) }
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton({
                    scope.launch { clip.setClipEntry(ClipEntry(StringSelection(d.subject + "\n\n" + d.body))) }
                }, Modifier.testTag(AccTags.action("copy", "draft"))) { Text("Copy message") }
                Button(onRecordSent, Modifier.testTag(AccTags.action("record-sent", "${s.pid}${s.ordinal}"))) { Text("I sent it: record it") }
                OutlinedButton(onClose) { Text("Close") }
            }
        }
    }
}

@Composable
private fun RequestRow(r: AccRequest, zone: ZoneId, drafted: (Artifact, String) -> Unit) {
    val key = "${r.pid}${r.ordinal}${r.n}"
    var attested by remember(key) { mutableStateOf(false) }
    Column {
        Text(requestLine(r, zone), Modifier.testTag(AccTags.row("requests", key)), style = MaterialTheme.typography.bodyMedium)
        if (r.disposition == null) {
            val replied = r.revised || attested
            Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                if (r.mayRemind && !r.revised && r.remindedAt == null) {
                    OutlinedButton({
                        drafted(AccDrafts.recordReminder(r.pid, r.ordinal, r.n), "Reminder for #$key")
                    }, Modifier.testTag(AccTags.action("remind", key))) { Text("Record reminder") }
                }
                if (!r.revised) {
                    Checkbox(attested, { attested = it }, Modifier.testTag(AccTags.action("attest", key)))
                    Text("the AC reports a reply", style = MaterialTheme.typography.bodySmall)
                }
                if (replied) {
                    listOf(ReqDisposition.REVISED, ReqDisposition.EXPLAINED, ReqDisposition.DECLINED, ReqDisposition.DISPUTED).forEach { d ->
                        OutlinedButton({
                            drafted(AccDrafts.recordDisposition(r.pid, r.ordinal, r.n, d), "Disposition for #$key")
                        }, Modifier.testTag(AccTags.action(d.name.lowercase(), key))) {
                            Text(dispositionLabel(d))
                        }
                    }
                }
                if (r.mayNoReply && !replied) {
                    OutlinedButton(
                        { drafted(AccDrafts.recordDisposition(r.pid, r.ordinal, r.n, ReqDisposition.NO_REPLY), "No reply for #$key") },
                        Modifier.testTag(AccTags.action("no_reply", key)),
                    ) { Text("no reply") }
                }
            }
        }
    }
}
