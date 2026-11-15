package net.jonbell.pcs.agent.qualify

import net.jonbell.pcs.agent.engines.CheckDirs
import net.jonbell.pcs.agent.engines.EngineConfig
import net.jonbell.pcs.agent.llm.CheckSpec
import net.jonbell.pcs.agent.llm.Qualification
import java.nio.file.Files
import java.nio.file.Path

/** The three classes of change (agent.md §7.4). */
enum class ChangeClass(val label: String) {
    COVERED("covered by existing evidence"),
    REQUALIFY("needs requalification"),
    NEW_EVIDENCE("needs new evidence"),
}

/** One routed LLM check on its engine, classified. [files] names what differs from the version that was qualified. */
data class CheckChange(
    val check: String,
    val engine: String,
    val cls: ChangeClass,
    val reasons: List<String>,
    val files: List<String>,
    val currentVersion: String,
    val qualifiedVersion: String?,
)

/** A flag the old and new configurations disagree on, on one held-out paper. */
data class FlagMove(val paper: String, val check: String, val flag: String, val gained: Boolean)

/**
 * Change classification for `pcs agent plan` (agent.md §4.4, §7.4). The planner compares what is routed now (check
 * directories, engines) with the qualification records, without spending tokens:
 * - a record for exactly this version, engine, model and options means nothing reruns, whatever else changed
 *   (a price or a concurrency limit is not part of the identity);
 * - an edited prompt, schema, code or spec, or a different model, platform or structured mode, needs requalification;
 * - an edit to the check's oracle, or a check with no labelled positives (unless its `qualification.yaml` names the `summary` rule), needs new evidence before any engine can qualify.
 */
object ChangePlanner {
    fun classify(
        checksRoot: Path,
        codeRoot: Path?,
        routing: Map<String, String>,
        engines: List<EngineConfig>,
        records: List<Qualification>,
    ): List<CheckChange> =
        routing.entries.sortedBy { it.key }.mapNotNull { (check, engineId) ->
            val dir = checksRoot.resolve(check)
            if (!Files.isRegularFile(dir.resolve("prompt.md"))) return@mapNotNull null
            val spec = CheckSpec.read(dir)
            val cfg = engines.firstOrNull { it.id == engineId }
            val version = CheckDirs.version(dir, codeRoot)
            val who = cfg?.identity
            val mine = records.filter { it.check == check && it.engine == (who?.id ?: engineId) }
            val exact = mine.firstOrNull { it.version == version && it.model == who?.model && it.options == who.options && it.variant == Qualifier.VARIANT }
            val reasons = mutableListOf<String>()
            var cls = ChangeClass.COVERED
            val changed = sortedSetOf<String>()

            fun raise(c: ChangeClass, why: String) {
                if (c > cls) cls = c
                reasons += why
            }
            if (cfg == null) raise(ChangeClass.REQUALIFY, "engine '$engineId' is not configured")
            val rule = Thresholds.read(dir)
            if (spec.oraclePositives == 0 &&
                !rule.isSummaryRule
            ) {
                raise(ChangeClass.NEW_EVIDENCE, "the oracle has no labelled positives, so no engine can be qualified on it")
            }
            if (exact == null && cfg != null) {
                val base = mine.maxWithOrNull(compareBy({ it.at }, { it.version }))
                when {
                    base == null -> raise(ChangeClass.REQUALIFY, "no qualification record for this check on '${who!!.id}'")
                    else -> {
                        val now = CheckDirs.fileHashes(dir, codeRoot)
                        if (base.version != version) {
                            if (base.files.isNotEmpty()) {
                                (now.keys + base.files.keys).filter { now[it] != base.files[it] }.forEach { changed += it }
                            }
                            val oracle = changed.filter { it.startsWith("oracle/") }
                            val rest = changed - oracle.toSet()
                            if (oracle.isNotEmpty()) {
                                raise(
                                    ChangeClass.NEW_EVIDENCE,
                                    "oracle changed (${oracle.joinToString()}): new cases or operators need evidence of their own",
                                )
                            }
                            if (rest.isNotEmpty() || changed.isEmpty()) {
                                raise(
                                    ChangeClass.REQUALIFY,
                                    if (rest.isEmpty()) "the check changed since ${base.version}" else "changed since ${base.version}: ${rest.joinToString()}",
                                )
                            }
                        }
                        if (base.model != who!!.model) raise(ChangeClass.REQUALIFY, "model ${base.model} -> ${who.model}")
                        if (base.options != who.options) raise(ChangeClass.REQUALIFY, "engine options ${base.options} -> ${who.options}")
                        if (reasons.none { it.startsWith("changed") || it.startsWith("model") || it.startsWith("engine options") || it.startsWith("oracle") }) {
                            raise(ChangeClass.REQUALIFY, "no record for this exact version, model and variant")
                        }
                    }
                }
            }
            if (reasons.isEmpty()) reasons += "a qualification record matches this version, engine and model"
            CheckChange(check, engineId, cls, reasons, changed.toList(), version, mine.maxWithOrNull(compareBy({ it.at }, { it.version }))?.version)
        }

    /** The flags that differ between the qualified evaluation and a new one: per paper, per flag, gained or lost. */
    fun moves(old: Map<String, List<String>>, new: Map<String, List<String>>): List<FlagMove> =
        (old.keys + new.keys).sorted().flatMap { paper ->
            val a = old[paper].orEmpty().toSet()
            val b = new[paper].orEmpty().toSet()
            (b - a).sorted().map { FlagMove(paper, it.substringBefore('|'), it, true) } +
                (a - b).sorted().map { FlagMove(paper, it.substringBefore('|'), it, false) }
        }

    fun render(changes: List<CheckChange>, moves: Map<String, List<FlagMove>> = emptyMap()): String =
        buildString {
            appendLine("# pcs agent plan: change classification (agent.md 7.4); nothing was called")
            if (changes.isEmpty()) appendLine("no LLM check is routed to an engine (PCS_CHECK_<id>_ENGINE)")
            for (c in changes) {
                appendLine("${c.check} on ${c.engine}: ${c.cls.label.uppercase()}")
                c.reasons.forEach { appendLine("  - $it") }
                if (c.cls !=
                    ChangeClass.COVERED
                ) {
                    appendLine(
                        "  version ${c.qualifiedVersion ?: "(none qualified)"} -> ${c.currentVersion}; rerun the check's evaluation (pcs agent qualify)",
                    )
                }
                val m = moves[c.check]
                if (m != null) {
                    appendLine("  flags it moves on held-out: ${m.size}")
                    m.forEach { appendLine("    ${if (it.gained) "+" else "-"} ${it.paper}: ${it.flag}") }
                }
            }
        }
}
