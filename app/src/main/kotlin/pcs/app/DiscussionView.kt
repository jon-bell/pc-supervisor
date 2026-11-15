package pcs.app

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import pcs.core.discussion.AcRow
import pcs.core.discussion.DiscussionReport
import pcs.core.discussion.DiscussionState
import pcs.core.discussion.PaperRisk
import pcs.core.discussion.PersonPage
import pcs.core.discussion.ReviewerRow
import pcs.core.discussion.TimelineEvent
import pcs.core.session.Session
import java.time.Duration
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Test tags of the discussion screen; the view reader reads it back through them. */
object DiscTags {
    const val SCREEN = "discussion"
    const val BLOCKED = "disc-blocked"
    const val NOTE = "disc-note"
    const val AS_OF = "disc-as-of"
    const val PHASE_LINE = "disc-phase-line"
    const val TRI_COUNT = "tri-count"
    const val TRI_CLEAR = "tri-clear"
    const val DRAWER = "drawer"
    const val DRAWER_TITLE = "drawer-title"
    const val DRAWER_META = "drawer-meta"
    const val DRAWER_CLOSE = "drawer-close"
    const val DRAWER_OPEN = "drawer-open-hotcrp"
    const val PERSON_TITLE = "person-title"
    const val PERSON_SUMMARY = "person-summary"
    const val BURN_NOW = "ov-burn-now"
    const val BURN_CHART = "ov-burn-chart"

    fun section(name: String) = "disc-section-$name"

    fun row(pid: Long) = "tri-row-$pid"

    fun cell(pid: Long, col: String) = "tri-$col-$pid"

    fun chip(pid: Long, rule: String) = "tri-chip-$pid-$rule"

    fun filterAc(email: String) = "tri-filter-ac-$email"

    fun filterRule(rule: String) = "tri-filter-rule-$rule"

    fun filterTier(tier: String) = "tri-filter-tier-$tier"

    fun reason(rule: String) = "drawer-reason-$rule"

    fun event(i: Int) = "drawer-event-$i"

    fun tier(name: String) = "disc-tier-$name"

    const val EVERYONE = "disc-everyone"

    fun stage(name: String) = "ov-stage-$name"

    fun spread(n: Int) = "ov-spread-$n"

    fun flaggedAc(email: String) = "ov-ac-$email"

    fun burn(i: Int) = "ov-burn-$i"

    fun progress(group: String) = "ov-progress-$group"
}

enum class DiscSection(val label: String) {
    Triage("Triage"),
    Acs("ACs"),
    Reviewers("Reviewers"),
    Person("Person"),
    Overview("Overview"),
}

private val dateFmt = DateTimeFormatter.ofPattern("yyyy-MM-dd")
private val stampFmt = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm z")

/** "day +3": whole days from discussion opening in the conference's zone; times shown this way don't move from run to run. */
internal fun dayLabel(day: Long, approx: Boolean = false) = "day " + (if (approx) "≈" else "") + (if (day >= 0) "+$day" else "$day")

internal fun dayOf(at: Instant, open: Instant): Long = Math.floorDiv(Duration.between(open, at).toMinutes(), 24 * 60L)

private fun pct(x: Double?) = x?.let { "${Math.round(it * 100)}%" } ?: "none"

private fun hoursText(h: Double?) = h?.let { if (it >= 48) "${Math.round(it / 24)} days" else "${Math.round(it)} h" } ?: DiscussionText.NO_POST_YET

private fun weightColor(w: Int): Color =
    when {
        w >= 4 -> Color(0xFFF4C7C3)
        w == 3 -> Color(0xFFFBD9B5)
        w == 2 -> Color(0xFFFCEBB0)
        else -> Color(0xFFD9E4EC)
    }

