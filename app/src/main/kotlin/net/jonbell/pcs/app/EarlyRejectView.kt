package net.jonbell.pcs.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.jonbell.pcs.core.earlyreject.ErCandidate
import net.jonbell.pcs.core.earlyreject.ErReport
import net.jonbell.pcs.core.earlyreject.ErStatus
import net.jonbell.pcs.core.earlyreject.SnapshotGap
import net.jonbell.pcs.core.session.EarlyRejectState
import net.jonbell.pcs.core.session.Session
import java.awt.datatransfer.StringSelection
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Test tags of the early-reject screen; the view reader reads it back through them. */
object EarlyRejectTags {
    const val SCREEN = "early-reject"
    const val BLOCKED = "er-blocked"
    const val WINDOW = "er-window"
    const val SUMMARY = "er-summary"
    const val MAIL_SEARCH = "er-mail-search"
    const val MAIL_SUBJECT = "er-mail-subject"
    const val MAIL_BODY = "er-mail-body"
    const val COPY_SEARCH = "er-copy-search"
    const val DECISION_CSV = "er-decision-csv"
    const val COPY_CSV = "er-copy-csv"
    const val TABLE = "er-candidates"
    const val GAP = "er-gap"
    const val BACKFILL = "er-backfill"
    const val BACKFILL_STATUS = "er-backfill-status"
}

fun candidateColumns(): List<Col<ErCandidate>> =
    listOf(
        Col("pid", "#", 60, { it.pid.toString() }, { it.pid }),
        Col("title", "Title", 260, { it.title }, { it.title.lowercase() }),
        Col("status", "Status", 130, { it.status.label }, { it.status.ordinal }),
        Col("scores", "Initial scores", 260, { c -> c.initialScores.joinToString(", ") { it.key } }, { it.initialScores.sumOf { s -> s.rank } }),
        Col("bump", "Bump window", 300, { c ->
            if (c.bumpedBy.isEmpty()) "no score changed" else "changed by ${c.bumpedBy.joinToString()}"
        }, { it.bumpedBy.size }),
        Col("objection", "AC objection", 120, { if (it.acObjects) "AC objects" else "" }, { it.acObjects }),
        Col("quiet", "No reply yet", 260, { it.neverResponded.joinToString() }, { it.neverResponded.size }, visibleByDefault = false),
    )

private val stamp = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm z")

internal fun windowLine(report: ErReport, zone: ZoneId): String {
    val open = stamp.withZone(zone).format(report.window.open)
    val close = report.window.close?.let { stamp.withZone(zone).format(it) }
    val state =
        when {
            report.now.isBefore(report.window.open) -> "not open yet"
            report.window.close == null -> "no last-word window (Q16): candidates need no wait"
            report.windowClosed -> "closed"
            else -> "open"
        }
    return "Window opened $open" + (close?.let { ", closes $it" } ?: "") + ": $state"
}

internal fun summaryLine(report: ErReport): String {
    val by = ErStatus.entries.joinToString(", ") { s -> "${report.candidates.count { it.status == s }} ${s.label}" }
    return "${report.candidates.size} candidates: $by"
}

internal fun gapLine(gap: SnapshotGap): String =
    if (gap.reviewsToBackfill > 0) {
        "The window has opened, but the mirror has no review snapshot at or before the opening, so the initial scores are unknown " +
            "(${gap.reviews} reviews; the history of ${gap.reviewsToBackfill} has not been read)."
    } else {
        "The window has opened and the review history has been read, but no review existed at the opening: there are no initial scores."
    }

