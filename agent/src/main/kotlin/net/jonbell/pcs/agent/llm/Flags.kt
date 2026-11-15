package net.jonbell.pcs.agent.llm

import kotlinx.serialization.Serializable
import net.jonbell.pcs.agent.checks.Anchors
import net.jonbell.pcs.agent.checks.Finding
import net.jonbell.pcs.agent.checks.Severity
import net.jonbell.pcs.agent.extract.Extraction

/** A flag whose anchors fail is stored as [UNVERIFIED] and never shown to an AC (agent.md §6). */
@Serializable
enum class FlagStatus { VERIFIED, UNVERIFIED }

/**
 * `(pid, check id + version, decision deps, kind, anchors[], explanation fields, engine, key)`.
 * Blocking is not stored: it is read from the decision file when the card is drawn, so a decision
 * that is settled later unblocks the flag without a rerun.
 */
@Serializable
data class Flag(
    val pid: String,
    val check: String,
    val version: String,
    val dependsOn: List<String>,
    val kind: String,
    val ground: String?,
    val severity: Severity,
    val anchors: List<FlagAnchor>,
    /** Explanation fields. `reason` is the engine's own wording; everything else is measured or copied. */
    val fields: Map<String, String>,
    val engine: String,
    val key: String,
    val status: FlagStatus,
    /** Why the flag is unverified (the quotation that was not found), never the model's prose. */
    val problems: List<String> = emptyList(),
) {
    val verified: Boolean get() = status == FlagStatus.VERIFIED
}

object Flags {
    /** A deterministic finding as a flag. Its anchor is checked the way M8 checks it (S4). */
    fun fromFinding(pid: String, f: Finding, x: Extraction, dependsOn: List<String>): Flag {
        val a = f.anchor
        val anchors =
            if (f.quote != null && a.start != null && a.end != null) {
                listOf(
                    FlagAnchor(
                        if (a.channel != null) FlagAnchor.SOURCE_CHANNEL else FlagAnchor.SOURCE_PAGE,
                        a.start,
                        a.end,
                        f.quote,
                        page = a.page,
                        channel = a.channel,
                        label = "evidence",
                    ),
                )
            } else {
                emptyList()
            }
        val ok = Anchors.verify(x, f)
        val fields =
            buildMap<String, String> {
                f.measured.forEach { (k, v) -> put("measured.$k", v) }
                put("message", f.message)
            }
        return Flag(
            pid,
            f.check,
            f.version,
            dependsOn,
            f.vector,
            f.ground,
            f.severity,
            anchors,
            fields,
            "local",
            "",
            if (ok) FlagStatus.VERIFIED else FlagStatus.UNVERIFIED,
            if (ok) emptyList() else listOf("the quotation is not at its anchor"),
        )
    }
}

/** What a card says, before it is turned into text. One renderer produces every form (agent.md §6). */
data class CardView(
    val title: String,
    /** `BLOCKED` or `OPEN`. A blocked card cannot be acted on until the listed decisions are made. */
    val state: String,
    val blockedBy: List<String>,
    val facts: List<Pair<String, String>>,
    val evidence: List<String>,
    val decisions: List<String>,
    val note: String?,
    val engine: String,
) {
    val blocked: Boolean get() = blockedBy.isNotEmpty()

    fun text(): String =
        buildString {
            appendLine("[$state] $title")
            if (blocked) appendLine("  Blocked: waiting on unresolved ${blockedBy.joinToString(", ")}. This flag cannot be acted on until it is decided.")
            facts.forEach { (k, v) -> appendLine("  $k: $v") }
            evidence.forEach { appendLine("  Evidence: $it") }
            decisions.forEach { appendLine("  Decision: $it") }
            note?.let { appendLine("  Engine's note (unchecked): $it") }
            appendLine("  Produced by: $engine")
        }

    fun markdown(): String =
        buildString {
            appendLine("**[$state] $title**")
            if (blocked) appendLine("\n> Blocked: waiting on unresolved ${blockedBy.joinToString(", ")}.")
            appendLine()
            facts.forEach { (k, v) -> appendLine("- $k: $v") }
            evidence.forEach { appendLine("- Evidence: $it") }
            decisions.forEach { appendLine("- Decision: $it") }
            note?.let { appendLine("- Engine's note (unchecked): $it") }
            appendLine("- Produced by: $engine")
        }
}

