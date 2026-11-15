package net.jonbell.pcs.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.jonbell.pcs.core.session.Session
import net.jonbell.pcs.core.triage.ConsistencyView
import net.jonbell.pcs.core.triage.OpinionCandidate
import net.jonbell.pcs.core.triage.SecondOpinions
import net.jonbell.pcs.core.triage.TriageDrafts
import net.jonbell.pcs.core.triage.TriageReport
import net.jonbell.pcs.core.triage.TriageRow
import net.jonbell.pcs.core.triage.TriageStatus
import net.jonbell.pcs.core.triage.consistency
import net.jonbell.pcs.core.triage.tiers
import net.jonbell.pcs.core.triage.triage
import net.jonbell.pcs.core.writeback.Artifact

/** Test tags of the triage screen; the view reader reads it back through them. */
object TriageTags {
    const val SCREEN = "triage"
    const val BLOCKED = "triage-blocked"
    const val SUMMARY = "triage-summary"
    const val ALERT = "triage-alert"
    const val SPREAD = "triage-spread"
    const val TABLE = "triage-queue"
    const val NOTE = "triage-note"
    const val MIRROR = "triage-draft-mirror"
    const val FINDINGS = "triage-draft-findings"
    const val DECISION = "triage-draft-decision"
    const val SELECTED = "triage-selected"
    const val MESSAGE = "triage-message"
    const val MAIL = "triage-mail"
    const val OPEN_PAPER = "triage-open-paper"

    fun ask(email: String) = "triage-ask-$email"
}

fun triageColumns(): List<Col<TriageRow>> =
    listOf(
        Col("pid", "#", 60, { it.pid.toString() }, { it.pid }),
        Col("title", "Title", 220, { it.title }, { it.title.lowercase() }),
        Col("ac", "AC", 180, { it.ac.orEmpty() }, { it.ac.orEmpty() }),
        Col("grounds", "Grounds", 220, { r -> r.grounds.joinToString { it.key } }, { it.grounds.size }),
        Col("findings", "Findings", 80, { it.findings.size.toString() }, { it.findings.size }),
        Col("status", "Status", 300, { it.status.label }, { it.status.ordinal }),
        Col("why", "Why not yet", 420, { it.blockers.joinToString("; ") }, { it.blockers.size }),
        Col("late", "Late", 60, { if (it.late) "late" else "" }, { it.late }),
        Col("mirror", "Mirror", 120, { if (it.needsMirror) "to mirror" else "" }, { it.needsMirror }, visibleByDefault = false),
    )

internal fun triageSummary(r: TriageReport.Ready): String =
    "${r.rows.size} papers at the ${r.stage.key} stage: " +
        net.jonbell.pcs.core.triage.TriageStatus.entries.mapNotNull { s ->
            r.rows.count { it.status == s }.takeIf { it > 0 }?.let { "$it ${s.label}" }
        }.joinToString(", ")

internal fun spreadLine(v: ConsistencyView): String =
    listOf("flag rate" to v.flag, "referral rate" to v.referral, "desk-reject rate" to v.removal).joinToString("; ") { (n, s) ->
        if (s ==
            null
        ) {
            "$n: not enough ACs"
        } else {
            "$n: median ${"%.2f".format(s.median)}, range ${"%.2f".format(s.min)} to ${"%.2f".format(s.max)} over ${s.n} ACs"
        }
    }

/** What a chair step drafted: the artifacts (each goes to the Writeback tab, nothing applied) and the mail texts a chair sends from HotCRP. */
private data class Drafted(val artifacts: List<Artifact>, val mails: List<TriageDrafts.MailDraft> = emptyList(), val none: String = "Nothing to draft.")

/**
 * Screening triage and desk reject (spec §10.4 B): the queue built from the screening bundle's findings and the AC's triage, where each
 * paper stands and which rule holds it back, and the distribution of triage across ACs (never a ranking of people). It only shows:
 * every action is a Writeback artifact the chair confirms.
 * The buttons only draft: the artifact lands in the Writeback tab, where the dry run, the confirmation and the apply are.
 */
