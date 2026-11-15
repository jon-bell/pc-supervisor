package net.jonbell.pcs.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
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
import net.jonbell.pcs.core.writeback.ArtifactRecord
import net.jonbell.pcs.core.writeback.ConventionAudit
import net.jonbell.pcs.core.writeback.Ledger
import net.jonbell.pcs.core.writeback.UserArtifact
import net.jonbell.pcs.core.writeback.WritebackException
import net.jonbell.pcs.core.writeback.WritebackStatus

/** Test tags of the Writeback review screen and the report. */
object WritebackTags {
    const val SCREEN = "writeback"
    const val LIST = "writeback-list"
    const val STATUS = "wb-status"
    const val SUMMARY = "wb-summary"
    const val DRY_RUN = "wb-dry-run"
    const val CONFIRM_APPLY = "wb-confirm-apply"
    const val MESSAGE = "wb-message"
    const val HANDOFF = "wb-handoff"
    const val SUPPORTED = "wb-dry-run-source"
    const val REPORT = "report"
    const val REPORT_SUMMARY = "report-summary"

    fun diff(i: Int) = "wb-diff-$i"

    fun mismatch(id: Long) = "report-mismatch-$id"

    fun issue(i: Int) = "report-issue-$i"
}

private fun artifactColumns(): List<Col<ArtifactRecord>> =
    listOf(
        Col("id", "#", 50, { it.id.toString() }, { it.id }),
        Col("kind", "Kind", 110, { it.artifact.kind }, { it.artifact.kind }),
        Col("summary", "Artifact", 520, { it.summary }, { it.summary.lowercase() }),
        Col("status", "Status", 110, { it.status.key }, { it.status.key }),
    )

/**
 * The review screen (PLAN M5): the list of artifacts, and for the chosen one HotCRP's own dry-run
 * diff and the one button that confirms and applies it. The button is enabled only while the
 * artifact has a valid dry run; the core checks that the dry run is current and that the chair is one.
 */
@Composable
fun WritebackScreen(session: Session, opener: UrlOpener, version: Int, selected: Long?, onSelect: (Long?) -> Unit, onChanged: () -> Unit) {
    val rows by produceRows(version) { session.writeback().list().reversed() }
    Row(Modifier.fillMaxSize().testTag(WritebackTags.SCREEN), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        LazyTable(
            WritebackTags.LIST,
            "artifacts",
            rows,
            { it.id.toString() },
            artifactColumns(),
            { "" },
            opener,
            Modifier.weight(1f),
            onRowClick = { onSelect(it.id) },
        )
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState())) {
            val rec = rows.firstOrNull { it.id == selected }
            if (rec == null) {
                Text("Choose an artifact to review it.", style = MaterialTheme.typography.bodyMedium)
            } else {
                ArtifactReview(session, rec, onChanged)
            }
        }
    }
}