object FlagCards {
    private const val QUOTE_MAX = 240
    private const val NOTE_MAX = 300

    private fun squash(s: String) = s.replace(Regex("\\s+"), " ").trim()

    private fun clip(s: String, n: Int) = squash(s).let { if (it.length > n) it.take(n - 1) + "…" else it }

    private fun where(a: FlagAnchor): String =
        when (a.source) {
            FlagAnchor.SOURCE_PAGE -> "p. ${a.page}"
            FlagAnchor.SOURCE_CHANNEL -> "${a.channel}"
            FlagAnchor.SOURCE_ABSTRACT -> "abstract of ${a.ref}"
            else -> a.source
        }

    /** Builds the card of a verified flag. An unverified flag has no card: its text never reaches a person. */
    fun view(flag: Flag, decisions: Decisions): CardView {
        require(flag.verified) { "refusing to render an unverified flag (${flag.check} on ${flag.pid})" }
        val blockedBy = decisions.blockers(flag.dependsOn)
        val facts =
            buildList {
                add("Paper" to flag.pid)
                add("Kind" to flag.kind)
                flag.ground?.let { add("Ground" to it) }
                add("Severity" to flag.severity.name)
                flag.fields.filterKeys { it.startsWith("measured.") }.forEach { (k, v) -> add(k.removePrefix("measured.") to v) }
                flag.fields["message"]?.let { add("What was found" to it) }
                flag.fields.filterKeys { it.startsWith("shown.") }.forEach { (k, v) -> add(k.removePrefix("shown.") to clip(v, NOTE_MAX)) }
            }
        val evidence = flag.anchors.map { a -> "${if (a.label.isNotEmpty()) a.label + ", " else ""}${where(a)}: \"${clip(a.quote, QUOTE_MAX)}\"" }
        val decisionLines =
            flag.dependsOn.map { id ->
                val d = decisions[id]
                if (d == null) "$id: no record, so unresolved" else "$id (${d.status.key}): ${d.title}"
            }
        return CardView(
            "${flag.check}@${flag.version}",
            if (blockedBy.isEmpty()) "OPEN" else "BLOCKED",
            blockedBy,
            facts,
            evidence,
            decisionLines,
            flag.fields["reason"]?.let { clip(it, NOTE_MAX) },
            "${flag.engine}, key ${flag.key.take(12)}",
        )
    }

    /** The cards an AC may see: verified flags only, blocked ones included and marked. Unverified flags are dropped here. */
    fun visible(flags: List<Flag>, decisions: Decisions): List<CardView> = flags.filter { it.verified }.map { view(it, decisions) }

    /** The share of flags (from LLM checks) that did not verify: an evaluation metric (agent.md §6). */
    fun unverifiedRate(flags: List<Flag>): Double = if (flags.isEmpty()) 0.0 else flags.count { !it.verified }.toDouble() / flags.size
}

/** One anchored statement of the summary view. */
data class SummaryItem(val section: String, val text: String, val anchor: FlagAnchor)

/** The `summary` check's view for triage: every statement carries an anchor the harness found; the rest is dropped. */
data class SummaryView(
    val check: String,
    val version: String,
    val engine: String,
    val key: String,
    val items: List<SummaryItem>,
    /** Statements the model produced that could not be anchored. Counted, never shown. */
    val dropped: Int,
) {
    fun text(): String =
        buildString {
            appendLine("Summary (a view for triage, not a recommendation) produced by $engine, $check@$version")
            for ((section, group) in items.groupBy { it.section }) {
                appendLine("  $section")
                group.forEach { appendLine("    - ${it.text}\n      [p. ${it.anchor.page}] \"${it.anchor.quote.replace(Regex("\\s+"), " ").take(200)}\"") }
            }
            if (dropped > 0) appendLine("  ($dropped statement(s) without a verifiable anchor were left out)")
        }
}