fun acColumns(open: Instant): List<Col<AcRow>> =
    listOf(
        Col("ac", "AC", 150, { it.ac.name }, { it.ac.name.lowercase() }),
        Col("load", "Load", 190, { "${it.papers} papers, ${it.flagged} flagged" }, { it.papers }),
        Col("coverage", "Coverage", 90, { pct(it.coverage) }, { it.coverage }),
        Col("first", "First post", 110, { hoursText(it.medianHoursToFirstPost) }, { it.medianHoursToFirstPost }),
        Col("nudges", "Nudges", 140, { "${it.nudges} (${it.mentionNudges} by mention)" }, { it.nudges }),
        Col("stale", "Stale", 70, { it.stale.toString() }, { it.stale }),
        Col("meta", "Metareviews", 150, { r ->
            r.metareviews.entries.sortedBy { it.key }.joinToString(", ") { "${it.value} ${it.key}" }
        }, { it.metareviews.values.sum() }),
        Col("activity", "Last 14 days", 150, { it.activity.joinToString(" ") }, { it.activity.sum() }, chart = { Spark(it.activity) }),
    )

fun reviewerColumns(): List<Col<ReviewerRow>> =
    listOf(
        Col("reviewer", "Reviewer", 130, { it.person.name }, { it.person.name.lowercase() }),
        Col("why", "Seen", 380, { it.outlierReasons.joinToString("; ") }, { it.outlierReasons.size }),
        Col("silent", "Silent on split", 120, { it.silentOnSplit.size.toString() }, { it.silentOnSplit.size }),
        Col("pings", "Unanswered pings", 130, { it.openPings.size.toString() }, { it.openPings.size }),
        Col("late", "Outstanding", 100, { "${it.outstanding} (${it.late} late)" }, { it.outstanding }),
        Col("participation", "Commented on", 120, { r ->
            if (r.inDiscussion ==
                0
            ) {
                "none in discussion"
            } else {
                "${r.commented} of ${r.inDiscussion}"
            }
        }, { it.participation }),
        Col("response", "Reply time", 90, { it.medianResponseHours?.let { h -> hoursText(h) } ?: "" }, { it.medianResponseHours }),
        Col("depth", "Median words", 110, { it.medianWords?.toString().orEmpty() }, { it.medianWords }),
        Col("flags", "Flags (bad/good)", 120, { "${it.negativeFlags}/${it.positiveFlags}" }, { it.negativeFlags }),
        Col("moves", "Score changes", 110, { it.movements.toString() }, { it.movements }),
    )

fun personColumns(open: Instant): List<Col<pcs.core.discussion.PersonPaper>> =
    listOf(
        Col("pid", "#", 50, { it.pid.toString() }, { it.pid }),
        Col("title", "Title", 220, { it.title }, { it.title.lowercase() }),
        Col("merit", "Score", 60, { it.merit?.toString().orEmpty() }, { it.merit }),
        Col("expertise", "Expertise", 80, { it.expertise?.toString().orEmpty() }, { it.expertise }),
        Col("split", "Split", 60, { if (it.split) "split" else "" }, { it.split }),
        Col("last", "Last comment", 130, { it.lastComment?.let { t -> dayLabel(dayOf(t, open)) } ?: DiscussionText.NO_COMMENT_YET }, { it.lastComment }),
        Col("since", "Since opening", 120, { if (it.commentedSinceOpen) "commented" else DiscussionText.NO_COMMENT_YET }, { it.commentedSinceOpen }),
        Col("pings", "Open pings", 260, { p ->
            p.openPings.joinToString("; ") { "${it.by.name}, ${dayLabel(it.ageDays).removePrefix("day ")} old".replace("+", "") }
        }, { it.openPings.size }),
    )

@Composable
private fun Spark(values: List<Int>) {
    val max = (values.maxOrNull() ?: 0).coerceAtLeast(1)
    val color = MaterialTheme.colorScheme.primary
    Canvas(Modifier.width(120.dp).height(18.dp)) {
        val w = size.width / values.size
        values.forEachIndexed { i, v ->
            val h = size.height * v / max
            if (v > 0) drawRect(color, Offset(i * w + 1f, size.height - h), androidx.compose.ui.geometry.Size(w - 2f, h))
        }
    }
}

