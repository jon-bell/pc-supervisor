package net.jonbell.pcs.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import net.jonbell.pcs.core.session.Session
import net.jonbell.pcs.core.triage.ConsistencyView
import net.jonbell.pcs.core.triage.TriageReport
import net.jonbell.pcs.core.triage.TriageRow
import net.jonbell.pcs.core.triage.consistency
import net.jonbell.pcs.core.triage.triage

/** Test tags of the triage screen; the view reader reads it back through them. */
object TriageTags {
    const val SCREEN = "triage"
    const val BLOCKED = "triage-blocked"
    const val SUMMARY = "triage-summary"
    const val ALERT = "triage-alert"
    const val SPREAD = "triage-spread"
    const val TABLE = "triage-queue"
    const val NOTE = "triage-note"
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

/**
 * Screening triage and desk reject (spec §10.4 B): the queue built from the screening bundle's findings and the AC's triage, where each
 * paper stands and which rule holds it back, and the distribution of triage across ACs (never a ranking of people). It only shows:
 * every action is a Writeback artifact the chair confirms.
 */
@Composable
fun TriageView(session: Session, opener: UrlOpener, version: Int) {
    val state by produceRows(version) { listOf(session.triage()) }
    Column(Modifier.fillMaxSize().testTag(TriageTags.SCREEN), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (val s = state.firstOrNull()) {
            null -> Text("Computing…", style = MaterialTheme.typography.bodyMedium)
            is TriageReport.Blocked -> s.reasons.forEach { Text("Blocked: $it", Modifier.testTag(TriageTags.BLOCKED), color = MaterialTheme.colorScheme.error) }
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
                LazyTable(TriageTags.TABLE, "papers", s.rows, {
                    it.pid.toString()
                }, triageColumns(), { session.links.paper(it.pid) }, opener, Modifier.weight(1f))
            }
        }
    }
}
