package pcs.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
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
import pcs.core.assignment.Slot
import pcs.core.assignment.SolveReport
import pcs.core.session.AssignmentState
import pcs.core.session.Session
import java.awt.datatransfer.StringSelection

/** Test tags of the assignment screen; the view reader reads it back through them. */
object AssignmentTags {
    const val SCREEN = "assignment"
    const val BLOCKED = "asg-blocked"
    const val SUMMARY = "asg-summary"
    const val TABLE = "asg-papers"
    const val LOADS = "asg-loads"
    const val REPAIRS = "asg-repairs"
    const val NOMINEES = "asg-nominees"
    const val SIGNALS = "asg-signals"
    const val TPMS = "asg-tpms"
    const val CSV = "asg-csv"
    const val COPY_CSV = "asg-copy-csv"
    const val DRAFT = "asg-draft"
    const val DRAFT_ERROR = "asg-draft-error"
    const val AUDIT = "asg-audit"
}

/** One paper's line of the report. */
data class AssignmentRow(val pid: Long, val status: String, val seniors: String, val others: String, val reason: String)

fun assignmentRows(r: SolveReport): List<AssignmentRow> =
    r.plan.papers.map { p ->
        val short = r.plan.shortfalls.filter { it.pid == p.pid }
        AssignmentRow(
            p.pid,
            if (p.composed) "composed" else "short",
            p.seniors.joinToString { r.build.email(it) },
            (p.thirds + p.neither).joinToString { r.build.email(it) },
            short.sortedBy { it.slot == Slot.THIRD }.joinToString(" | ") { it.reason },
        )
    }

fun assignmentColumns(): List<Col<AssignmentRow>> =
    listOf(
        Col("pid", "#", 60, { it.pid.toString() }, { it.pid }),
        Col("status", "Composition", 120, { it.status }, { it.status }),
        Col("seniors", "Senior seats", 280, { it.seniors }, { it.seniors }),
        Col("others", "Other seats", 280, { it.others }, { it.others }),
        Col("reason", "Why it is short", 520, { it.reason }, { it.reason }),
    )

internal fun assignmentSummary(r: SolveReport): String =
    "${r.plan.composed} of ${r.papers} papers meet their composition; " +
        "senior seats unfilled ${r.plan.seniorShort}, other seats unfilled ${r.plan.thirdShort}; " +
        "${r.plan.repairs.size} edges forbidden by repair; ${r.csv.rows.size} CSV rows"