@Composable
fun TriageView(session: Session, opener: UrlOpener, version: Int) {
    val state by produceRows(version) { listOf(session.triage()) }
    var selected by remember { mutableStateOf<Long?>(null) }
    Column(Modifier.fillMaxSize().testTag(TriageTags.SCREEN), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (val s = state.firstOrNull()) {
            null -> Text("Computing…", style = MaterialTheme.typography.bodyMedium)
            is TriageReport.Blocked ->
                Text(
                    "Blocked: ${s.reasons.joinToString("; ")}",
                    Modifier.testTag(TriageTags.BLOCKED),
                    color = MaterialTheme.colorScheme.error,
                )
            is TriageReport.Ready -> {
                val view = session.consistency(s)
                Text(triageSummary(s), Modifier.testTag(TriageTags.SUMMARY), style = MaterialTheme.typography.titleSmall)
                view.alerts.forEach {
                    Text(
                        "${it.ac}'s ${it.metric} (${"%.2f".format(
                            it.rate,
                        )}) is outside the band of the other ACs (${"%.2f".format(it.low)} to ${"%.2f".format(it.high)})",
                        Modifier.testTag(TriageTags.ALERT),
                        color = MaterialTheme.colorScheme.error,
                    )
                }
                Text(spreadLine(view), Modifier.testTag(TriageTags.SPREAD), style = MaterialTheme.typography.bodySmall)
                view.note?.let { Text(it, Modifier.testTag(TriageTags.NOTE), style = MaterialTheme.typography.bodySmall) }
                TriageActions(session, s.rows, selected, opener)
                LazyTable(
                    TriageTags.TABLE,
                    "papers",
                    s.rows,
                    { it.pid.toString() },
                    triageColumns(),
                    { session.links.paper(it.pid) },
                    opener,
                    Modifier.weight(1f),
                    onRowClick = { selected = it.pid },
                )
            }
        }
    }
}

/** The chair's steps (spec §10.4 B), each as a draft into Writeback. A paper's own steps work on the paper chosen by clicking its row. */
@Composable
private fun TriageActions(session: Session, rows: List<TriageRow>, selected: Long?, opener: UrlOpener) {
    val scope = rememberCoroutineScope()
    var message by remember { mutableStateOf<String?>(null) }
    var mails by remember { mutableStateOf<List<TriageDrafts.MailDraft>>(emptyList()) }
    var busy by remember { mutableStateOf(false) }
    val row = rows.firstOrNull { it.pid == selected }
    val candidates by produceState(emptyList<OpinionCandidate>(), row?.pid, row?.status) {
        value =
            withContext(Dispatchers.IO) {
                val q2 = session.answers().readings.q2
                if (row == null || row.status != TriageStatus.NEEDS_SECOND_OPINION || q2 == null) {
                    emptyList()
                } else {
                    SecondOpinions.candidates(session.store, row.pid, q2, session.tiers())
                }
            }
    }

    fun draft(step: () -> Drafted) {
        busy = true
        scope.launch {
            try {
                val d = withContext(Dispatchers.IO) { step().let { d -> d to d.artifacts.map { session.writeback().draft(it) } } }
                message =
                    if (d.second.isEmpty()) {
                        d.first.none
                    } else {
                        "Drafted into Writeback: " + d.second.joinToString(", ") { "#$it" } + ". Nothing is applied until you dry-run, confirm and apply there."
                    }
                mails = d.first.mails
            } catch (e: Exception) {
                message = "Could not draft: ${e.message ?: e.javaClass.simpleName}"
            }
            busy = false
        }
    }
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        OutlinedButton({
            draft { Drafted(TriageDrafts.mirrorTriage(session.store), none = "Every triage is already mirrored.") }
        }, Modifier.testTag(TriageTags.MIRROR), enabled = !busy) { Text("Draft triage mirror and metareview move") }
        OutlinedButton({
            draft { Drafted(TriageDrafts.postFindings(session.store, rows), none = "Every flagged paper already has its findings comment.") }
        }, Modifier.testTag(TriageTags.FINDINGS), enabled = !busy) { Text("Draft findings comments") }
        OutlinedButton({
            draft {
                val (a, m) = TriageDrafts.remove(rows)
                Drafted(listOf(a), m)
            }
        }, Modifier.testTag(TriageTags.DECISION), enabled = !busy && rows.any { it.status == TriageStatus.READY }) { Text("Draft decision for ready papers") }
    }
    if (row != null) {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Text("Selected: #${row.pid}", Modifier.testTag(TriageTags.SELECTED), style = MaterialTheme.typography.labelLarge)
            OutlinedButton({ opener.open(session.links.paper(row.pid)) }, Modifier.testTag(TriageTags.OPEN_PAPER)) { Text("Open in HotCRP") }
            if (row.status == TriageStatus.NEEDS_SECOND_OPINION) {
                if (candidates.isEmpty()) Text("No eligible second opinion under Q2.", style = MaterialTheme.typography.bodySmall)
                candidates.take(MAX_CANDIDATES).forEach { c ->
                    OutlinedButton({
                        draft {
                            val (a, m) = TriageDrafts.requestSecondOpinion(row, c.email)
                            Drafted(listOf(a), listOf(m))
                        }
                    }, Modifier.testTag(TriageTags.ask(c.email)), enabled = !busy) { Text("Request second opinion from ${c.email}") }
                }
            }
        }
    }
    message?.let { Text(it, Modifier.testTag(TriageTags.MESSAGE), style = MaterialTheme.typography.bodySmall) }
    mails.forEachIndexed { i, m ->
        Text(
            "Mail for a chair to send (search: ${m.search}): ${m.subject}",
            Modifier.testTag("${TriageTags.MAIL}-$i"),
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

private const val MAX_CANDIDATES = 5