/**
 * The discussion dashboard (spec §5): the triage list with reason chips and filters, a paper drawer with the timeline of what
 * happened, the AC table, reviewer outlier lists by tier, the person page, and the overview with the no-consensus burndown.
 * It shows what the mirror recorded, as of the last sync, and never anything about who has read what.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DiscussionView(session: Session, opener: UrlOpener, version: Int) {
    val state by produceRows(version) { listOf(session.discussion()) }
    var section by remember { mutableStateOf(DiscSection.Triage) }
    var drawer by remember { mutableStateOf<Long?>(null) }
    var person by remember { mutableStateOf<String?>(null) }
    var acFilter by remember { mutableStateOf(emptySet<String>()) }
    var ruleFilter by remember { mutableStateOf(emptySet<String>()) }
    var tierFilter by remember { mutableStateOf(emptySet<String>()) }
    Column(Modifier.fillMaxSize().testTag(DiscTags.SCREEN), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        when (val s = state.firstOrNull()) {
            null -> Text("Computing…", style = MaterialTheme.typography.bodyMedium)
            is DiscussionState.Blocked ->
                s.reasons.forEach {
                    Text("Blocked: $it", Modifier.testTag(DiscTags.BLOCKED), color = MaterialTheme.colorScheme.error)
                }
            is DiscussionState.Ready -> {
                val report = s.report
                val zone = session.settings.zone
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
                    DiscSection.entries.filter { it != DiscSection.Person || person != null }.forEach { sec ->
                        val b = Modifier.testTag(DiscTags.section(sec.name.lowercase()))
                        if (sec == section) Button({ section = sec }, b) { Text(sec.label) } else OutlinedButton({ section = sec }, b) { Text(sec.label) }
                    }
                    Text("Facts as of the last sync at ", style = MaterialTheme.typography.bodySmall)
                    MaskedText(s.asOf?.let { stampFmt.withZone(zone).format(it) } ?: "no sync yet", DiscTags.AS_OF, widthDp = 150)
                }
                s.notes.forEach {
                    Text(it, Modifier.testTag(DiscTags.NOTE), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                }
                Text(DiscussionText.SEE_NOTE, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.secondary)
                when (section) {
                    DiscSection.Triage ->
                        TriageSection(
                            session,
                            opener,
                            report,
                            zone,
                            drawer,
                            { drawer = it },
                            acFilter,
                            { acFilter = it },
                            ruleFilter,
                            { ruleFilter = it },
                            tierFilter,
                            { tierFilter = it },
                        )
                    DiscSection.Acs -> {
                        Text(DiscussionText.LOAD_NOTE, style = MaterialTheme.typography.bodySmall)
                        Text(DiscussionText.NUDGE_NOTE, style = MaterialTheme.typography.bodySmall)
                        LazyTable("acs", "ACs", report.acs, {
                            it.ac.email
                        }, acColumns(report.phases.discussionOpen), { session.links.paper(0) }, opener, Modifier.weight(1f), onRowClick = {
                            acFilter = setOf(it.ac.email)
                            section = DiscSection.Triage
                        })
                    }
                    DiscSection.Reviewers ->
                        ReviewersSection(report, opener, session) {
                            person = it
                            section = DiscSection.Person
                        }
                    DiscSection.Person -> {
                        val page = person?.let { report.person(it) }
                        if (page ==
                            null
                        ) {
                            Text("Choose a reviewer on the Reviewers tab.")
                        } else {
                            PersonSection(page, report, session, opener) {
                                drawer = it
                                section =
                                    DiscSection.Triage
                            }
                        }
                    }
                    DiscSection.Overview -> OverviewSection(report, zone)
                }
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TriageSection(
    session: Session,
    opener: UrlOpener,
    report: DiscussionReport,
    zone: ZoneId,
    drawer: Long?,
    setDrawer: (Long?) -> Unit,
    acFilter: Set<String>,
    setAc: (Set<String>) -> Unit,
    ruleFilter: Set<String>,
    setRule: (Set<String>) -> Unit,
    tierFilter: Set<String>,
    setTier: (Set<String>) -> Unit,
) {
    val open = report.phases.discussionOpen
    val firing = report.papers.flatMap { p -> p.reasons.map { it.rule } }.toSet()
    val tiers = report.papers.flatMap { it.groups }.toSet()
    val shown =
        report.papers.filter { p ->
            (acFilter.isEmpty() || p.acs.any { it.email in acFilter }) &&
                (ruleFilter.isEmpty() || p.reasons.any { it.rule in ruleFilter }) &&
                (tierFilter.isEmpty() || p.groups.any { it in tierFilter })
        }

    fun <T> toggle(set: Set<T>, x: T) = if (x in set) set - x else set + x
    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(0.dp)) {
            Text("AC:", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.labelLarge)
            report.acs.forEach { a ->
                FilterChip(a.ac.email in acFilter, {
                    setAc(toggle(acFilter, a.ac.email))
                }, { Text(a.ac.name) }, Modifier.testTag(DiscTags.filterAc(a.ac.email)))
            }
            Text("Tier:", Modifier.padding(top = 8.dp, start = 8.dp), style = MaterialTheme.typography.labelLarge)
            tiers.sorted().forEach { t ->
                FilterChip(t in tierFilter, { setTier(toggle(tierFilter, t)) }, { Text(t) }, Modifier.testTag(DiscTags.filterTier(t)))
            }
        }
        FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(0.dp)) {
            Text("Rule:", Modifier.padding(top = 8.dp), style = MaterialTheme.typography.labelLarge)
            DiscussionText.RULE_LABEL.keys.filter { it in firing }.forEach { r ->
                FilterChip(r in ruleFilter, { setRule(toggle(ruleFilter, r)) }, { Text(DiscussionText.rule(r)) }, Modifier.testTag(DiscTags.filterRule(r)))
            }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
            Text(
                if (shown.size == report.papers.size) "${shown.size} papers" else "${shown.size} of ${report.papers.size} papers",
                Modifier.testTag(DiscTags.TRI_COUNT),
                style = MaterialTheme.typography.bodyMedium,
            )
            if (acFilter.isNotEmpty() || ruleFilter.isNotEmpty() || tierFilter.isNotEmpty()) {
                OutlinedButton({
                    setAc(emptySet())
                    setRule(emptySet())
                    setTier(emptySet())
                }, Modifier.testTag(DiscTags.TRI_CLEAR)) { Text("Clear filters") }
            }
        }
    }
    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        Column(Modifier.weight(1f)) {
            Row(Modifier.background(MaterialTheme.colorScheme.surfaceVariant).padding(vertical = 6.dp)) {
                Text("#", Modifier.width(44.dp).padding(horizontal = 6.dp), style = MaterialTheme.typography.labelLarge)
                Text("Paper", Modifier.width(170.dp).padding(horizontal = 6.dp), style = MaterialTheme.typography.labelLarge)
                Text("AC", Modifier.width(110.dp).padding(horizontal = 6.dp), style = MaterialTheme.typography.labelLarge)
                Text("Scores", Modifier.width(70.dp).padding(horizontal = 6.dp), style = MaterialTheme.typography.labelLarge)
                Text("Reasons", Modifier.weight(1f).padding(horizontal = 6.dp), style = MaterialTheme.typography.labelLarge)
                Text("Sev", Modifier.width(40.dp).padding(horizontal = 6.dp), style = MaterialTheme.typography.labelLarge)
                Text("Last activity", Modifier.width(90.dp).padding(horizontal = 6.dp), style = MaterialTheme.typography.labelLarge)
            }
            LazyColumn(Modifier.fillMaxSize()) {
                items(shown, key = { it.pid }) { p ->
                    TriageRow(p, open, p.pid == drawer) { setDrawer(if (drawer == p.pid) null else p.pid) }
                    HorizontalDivider(color = Color(0xFFE3E6EB))
                }
            }
        }
        val d = drawer?.let { report.paper(it) }
        if (d != null) Drawer(session, opener, report, d, open, zone) { setDrawer(null) }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TriageRow(p: PaperRisk, open: Instant, selected: Boolean, onClick: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().background(
            if (selected) Color(0xFFE8F0F6) else Color.Transparent,
        ).clickable(onClick = onClick).padding(vertical = 5.dp).testTag(DiscTags.row(p.pid)),
    ) {
        Text(
            p.pid.toString(),
            Modifier.width(44.dp).padding(horizontal = 6.dp).testTag(DiscTags.cell(p.pid, "pid")),
            style = MaterialTheme.typography.bodyMedium,
        )
        Text(
            p.title,
            Modifier.width(170.dp).padding(horizontal = 6.dp).testTag(DiscTags.cell(p.pid, "title")),
            maxLines = 2,
            style = MaterialTheme.typography.bodyMedium,
        )
        Text(
            p.acs.joinToString { it.name.substringBefore(' ') },
            Modifier.width(110.dp).padding(horizontal = 6.dp).testTag(DiscTags.cell(p.pid, "ac")),
            maxLines = 1,
            style = MaterialTheme.typography.bodyMedium,
        )
        Text(
            p.scores.joinToString(" "),
            Modifier.width(70.dp).padding(horizontal = 6.dp).testTag(DiscTags.cell(p.pid, "scores")),
            style = MaterialTheme.typography.bodyMedium,
        )
        FlowRow(
            Modifier.weight(1f).padding(horizontal = 6.dp),
            horizontalArrangement = Arrangement.spacedBy(4.dp),
            verticalArrangement = Arrangement.spacedBy(3.dp),
        ) {
            p.reasons.forEach { r ->
                Text(
                    DiscussionText.rule(r.rule),
                    Modifier.background(
                        weightColor(r.weight),
                        RoundedCornerShape(10.dp),
                    ).padding(horizontal = 8.dp, vertical = 2.dp).testTag(DiscTags.chip(p.pid, r.rule)),
                    style = MaterialTheme.typography.labelSmall,
                )
            }
        }
        Text(
            p.severity.toString(),
            Modifier.width(40.dp).padding(horizontal = 6.dp).testTag(DiscTags.cell(p.pid, "sev")),
            style = MaterialTheme.typography.bodyMedium,
        )
        Text(
            p.lastActivity?.let { dayLabel(dayOf(it, open)) } ?: "",
            Modifier.width(90.dp).padding(horizontal = 6.dp).testTag(DiscTags.cell(p.pid, "last")),
            maxLines = 1,
            style = MaterialTheme.typography.bodyMedium,
        )
    }
}

@Composable
private fun Drawer(session: Session, opener: UrlOpener, report: DiscussionReport, p: PaperRisk, open: Instant, zone: ZoneId, onClose: () -> Unit) {
    val events = report.timeline(p.pid)
    Column(
        Modifier.width(470.dp).fillMaxHeight().background(Color(0xFFF2F5F8)).padding(10.dp).testTag(DiscTags.DRAWER),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Text("#${p.pid} ${p.title}", Modifier.testTag(DiscTags.DRAWER_TITLE), style = MaterialTheme.typography.titleMedium)
        Text(
            "AC ${p.acs.joinToString {
                it.name
            }}; scores ${p.scores.joinToString(" ")}; severity ${p.severity}; ${DiscussionText.STAGE_LABEL.getValue(p.stage).lowercase()}",
            Modifier.testTag(DiscTags.DRAWER_META),
            style = MaterialTheme.typography.bodySmall,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedButton({ opener.open(session.links.paper(p.pid)) }, Modifier.testTag(DiscTags.DRAWER_OPEN)) { Text("Open in HotCRP") }
            OutlinedButton(onClose, Modifier.testTag(DiscTags.DRAWER_CLOSE)) { Text("Close") }
        }
        if (p.reasons.isEmpty()) Text("No reason chips on this paper.", style = MaterialTheme.typography.bodySmall)
        p.reasons.forEach { r ->
            Text(
                "${DiscussionText.rule(r.rule)} (weight ${r.weight}): ${r.text}",
                Modifier.testTag(DiscTags.reason(r.rule)),
                style = MaterialTheme.typography.bodySmall,
            )
        }
        Text("Timeline", style = MaterialTheme.typography.labelLarge)
        Text(DiscussionText.APPROX_NOTE, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.secondary)
        LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            items(events.size) { i -> EventLine(i, events[i], open, zone) }
        }
    }
}

@Composable
private fun EventLine(i: Int, e: TimelineEvent, open: Instant, zone: ZoneId) {
    Text(
        "${dayLabel(e.day, e.approx)} (${dateFmt.withZone(zone).format(e.at)}) ${e.kind.label}: ${e.who}, ${e.detail}",
        Modifier.testTag(DiscTags.event(i)),
        style = MaterialTheme.typography.bodySmall,
    )
}

@Composable
private fun ReviewersSection(report: DiscussionReport, opener: UrlOpener, session: Session, onPerson: (String) -> Unit) {
    var tier by remember { mutableStateOf("senior") }
    var everyone by remember { mutableStateOf(false) }
    val groups = listOf("senior", "junior", "nominee")
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = androidx.compose.ui.Alignment.CenterVertically) {
        groups.forEach { g ->
            val n = report.outliers(g).size
            FilterChip(g == tier, { tier = g }, { Text("$g ($n)") }, Modifier.testTag(DiscTags.tier(g)))
        }
        FilterChip(everyone, { everyone = !everyone }, { Text("Everyone in the tier") }, Modifier.testTag(DiscTags.EVERYONE))
    }
    val rows = if (everyone) report.reviewers.filter { it.group == tier } else report.outliers(tier)
    LazyTable("reviewers", "reviewers", rows, {
        it.person.email
    }, reviewerColumns(), { session.links.paper(0) }, opener, onRowClick = { onPerson(it.person.email) })
}

@Composable
private fun PersonSection(page: PersonPage, report: DiscussionReport, session: Session, opener: UrlOpener, onPaper: (Long) -> Unit) {
    val r = page.row
    Text("${r.person.name} (${r.group})", Modifier.testTag(DiscTags.PERSON_TITLE), style = MaterialTheme.typography.titleMedium)
    Text(
        "${r.reviews} reviews; commented on ${r.commented} of ${r.inDiscussion} papers in discussion; " +
            "${r.silentOnSplit.size} split paper(s) with no comment yet; " +
            "${r.openPings.size} unanswered @mention(s); ${r.movements} score change(s) since discussion opened; " +
            "${r.negativeFlags} negative and ${r.positiveFlags} good rating flag(s); ${r.outstanding} review(s) outstanding",
        Modifier.testTag(DiscTags.PERSON_SUMMARY),
        style = MaterialTheme.typography.bodySmall,
    )
    LazyTable(
        "person-papers",
        "papers",
        page.papers,
        { it.pid.toString() },
        personColumns(report.phases.discussionOpen),
        { session.links.paper(it.pid) },
        opener,
        onRowClick = { onPaper(it.pid) },
    )
}

@Composable
private fun OverviewSection(report: DiscussionReport, zone: ZoneId) {
    val o = report.overview
    val ph = report.phases
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(10.dp)) {
        Text(
            "Reviews due ${dateFmt.withZone(zone).format(ph.reviewDue)}; discussion opens ${dateFmt.withZone(zone).format(ph.discussionOpen)}; " +
                "decisions due ${dateFmt.withZone(zone).format(ph.decisionsDue)}",
            Modifier.testTag(DiscTags.PHASE_LINE),
            style = MaterialTheme.typography.bodyMedium,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(32.dp)) {
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("Papers by phase", style = MaterialTheme.typography.labelLarge)
                o.stages.forEach { (st, n) ->
                    Text(
                        "${DiscussionText.STAGE_LABEL.getValue(st)}: $n",
                        Modifier.testTag(DiscTags.stage(st.name)),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                Text("Reviewing progress by tier", Modifier.padding(top = 6.dp), style = MaterialTheme.typography.labelLarge)
                o.progress.forEach { p ->
                    Text(
                        "${p.group}: ${p.submitted} of ${p.assigned} submitted, ${p.late} late",
                        Modifier.testTag(DiscTags.progress(p.group)),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("Score spread (max minus min merit)", style = MaterialTheme.typography.labelLarge)
                o.spread.forEach { (k, n) -> Text("spread $k: $n papers", Modifier.testTag(DiscTags.spread(k)), style = MaterialTheme.typography.bodyMedium) }
            }
            Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
                Text("Flagged papers per AC", style = MaterialTheme.typography.labelLarge)
                o.flaggedPerAc.forEach { (ac, n) ->
                    Text("${ac.name}: $n", Modifier.testTag(DiscTags.flaggedAc(ac.email)), style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
        Text("Papers without consensus", style = MaterialTheme.typography.labelLarge)
        Text(
            "${o.openNoConsensus} undecided paper(s) are split now. Solid line: split papers by day since discussion opened; " +
                "dashed: a straight line to zero at the decisions deadline.",
            Modifier.testTag(DiscTags.BURN_NOW),
            style = MaterialTheme.typography.bodySmall,
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Burndown(report, Modifier.width(560.dp).height(200.dp).testTag(DiscTags.BURN_CHART))
            LazyColumn(Modifier.height(200.dp).width(300.dp)) {
                items(o.burndown.size) { i ->
                    val b = o.burndown[i]
                    Text(
                        "${dayLabel(dayOf(b.day, ph.discussionOpen))}: " + (b.withoutConsensus?.let { "$it split" } ?: "not yet") +
                            ", target ${"%.1f".format(b.target)}",
                        Modifier.testTag(DiscTags.burn(i)),
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
            }
        }
    }
}

@Composable
private fun Burndown(report: DiscussionReport, modifier: Modifier) {
    val pts = report.overview.burndown
    val max = (pts.maxOfOrNull { maxOf(it.withoutConsensus ?: 0, Math.ceil(it.target).toInt()) } ?: 1).coerceAtLeast(1)
    val actual = MaterialTheme.colorScheme.primary
    val target = MaterialTheme.colorScheme.secondary
    val grid = Color(0xFFD5D9DF)
    val nowAt = report.now
    Canvas(modifier.background(Color.White)) {
        if (pts.size < 2) return@Canvas

        fun x(i: Int) = size.width * i / (pts.size - 1)

        fun y(v: Double) = (size.height - 8f) * (1 - (v / max)).toFloat() + 4f
        for (g in 0..max) drawLine(grid, Offset(0f, y(g.toDouble())), Offset(size.width, y(g.toDouble())), 1f)
        for (i in 1 until pts.size) {
            drawLine(
                target,
                Offset(x(i - 1), y(pts[i - 1].target)),
                Offset(x(i), y(pts[i].target)),
                2f,
                pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(8f, 6f)),
            )
            val a = pts[i - 1].withoutConsensus
            val b = pts[i].withoutConsensus
            if (a != null && b != null) drawLine(actual, Offset(x(i - 1), y(a.toDouble())), Offset(x(i), y(b.toDouble())), 3f)
        }
        val nowIdx = pts.indexOfLast { it.day <= nowAt }
        if (nowIdx >=
            0
        ) {
            drawLine(
                Color(0xFFB3261E),
                Offset(x(nowIdx), 0f),
                Offset(x(nowIdx), size.height),
                1.5f,
                pathEffect = androidx.compose.ui.graphics.PathEffect.dashPathEffect(floatArrayOf(3f, 3f)),
            )
        }
        drawRect(grid, style = Stroke(1f))
    }
}
