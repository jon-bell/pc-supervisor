package net.jonbell.pcs.app

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.State
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import net.jonbell.pcs.core.readings.Answers
import net.jonbell.pcs.core.readings.Card
import net.jonbell.pcs.core.readings.CardOutcome
import net.jonbell.pcs.core.readings.ModelExport
import net.jonbell.pcs.core.readings.QId
import net.jonbell.pcs.core.readings.Readings
import net.jonbell.pcs.core.rules.Venue
import net.jonbell.pcs.core.store.PaperRow
import net.jonbell.pcs.core.store.ReviewRow
import net.jonbell.pcs.core.store.SyncCounts
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** Rows loaded off the UI thread, again whenever [version] changes (after a sync). */
@Composable
fun <T> produceRows(version: Int, load: () -> List<T>): State<List<T>> = produceState(emptyList(), version) { value = withContext(Dispatchers.IO) { load() } }

/** As [produceRows], reloaded also when [key] changes (a choice made on the screen the rows depend on). */
@Composable
fun <T> produceRows(version: Int, key: Any?, load: () -> List<T>): State<List<T>> =
    produceState(emptyList(), version, key) { value = withContext(Dispatchers.IO) { load() } }

fun summarize(c: SyncCounts): String =
    if (c.isNoop) "nothing changed" else "${c.newRows.values.sum()} new, ${c.changed.values.sum()} changed, ${c.gone.values.sum()} gone"

private val day = DateTimeFormatter.ofPattern("yyyy-MM-dd HH:mm").withZone(ZoneId.of("UTC"))

fun paperColumns(): List<Col<PaperRow>> =
    listOf(
        Col("pid", "#", 60, { it.pid.toString() }, { it.pid }),
        Col("title", "Title", 340, { it.title }, { it.title.lowercase() }),
        Col("status", "Status", 110, { it.decision ?: it.status.orEmpty() }, { it.decision ?: it.status }),
        Col("acs", "AC", 160, { it.acs.joinToString(", ") }, { it.acs.joinToString() }),
        Col("reviews", "Reviews", 80, { "${it.reviewsComplete}/${it.reviewsAssigned}" }, { it.reviewsComplete }),
        Col("merits", "Merit", 100, { it.merits.joinToString(" ") }, { it.merits.average().takeIf { a -> !a.isNaN() } }),
        Col("comments", "Comments", 105, { it.comments.toString() }, { it.comments }),
        Col("activity", "Last activity", 150, { it.lastActivity?.let(day::format).orEmpty() }, { it.lastActivity }, masked = true),
        Col("tags", "Tags", 220, { it.tags.joinToString(" ") }, { it.tags.size }, visibleByDefault = false),
    )

fun reviewColumns(): List<Col<ReviewRow>> =
    listOf(
        Col("review", "Review", 80, { "${it.pid}${it.ordinal.orEmpty()}" }, { it.pid * 1000 + (it.ordinal?.firstOrNull()?.code ?: 0) }),
        Col("reviewer", "Reviewer", 200, { it.reviewer }, { it.reviewer.lowercase() }),
        Col("kind", "Kind", 100, { it.kind }, { it.kind }),
        Col("status", "Status", 100, { it.status }, { it.status }),
        Col("merit", "Merit", 70, { it.merit?.toString().orEmpty() }, { it.merit }),
        Col("expertise", "Expertise", 90, { it.expertise?.toString().orEmpty() }, { it.expertise }),
        Col("words", "Words", 70, { it.words.toString() }, { it.words }),
    )

private fun reading(q: QId, key: String?): String = key?.let { k -> q.readings.firstOrNull { it.key == k }?.desc ?: k } ?: "unresolved"

/**
 * The answers file's readings, one per question, with every unresolved question and what it
 * blocks (spec §4.1; concepts §3.1). There is no feature-level dependency map in the model yet, so
 * "blocks" is derived: the example cards whose outcome turns on the question under the answered
 * readings, and the policy cells that are rulings on it (model/export/cards.json, policy.json).
 */
