package net.jonbell.pcs.agent.llm

import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import net.jonbell.pcs.agent.engines.CheckDirs
import java.nio.file.Files
import java.nio.file.Path

/**
 * A qualification record (agent.md §7.4): an evaluation run of one (check version, engine, model)
 * that met the check's thresholds. M12 writes them; the manifest only reads them, and shows a record
 * for another version of the check as stale.
 */
@Serializable
data class Qualification(
    val check: String,
    val version: String,
    val engine: String,
    val model: String,
    val variant: String = "",
    val evidence: String = "",
    /** The engine identity's options string (platform, structured mode): a change there is a different engine for caching and for qualification. */
    val options: String = "",
    val corpus: String = "",
    val fingerprint: String = "",
    val at: String = "",
    val metrics: Map<String, Double> = emptyMap(),
    val thresholds: Map<String, Double> = emptyMap(),
    /** SHA-256 of each file of the check version at qualification, so a later edit can be named (`CheckDirs.fileHashes`). */
    val files: Map<String, String> = emptyMap(),
    /** Paper id -> the flags the evaluation raised, for listing the flags a later change moves. */
    val flags: Map<String, List<String>> = emptyMap(),
)

/** One judgment of the system, in exactly one category (agent.md §1.2, §3.3). */
data class ManifestRow(
    val check: String,
    val version: String,
    /** `deterministic, with evidence`, `LLM judgment, bounded`, `differential at run time`, or `escalated to a person`. */
    val category: String,
    val establishedBy: String,
    val qualifiedOn: String,
    val decisions: List<Pair<String, DecisionStatus?>>,
    val affected: String,
) {
    val blockedBy: List<String> get() = decisions.filter { (_, s) -> s == null || s == DecisionStatus.UNRESOLVED }.map { it.first }
}

/**
 * `pcs agent manifest` (agent.md §3.3): one table, rendered from the check directories, the decision
 * file, and the qualification records. The program chairs sign off on this table, not on prompts or code.
 */
object Manifest {
    private val json = Json { ignoreUnknownKeys = true }

    fun loadQualifications(path: Path?): List<Qualification> =
        if (path == null ||
            !Files.isRegularFile(path)
        ) {
            emptyList()
        } else {
            json.decodeFromString(ListSerializer(Qualification.serializer()), Files.readString(path))
        }

    private fun categoryOf(c: String) =
        when (c) {
            "deterministic" -> "deterministic, with evidence"
            "llm" -> "LLM judgment, bounded"
            "differential" -> "differential, at run time"
            "escalated" -> "escalated to a person"
            else -> error("unknown category '$c'")
        }

    fun rows(
        checksRoot: Path,
        decisions: Decisions,
        qualifications: List<Qualification> = emptyList(),
        codeRoot: Path? = checksRoot.parent,
    ): List<ManifestRow> =
        CheckSpec.readAll(checksRoot).map { s ->
            val version = CheckDirs.version(checksRoot.resolve(s.id), codeRoot)
            val established =
                when (s.category) {
                    "deterministic" -> "rule; oracle: ${s.oracleCases} operators/controls, ${s.oraclePositives} plant a defect"
                    "llm" -> "oracle: ${s.oracleCases} labelled cases, ${s.oraclePositives} positive; no cross-engine agreement yet"
                    "differential" -> "with-and-without rerun plus per-call monitors; oracle: ${s.oracleCases} cases"
                    else -> "none: a person decides (not in v1)"
                }
            val qualified =
                if (s.category == "escalated") {
                    "n/a"
                } else {
                    val mine = qualifications.filter { it.check == s.id }
                    val current = mine.filter { it.version == version }
                    when {
                        current.isNotEmpty() ->
                            current.joinToString("; ") {
                                "${it.engine}/${it.model}${if (it.variant.isNotEmpty()) " (${it.variant})" else ""}"
                            }
                        mine.isNotEmpty() -> "stale: qualified at " + mine.joinToString("; ") { it.version }
                        else -> "unqualified"
                    }
                }
            ManifestRow(
                s.id,
                version,
                categoryOf(s.category),
                established,
                qualified,
                s.dependsOn.map {
                    it to decisions[it]?.status
                },
                s.affected.replace(Regex("\\s+"), " "),
            )
        }

    private fun cell(s: String) = s.replace("|", "\\|").replace("\n", " ")

    fun render(rows: List<ManifestRow>, decisions: Decisions): String =
        buildString {
            appendLine("# Screening manifest")
            appendLine()
            appendLine(
                "One row per judgment. Categories: deterministic with evidence, LLM judgment (bounded), differential at run time, escalated to a person.",
            )
            appendLine()
            appendLine("| Check | Version | Category | Established by | Qualified on | Decisions (status) | Who is affected if it is wrong |")
            appendLine("|---|---|---|---|---|---|---|")
            for (r in rows) {
                val d =
                    if (r.decisions.isEmpty()) {
                        "none"
                    } else {
                        r.decisions.joinToString(", ") { (id, st) -> "$id (${st?.key ?: "no record, so unresolved"})" }
                    }
                appendLine(
                    "| `${r.check}` | ${r.version} | ${cell(
                        r.category,
                    )} | ${cell(r.establishedBy)} | ${cell(r.qualifiedOn)} | ${cell(d)} | ${cell(r.affected)} |",
                )
            }
            val blocked = rows.filter { it.blockedBy.isNotEmpty() }
            appendLine()
            if (blocked.isEmpty()) {
                appendLine("No check depends on an unresolved decision.")
            } else {
                appendLine("Blocked: flags from these checks render as blocked until the decision is made.")
                appendLine()
                for (r in blocked) appendLine("- `${r.check}`: ${r.blockedBy.joinToString(", ")}")
            }
            val unsettled = decisions.all.filter { it.status != DecisionStatus.SETTLED }
            if (unsettled.isNotEmpty()) {
                appendLine()
                appendLine("Decisions not settled:")
                appendLine()
                for (d in unsettled) appendLine("- ${d.id} (${d.status.key}, owner ${d.ownerRole}): ${d.title}")
            }
        }
}
