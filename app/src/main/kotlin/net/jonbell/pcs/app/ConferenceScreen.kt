package net.jonbell.pcs.app

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import net.jonbell.pcs.core.session.Session
import net.jonbell.pcs.core.store.Tables
import net.jonbell.pcs.core.writeback.FirstActions
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** The groups of the navigation rail, in process order. */
enum class NavGroup(val label: String) {
    Setup("Setup"),
    Screening("Screening"),
    Assignment("Assignment"),
    Reviewing("Reviewing"),
    Discussion("Discussion"),
    Afterwards("Afterwards"),
    Tools("Tools"),
}

enum class TabName(val label: String, val group: NavGroup) {
    Settings("Settings", NavGroup.Setup),
    Cards("Cards", NavGroup.Setup),
    Triage("Triage", NavGroup.Screening),
    Assignment("Assignment", NavGroup.Assignment),
    EarlyReject("Early reject", NavGroup.Reviewing),
    Accountability("Accountability", NavGroup.Reviewing),
    Discussion("Discussion", NavGroup.Discussion),
    ProcessReport("Process report", NavGroup.Afterwards),
    Papers("Papers", NavGroup.Tools),
    Reviews("Reviews", NavGroup.Tools),
    Writeback("Writeback", NavGroup.Tools),
    Report("Sync report", NavGroup.Tools),
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
    var selectedArtifact by remember { mutableStateOf<Long?>(null) }
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
        Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            NavRail(tab) { tab = it }
            Column(Modifier.weight(1f).fillMaxHeight()) {
                when (tab) {
                    TabName.Papers ->
                        PapersView(session, shell.opener, version) { id ->
                            selectedArtifact = id
                            version++
                            tab = TabName.Writeback
                        }
                    TabName.Reviews -> ReviewsView(session, shell.opener, version)
                    TabName.Discussion -> DiscussionView(session, shell.opener, version)
                    TabName.Assignment ->
                        AssignmentView(session, shell.opener, version) { id ->
                            selectedArtifact = id
                            version++
                            tab = TabName.Writeback
                        }
                    TabName.Triage -> TriageView(session, shell.opener, version)
                    TabName.EarlyReject -> EarlyRejectView(session, shell.opener, version) { version++ }
                    TabName.Accountability -> AccountabilityView(session, shell.opener, version) { version++ }
                    TabName.Writeback -> WritebackScreen(session, shell.opener, version, selectedArtifact, { selectedArtifact = it }, { version++ })
                    TabName.ProcessReport -> ProcessReportView(session, version)
                    TabName.Report -> ReportScreen(session, version)
                    TabName.Settings -> SettingsScreen(session.answers(), session.conference.id) { ChairKeySection(session) }
                    TabName.Cards -> CardGallery(session.answers().readings, venue = session.settings.venue)
                }
            }
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
private fun PapersView(session: Session, opener: UrlOpener, version: Int, onDrafted: (Long) -> Unit) {
    val rows by produceRows(version) { Tables.papers(session.store, session.settings.fieldMerit) }
    LazyTable("papers", "papers", rows, { it.pid.toString() }, paperColumns(), { session.links.paper(it.pid) }, opener, toolbar = { shown ->
        PaperActions(session, shown.map { it.pid }, onDrafted)
    })
}

/** The first Writeback actions on whatever set the table shows (PLAN M5): a copyable HotCRP search, and a chair-attention tag draft. */
@OptIn(androidx.compose.ui.ExperimentalComposeUiApi::class)
@Composable
private fun PaperActions(session: Session, pids: List<Long>, onDrafted: (Long) -> Unit) {
    val clipboard = androidx.compose.ui.platform.LocalClipboard.current
    var link by remember { mutableStateOf<String?>(null) }
    var draftError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    OutlinedButton({
        val l = FirstActions.searchLink(session.links, pids)
        link = l
        scope.launch { clipboard.setClipEntry(androidx.compose.ui.platform.ClipEntry(java.awt.datatransfer.StringSelection(l))) }
    }, Modifier.testTag(Tags.COPY_SEARCH), enabled = pids.isNotEmpty()) { Text("Copy HotCRP search") }
    OutlinedButton({
        scope.launch {
            try {
                val id = withContext(Dispatchers.IO) { session.writeback().draft(FirstActions.chairAttention(pids, session.settings.tagChairAttention)) }
                draftError = null
                onDrafted(id)
            } catch (e: Exception) {
                draftError = e.message ?: e.javaClass.simpleName
            }
        }
    }, Modifier.testTag(Tags.DRAFT_ATTENTION), enabled = pids.isNotEmpty()) { Text("Draft #${session.settings.tagChairAttention} tag") }
    draftError?.let {
        Text("Could not draft: $it", Modifier.testTag(Tags.DRAFT_ERROR), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
    }
    link?.let {
        Text(
            it,
            Modifier.testTag(Tags.SEARCH_LINK).widthIn(max = 200.dp),
            maxLines = 1,
            overflow = androidx.compose.ui.text.style.TextOverflow.Ellipsis,
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun ReviewsView(session: Session, opener: UrlOpener, version: Int) {
    val rows by produceRows(version) { Tables.reviews(session.store, session.settings.fieldMerit, session.settings.fieldExpertise) }
    LazyTable("reviews", "reviews", rows, { it.rid.toString() }, reviewColumns(), { session.links.review(it.pid, it.ordinal, it.rid) }, opener)
}

/**
 * The navigation: a left rail grouped by phase, so the number of views no longer has to fit one row. Each item carries the same
 * `tab-<name>` test tag the tab row had, so a driver clicks it the same way. The rail scrolls if the window is short.
 */
@Composable
private fun NavRail(selected: TabName, onSelect: (TabName) -> Unit) {
    Column(
        Modifier.testTag(Tags.TABS).width(NAV_WIDTH).fillMaxHeight().verticalScroll(rememberScrollState()),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        NavGroup.entries.forEach { g ->
            Text(
                g.label.uppercase(),
                Modifier.padding(start = 8.dp, top = 10.dp, bottom = 2.dp),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.secondary,
            )
            TabName.entries.filter { it.group == g }.forEach { t ->
                val on = t == selected
                Text(
                    t.label,
                    Modifier.testTag(Tags.tab(t.name)).fillMaxWidth().clip(MaterialTheme.shapes.small)
                        .background(if (on) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent)
                        .selectable(on, role = Role.Tab, onClick = { onSelect(t) }).padding(horizontal = 8.dp, vertical = 6.dp),
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                )
            }
        }
    }
}

private val NAV_WIDTH = 168.dp
