package net.jonbell.pcs.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import net.jonbell.pcs.core.report.ProcessReport
import net.jonbell.pcs.core.report.ReportFiles
import net.jonbell.pcs.core.session.Session

/** Test tags of the process report tab. */
object ProcessReportTags {
    const val SCREEN = "process-report"
    const val SAVE = "report-save"
    const val EXPORT = "report-export"
    const val STATUS = "report-status"

    fun section(id: String) = "report-section-$id"

    fun table(id: String, n: Int) = "report-table-$id-$n"
}

/**
 * The process report (spec §10.4 G) as counts and rule outcomes per module, with two actions: save it as Markdown and HTML, and export the
 * pseudonymous rows (the key is `PCS_PSEUDONYM_KEY` or `PCS_PSEUDONYM_KEY_FILE`; without one nothing is written). Neither action
 * touches HotCRP. The report holds no names, titles or review text.
 */
@Composable
fun ProcessReportView(session: Session, version: Int) {
    val data by produceRows(version) { listOf(net.jonbell.pcs.core.report.ProcessReports.build(session)) }
    var status by remember { mutableStateOf<String?>(null) }
    val dir = remember(session) { ReportFiles.dir(session, System.getenv()) }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag(ProcessReportTags.SCREEN), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({
                status =
                    runCatching {
                        "Saved ${ReportFiles.saveReport(session, dir).joinToString { it.fileName.toString() }} in $dir"
                    }.getOrElse { "Could not save: ${it.message}" }
            }, Modifier.testTag(ProcessReportTags.SAVE)) { Text("Save report (Markdown and HTML)") }
            OutlinedButton({
                status =
                    runCatching {
                        ReportFiles.saveExport(session, dir)?.let { "Exported ${it.size} pseudonymous tables to $dir" }
                            ?: "No pseudonym key: set PCS_PSEUDONYM_KEY or PCS_PSEUDONYM_KEY_FILE. Nothing was written."
                    }.getOrElse { "Could not export: ${it.message}" }
            }, Modifier.testTag(ProcessReportTags.EXPORT)) { Text("Export pseudonymous rows") }
        }
        status?.let { Text(it, Modifier.testTag(ProcessReportTags.STATUS), style = MaterialTheme.typography.bodySmall) }
        when (val r = data.firstOrNull()) {
            null -> Text("Computing…")
            else -> Report(r)
        }
    }
}

@Composable
private fun Report(r: ProcessReport) {
    r.sections.forEach { s ->
        Column(Modifier.testTag(ProcessReportTags.section(s.id)), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(s.title, style = MaterialTheme.typography.titleMedium)
            if (!s.available) {
                Text("Not available: ${s.note}", color = MaterialTheme.colorScheme.secondary)
            } else {
                s.note?.let {
                    Text(it, style = MaterialTheme.typography.bodySmall)
                }
            }
            s.tables.forEachIndexed { i, t ->
                Column(Modifier.testTag(ProcessReportTags.table(s.id, i))) {
                    Text(t.title, style = MaterialTheme.typography.labelLarge)
                    Text(t.header.joinToString("  |  "), style = MaterialTheme.typography.labelSmall)
                    t.rows.forEach { row -> Text(row.joinToString("  |  "), style = MaterialTheme.typography.bodySmall) }
                }
            }
        }
    }
}