@Composable
fun SettingsScreen(answers: Answers, conference: String) {
    val blocked = remember(answers) { ModelExport.blocked(answers).associateBy { it.question } }
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag("settings"), verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text("Answers for $conference", style = MaterialTheme.typography.titleMedium)
        Text(
            "${QId.entries.size - answers.unresolved.size} of ${QId.entries.size} questions answered, ${answers.unresolved.size} unresolved",
            Modifier.testTag("answers-summary"),
            style = MaterialTheme.typography.bodyMedium,
        )
        if (answers.unresolved.isNotEmpty()) {
            Text(
                "What an unresolved question blocks is derived from the model's example cards and policy table; there is no feature-level dependency map yet.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.secondary,
            )
        }
        answers.errors.forEach {
            Text(it, Modifier.testTag("answers-error"), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
        }
        QId.entries.forEach { q ->
            val key = answers.readings[q]?.key
            Column(Modifier.fillMaxWidth().padding(top = 6.dp).testTag("question-${q.code}")) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(q.code, Modifier.width(44.dp), style = MaterialTheme.typography.titleSmall)
                    Text(q.text, Modifier.width(380.dp), style = MaterialTheme.typography.bodyMedium)
                    Text(
                        reading(q, key),
                        Modifier.testTag("status-${q.code}"),
                        style = MaterialTheme.typography.titleSmall,
                        color = if (key == null) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface,
                    )
                }
                blocked[q]?.let { b ->
                    Column(Modifier.padding(start = 52.dp)) {
                        Text("Blocks:", style = MaterialTheme.typography.labelMedium)
                        b.cards.forEach {
                            Text("card ${it.id}: ${it.text}", Modifier.testTag("blocked-${q.code}-card-${it.id}"), style = MaterialTheme.typography.bodySmall)
                        }
                        b.policyCells.forEach {
                            Text(
                                "permission ${it.role} / ${it.perm}",
                                Modifier.testTag("blocked-${q.code}-cell-${it.role}/${it.perm}"),
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                        if (b.cards.isEmpty() && b.policyCells.isEmpty()) {
                            Text(
                                "nothing in the model's cards or policy table yet",
                                Modifier.testTag("blocked-${q.code}-none"),
                                style = MaterialTheme.typography.bodySmall,
                            )
                        }
                    }
                }
            }
        }
    }
}

/** The card list and one card, under the answered readings. */
@Composable
fun CardGallery(readings: Readings, cards: List<Card> = ModelExport.cards, venue: Venue = Venue()) {
    var selected by remember { mutableStateOf(cards.first().id) }
    Row(Modifier.fillMaxSize().testTag("card-gallery"), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
        Column(Modifier.width(120.dp).verticalScroll(rememberScrollState())) {
            cards.forEach { c -> OutlinedButton({ selected = c.id }, Modifier.testTag("card-link-${c.id}")) { Text(c.id) } }
        }
        CardScreen(cards.first { it.id == selected }, readings, Modifier.weight(1f), venue)
    }
}

/** One card rendered under [readings]: what it depends on, and what the model says. */
@Composable
fun CardScreen(card: Card, readings: Readings, modifier: Modifier = Modifier, venue: Venue = Venue()) {
    Column(modifier.verticalScroll(rememberScrollState()).testTag("card-${card.id}"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Card ${card.id}", style = MaterialTheme.typography.headlineSmall)
        Text(card.text, Modifier.testTag("card-text"), style = MaterialTheme.typography.titleMedium)
        Text("Depends on", style = MaterialTheme.typography.labelLarge)
        card.deps.forEach { q ->
            Text("${q.code} ${q.text}: ${reading(q, readings[q]?.key)}", Modifier.testTag("card-dep-${q.code}"), style = MaterialTheme.typography.bodyMedium)
        }
        card.venueDeps.forEach { n ->
            val v =
                when (n) {
                    "nominees-max" -> venue.nomineesMax.toString()
                    "pattern-min" -> venue.patternMin.toString()
                    "remedy-window-h" -> "${venue.remedyWindowH} h"
                    else -> "${venue.accGraceH} h"
                }
            Text("Venue $n: $v", Modifier.testTag("card-venue-$n"), style = MaterialTheme.typography.bodyMedium)
        }
        when (val o = card.under(readings, venue)) {
            is CardOutcome.Decided -> {
                Text("Under these readings", style = MaterialTheme.typography.labelLarge)
                Text(o.outcome, Modifier.testTag("card-outcome"), style = MaterialTheme.typography.bodyLarge)
            }
            is CardOutcome.Blocked -> {
                Text(
                    "Blocked by ${o.by.joinToString {
                        it.code
                    }}",
                    Modifier.testTag("card-blocked"),
                    color = MaterialTheme.colorScheme.error,
                    style = MaterialTheme.typography.titleSmall,
                )
                Text("Still possible", style = MaterialTheme.typography.labelLarge)
                o.cases.map { it.outcome }.distinct().forEachIndexed {
                    i,
                    out,
                    ->
                    Text(out, Modifier.testTag("card-possible-$i"), style = MaterialTheme.typography.bodyMedium)
                }
            }
        }
    }
}