@Composable
private fun ArtifactReview(session: Session, rec: ArtifactRecord, onChanged: () -> Unit) {
    val scope = rememberCoroutineScope()
    var busy by remember(rec.id) { mutableStateOf(false) }
    var error by remember(rec.id, rec.status) { mutableStateOf<String?>(null) }
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Artifact ${rec.id}", style = MaterialTheme.typography.titleMedium)
        Text(rec.summary, Modifier.testTag(WritebackTags.SUMMARY), style = MaterialTheme.typography.bodyMedium)
        Text(rec.status.key, Modifier.testTag(WritebackTags.STATUS), style = MaterialTheme.typography.titleSmall)
        val dr = rec.dryRun
        if (dr == null) {
            Text("Not dry-run yet. HotCRP will say what would change, and nothing changes until you confirm.", style = MaterialTheme.typography.bodySmall)
        } else {
            Text(
                if (dr.supported) "HotCRP's dry run says:" else "HotCRP has no dry run for this; this is a preview against the last sync:",
                Modifier.testTag(WritebackTags.SUPPORTED),
                style = MaterialTheme.typography.labelLarge,
            )
            dr.lines.forEachIndexed { i, l -> Text(l, Modifier.testTag(WritebackTags.diff(i)), style = MaterialTheme.typography.bodyMedium) }
            dr.messages.forEach {
                Text(
                    it,
                    Modifier.testTag(WritebackTags.MESSAGE),
                    color = if (dr.valid) MaterialTheme.colorScheme.secondary else MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.bodySmall,
                )
            }
        }
        rec.mismatch?.let { Text("Mismatch: $it", Modifier.testTag("wb-mismatch"), color = MaterialTheme.colorScheme.error) }
        (rec.artifact as? UserArtifact)?.takeIf { rec.status == WritebackStatus.HANDED_OFF }?.let { u ->
            Text("A chair runs these on the HotCRP server:", style = MaterialTheme.typography.labelLarge)
            u.saveUsersJson().forEachIndexed {
                i,
                j,
                ->
                Text("php batch/saveusers.php -e '$j'", Modifier.testTag("${WritebackTags.HANDOFF}-$i"), style = MaterialTheme.typography.bodySmall)
            }
        }
        error?.let { Text(it, Modifier.testTag("wb-error"), color = MaterialTheme.colorScheme.error) }
        val open = rec.status in setOf(WritebackStatus.DRAFTED, WritebackStatus.DRY_RUN, WritebackStatus.FAILED)
        Row(horizontalArrangement = Arrangement.spacedBy(10.dp), modifier = Modifier.padding(top = 6.dp)) {
            OutlinedButton(
                {
                    busy = true
                    scope.launch {
                        try {
                            withContext(Dispatchers.IO) { session.writeback().dryRun(rec.id) }
                        } catch (e: Exception) {
                            error = e.message ?: e.javaClass.simpleName
                        }
                        busy = false
                        onChanged()
                    }
                },
                Modifier.testTag(WritebackTags.DRY_RUN),
                enabled = open && !busy,
            ) { Text("Dry run") }
            Button(
                {
                    busy = true
                    scope.launch {
                        try {
                            withContext(Dispatchers.IO) {
                                val wb = session.writeback()
                                wb.confirm(rec.id)
                                wb.apply(rec.id)
                            }
                        } catch (e: WritebackException) {
                            error = e.message
                        } catch (e: Exception) {
                            error = e.message ?: e.javaClass.simpleName
                        }
                        busy = false
                        onChanged()
                    }
                },
                Modifier.testTag(WritebackTags.CONFIRM_APPLY),
                enabled = rec.status == WritebackStatus.DRY_RUN && dr?.valid == true && !busy,
            ) { Text("Confirm and apply") }
        }
        Text(
            "Confirming applies exactly what the dry run showed. The next sync checks that HotCRP shows it.",
            Modifier.height(40.dp),
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

/** What the last sync found wrong: applied artifacts HotCRP doesn't show, and traces that don't parse or that someone wrote who may not (spec §11). */
@Composable
fun ReportScreen(session: Session, version: Int) {
    val data by produceRows(version) {
        val mismatches = Ledger.mismatches(session.store).map { "m${it.id}" to "Artifact ${it.id} (${it.summary}) is not what HotCRP shows: ${it.problems}" }
        val issues = ConventionAudit.run(session.store).map { "i" to "${it.kind.label}: ${it.detail}" }
        mismatches + issues
    }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag(WritebackTags.REPORT), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Sync report", style = MaterialTheme.typography.titleMedium)
        Text(
            if (data.isEmpty()) "Nothing to report: every applied change shows in HotCRP, and every trace parses." else "${data.size} to look at",
            Modifier.testTag(WritebackTags.REPORT_SUMMARY),
            style = MaterialTheme.typography.bodyMedium,
        )
        Text(
            "Traces that were forged or don't parse are listed here and never acted on.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.secondary,
        )
        var n = 0
        data.forEach { (k, text) ->
            val tag = if (k.startsWith("m")) WritebackTags.mismatch(k.drop(1).toLong()) else WritebackTags.issue(n++)
            Text(text, Modifier.testTag(tag), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
    }
}