/**
 * Early reject (spec §10.4 E): the candidates under Q15, with the bump window under Q16 read from the mirror's snapshots,
 * the drafted Mail-tool search for their reviewers, and the decision artifact. The screen only shows and copies; the chair
 * sends the mail from HotCRP, and the decisions reach HotCRP through Writeback.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun EarlyRejectView(session: Session, opener: UrlOpener, version: Int, onChanged: () -> Unit = {}) {
    val state by produceRows(version) { listOf(session.earlyReject()) }
    Column(Modifier.fillMaxSize().testTag(EarlyRejectTags.SCREEN), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (val s = state.firstOrNull()) {
            null -> Text("Computing…", style = MaterialTheme.typography.bodyMedium)
            is EarlyRejectState.Blocked ->
                s.reasons.forEach { Text("Blocked: $it", Modifier.testTag(EarlyRejectTags.BLOCKED), color = MaterialTheme.colorScheme.error) }
            is EarlyRejectState.Ready -> {
                s.gap?.let { BackfillGap(session, it, onChanged) }
                Text(windowLine(s.report, session.settings.zone), Modifier.testTag(EarlyRejectTags.WINDOW), style = MaterialTheme.typography.titleSmall)
                Text(summaryLine(s.report), Modifier.testTag(EarlyRejectTags.SUMMARY), style = MaterialTheme.typography.bodyMedium)
                val clip = LocalClipboard.current
                val scope = rememberCoroutineScope()

                fun copy(text: String) {
                    scope.launch { clip.setClipEntry(ClipEntry(StringSelection(text))) }
                }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Mail to the reviewers (HotCRP's Mail tool; PC Supervisor never sends it)", style = MaterialTheme.typography.labelLarge)
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            Text("Search:", style = MaterialTheme.typography.bodyMedium)
                            SelectionContainer { Text(s.mail.search.ifEmpty { "(no papers waiting)" }, Modifier.testTag(EarlyRejectTags.MAIL_SEARCH)) }
                            OutlinedButton({ copy(s.mail.search) }, Modifier.testTag(EarlyRejectTags.COPY_SEARCH)) { Text("Copy search") }
                        }
                        SelectionContainer {
                            Column {
                                Text(s.mail.subject, Modifier.testTag(EarlyRejectTags.MAIL_SUBJECT), style = MaterialTheme.typography.titleSmall)
                                Text(s.mail.body, Modifier.testTag(EarlyRejectTags.MAIL_BODY), style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                    Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Decisions for Writeback (bulk-assignment CSV)", style = MaterialTheme.typography.labelLarge)
                        SelectionContainer {
                            Text(s.decisions.toCsv(), Modifier.testTag(EarlyRejectTags.DECISION_CSV), style = MaterialTheme.typography.bodySmall)
                        }
                        OutlinedButton({ copy(s.decisions.toCsv()) }, Modifier.testTag(EarlyRejectTags.COPY_CSV)) { Text("Copy CSV") }
                    }
                }
                LazyTable(
                    EarlyRejectTags.TABLE,
                    "candidates",
                    s.report.candidates,
                    { it.pid.toString() },
                    candidateColumns(),
                    { session.links.paper(it.pid) },
                    opener,
                    Modifier.weight(1f),
                )
            }
        }
    }
}

/** The gap in the mirror's history and the chair's button for it; the backfill never runs unless this button is pressed. */
@Composable
private fun BackfillGap(session: Session, gap: SnapshotGap, onChanged: () -> Unit) {
    var running by remember { mutableStateOf(false) }
    var status by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        Text(gapLine(gap), Modifier.testTag(EarlyRejectTags.GAP), color = MaterialTheme.colorScheme.error)
        if (gap.reviewsToBackfill > 0) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                OutlinedButton(
                    {
                        running = true
                        status = "Reading review history at ${session.settings.historyRps} requests per second…"
                        scope.launch {
                            status =
                                try {
                                    val added = withContext(Dispatchers.IO) { session.backfillReviewHistory() }
                                    onChanged()
                                    "Backfilled: $added review versions added"
                                } catch (e: Exception) {
                                    "Backfill failed: ${e.message ?: e.javaClass.simpleName}"
                                } finally {
                                    running = false
                                }
                        }
                    },
                    Modifier.testTag(EarlyRejectTags.BACKFILL),
                    enabled = !running,
                ) { Text("Backfill review history") }
                status?.let { Text(it, Modifier.testTag(EarlyRejectTags.BACKFILL_STATUS), style = MaterialTheme.typography.bodyMedium) }
            }
        }
    }
}