/**
 * Assignment (spec §10.4 C, §10.5): the plan solved from the mirror and the imports, per paper with the reason a seat is short, the load by tier,
 * nominees against what they owe, repairs, the conflict-engineering signal for the chairs, the TPMS round trip, and the bulk-assign CSV. The screen
 * only shows, copies and drafts: the CSV reaches HotCRP through Writeback's dry run, confirmation and apply.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun AssignmentView(session: Session, opener: UrlOpener, version: Int, onDrafted: (Long) -> Unit) {
    val state by produceRows(version) { listOf(session.assignment()) }
    Column(Modifier.fillMaxSize().testTag(AssignmentTags.SCREEN), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (val s = state.firstOrNull()) {
            null -> Text("Computing…", style = MaterialTheme.typography.bodyMedium)
            is AssignmentState.Blocked ->
                Text(s.reasons.joinToString("\n") { "Blocked: $it" }, Modifier.testTag(AssignmentTags.BLOCKED), color = MaterialTheme.colorScheme.error)
            is AssignmentState.Ready -> Ready(session, opener, s.report, onDrafted)
        }
    }
}

@OptIn(ExperimentalComposeUiApi::class)
@Composable
private fun Ready(session: Session, opener: UrlOpener, r: SolveReport, onDrafted: (Long) -> Unit) {
    val clip = LocalClipboard.current
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    Text(assignmentSummary(r), Modifier.testTag(AssignmentTags.SUMMARY), style = MaterialTheme.typography.titleSmall)
    if (r.audit.isNotEmpty()) {
        Text("The plan breaks its own rules: ${r.audit.joinToString("; ")}", Modifier.testTag(AssignmentTags.AUDIT), color = MaterialTheme.colorScheme.error)
    }
    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        LazyTable(
            AssignmentTags.TABLE,
            "papers",
            assignmentRows(r),
            { it.pid.toString() },
            assignmentColumns(),
            { session.links.paper(it.pid) },
            opener,
            Modifier.weight(2f),
        )
        Column(Modifier.weight(1f).verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            SelectionContainer {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Section(
                        "Load by tier (reviews: reviewers)",
                        AssignmentTags.LOADS,
                        r.loadByTier.entries.joinToString("\n") { (t, h) -> "$t: " + h.entries.joinToString(", ") { "${it.key}: ${it.value}" } } +
                            if (r.plan.bandViolations.isEmpty()) {
                                "\nno band exceeded"
                            } else {
                                "\n" +
                                    r.plan.bandViolations.joinToString("\n") { "OVER BAND: ${r.build.email(it.first)} has ${it.second}" }
                            },
                    )
                    Section(
                        "Nominees against what they owe",
                        AssignmentTags.NOMINEES,
                        r.plan.nominees.joinToString("\n") { n ->
                            "${r.build.email(n.who)}: ${n.load} of ${n.owedSixths?.let {
                                pcs.core.rules.Nominations.showSixths(it)
                            } ?: "a pooled share"} owed" +
                                (n.reason?.let { " (short: $it)" } ?: "")
                        }.ifEmpty { "no accepted nominees" },
                    )
                    Section(
                        "Repairs",
                        AssignmentTags.REPAIRS,
                        (
                            r.plan.repairs.map { "round ${it.round}: forbade ${r.build.email(it.who)} on #${it.pid}: ${it.reason}" } +
                                r.plan.cyclesLeft.map { "STILL IN THE PLAN: cycle ${it.papers.joinToString(" > ") { p -> "#$p" }}" }
                        )
                            .joinToString("\n").ifEmpty { "none" },
                    )
                    Section(
                        "Conflict engineering (for the PC chairs; never a ground)",
                        AssignmentTags.SIGNALS,
                        r.signals.joinToString("\n") {
                            "#${it.pid}: declared conflicts exclude ${it.excluded} of ${it.qualified} qualified reviewers"
                        }.ifEmpty { "none" },
                    )
                    r.tpms?.let { t ->
                        Section(
                            "TPMS round trip",
                            AssignmentTags.TPMS,
                            "${t.imported} imported edges; ${t.issues.size} problems; kept ${t.kept.size}, dropped ${t.dropped.size}, added ${t.added.size}\n" +
                                t.issues.joinToString("\n") { "${r.build.email(it.who)} on #${it.pid}: ${it.problem}" },
                        )
                    }
                    Text("Bulk-assign CSV (HotCRP's assignment tool, or Writeback with its dry run)", style = MaterialTheme.typography.labelLarge)
                    Text(r.csv.toCsv(), Modifier.testTag(AssignmentTags.CSV), style = MaterialTheme.typography.bodySmall)
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton({
                    scope.launch { clip.setClipEntry(ClipEntry(StringSelection(r.csv.toCsv()))) }
                }, Modifier.testTag(AssignmentTags.COPY_CSV)) { Text("Copy CSV") }
                OutlinedButton({
                    scope.launch {
                        try {
                            val id = withContext(Dispatchers.IO) { session.draftAssignment() }
                            error = null
                            onDrafted(id)
                        } catch (e: Exception) {
                            error = e.message ?: e.javaClass.simpleName
                        }
                    }
                }, Modifier.testTag(AssignmentTags.DRAFT), enabled = r.csv.rows.isNotEmpty()) { Text("Draft in Writeback") }
            }
            error?.let { Text("Could not draft: $it", Modifier.testTag(AssignmentTags.DRAFT_ERROR), color = MaterialTheme.colorScheme.error) }
        }
    }
}

@Composable
private fun Section(title: String, tag: String, body: String) {
    Text(title, style = MaterialTheme.typography.labelLarge)
    Text(body, Modifier.testTag(tag), style = MaterialTheme.typography.bodySmall)
}
