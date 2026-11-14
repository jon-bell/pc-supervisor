package pcs.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import pcs.core.session.Session
import pcs.core.store.Tables
import java.time.ZoneId
import java.time.format.DateTimeFormatter

enum class TabName(val label: String) {
    Papers("Papers"),
    Reviews("Reviews"),
    EarlyReject("Early reject"),
    Settings("Settings"),
    Cards("Cards"),
}

/** What the sync button shows. */
sealed interface SyncState {
    data object Idle : SyncState

    data object Running : SyncState

    data class Done(val summary: String) : SyncState

    data class Failed(val message: String) : SyncState
}

private val timeFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm 'UTC'").withZone(ZoneId.of("UTC"))

/** One open conference: the header with sync status, then the tabs. */
@Composable
fun ConferenceScreen(shell: Shell, session: Session, onSwitch: () -> Unit) {
    var tab by remember { mutableStateOf(TabName.Papers) }
    var sync by remember { mutableStateOf<SyncState>(SyncState.Idle) }
    var version by remember { mutableStateOf(0) }
    var lastSync by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(version) {
        lastSync = withContext(Dispatchers.IO) { session.lastSync() }?.let { timeFormat.format(it.finishedAt) }
    }
    Column(Modifier.fillMaxSize().padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Text(session.conference.id, style = MaterialTheme.typography.headlineSmall)
            Text(session.settings.hotcrpUrl.toString(), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.secondary)
            Row(Modifier.weight(1f), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                Text("Last sync: ", style = MaterialTheme.typography.bodyMedium)
                MaskedText(lastSync ?: "never", Tags.LAST_SYNC)
            }
            val running = sync is SyncState.Running
            Button(
                {
                    sync = SyncState.Running
                    scope.launch {
                        sync =
                            try {
                                val counts = withContext(Dispatchers.IO) { session.sync() }
                                version++
                                SyncState.Done(summarize(counts))
                            } catch (e: Exception) {
                                SyncState.Failed(e.message ?: e.javaClass.simpleName)
                            }
                    }
                },
                Modifier.testTag(Tags.SYNC_NOW),
                enabled = !running,
            ) { Text(if (running) "Syncing…" else "Sync now") }
            OutlinedButton(onSwitch) { Text("Switch conference") }
        }
        SyncStatus(sync)
        PrimaryTabRow(tab.ordinal, Modifier.testTag(Tags.TABS)) {
            TabName.entries.forEach { t -> Tab(tab == t, { tab = t }, Modifier.testTag(Tags.tab(t.name)), text = { Text(t.label) }) }
        }
        when (tab) {
            TabName.Papers -> PapersView(session, shell.opener, version)
            TabName.Reviews -> ReviewsView(session, shell.opener, version)
            TabName.EarlyReject -> EarlyRejectView(session, shell.opener, version)
            TabName.Settings -> SettingsScreen(session.answers(), session.conference.id)
            TabName.Cards -> CardGallery(session.answers().readings)
        }
    }
}

@Composable
private fun SyncStatus(s: SyncState) {
    val (text, color) =
        when (s) {
            SyncState.Idle -> "" to MaterialTheme.colorScheme.secondary
            SyncState.Running -> "Sync running" to MaterialTheme.colorScheme.secondary
            is SyncState.Done -> "Synced: ${s.summary}" to MaterialTheme.colorScheme.secondary
            is SyncState.Failed -> "Sync failed: ${s.message}" to MaterialTheme.colorScheme.error
        }
    if (text.isNotEmpty()) Text(text, Modifier.testTag(Tags.SYNC_STATUS), color = color, style = MaterialTheme.typography.bodyMedium)
}

@Composable
private fun PapersView(session: Session, opener: UrlOpener, version: Int) {
    val rows by produceRows(version) { Tables.papers(session.store, session.settings.fieldMerit) }
    LazyTable("papers", "papers", rows, { it.pid.toString() }, paperColumns(), { session.links.paper(it.pid) }, opener)
}

@Composable
private fun ReviewsView(session: Session, opener: UrlOpener, version: Int) {
    val rows by produceRows(version) { Tables.reviews(session.store, session.settings.fieldMerit, session.settings.fieldExpertise) }
    LazyTable("reviews", "reviews", rows, { it.rid.toString() }, reviewColumns(), { session.links.review(it.pid, it.ordinal, it.rid) }, opener)
}
