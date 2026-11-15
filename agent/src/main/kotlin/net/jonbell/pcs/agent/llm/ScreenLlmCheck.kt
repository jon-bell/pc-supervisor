package net.jonbell.pcs.agent.llm

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import net.jonbell.pcs.agent.checks.Severity
import net.jonbell.pcs.agent.engines.CallRequest
import net.jonbell.pcs.agent.engines.CheckDirs
import net.jonbell.pcs.agent.engines.CheckRef
import net.jonbell.pcs.agent.engines.DataClass
import net.jonbell.pcs.agent.engines.Effort
import net.jonbell.pcs.agent.engines.Part
import net.jonbell.pcs.agent.extract.Reference
import net.jonbell.pcs.core.rules.Ground
import java.nio.file.Files
import java.nio.file.Path

/** Where a reference's abstract comes from. M10 uses the abstract variant only; a real resolver is behind this interface (agent.md §5.3). */
fun interface AbstractSource {
    fun abstractFor(ref: Reference): String?

    companion object {
        val NONE = AbstractSource { null }

        /** Abstracts keyed by reference label (`[3]`), for synthetic papers and tests. */
        fun fixed(byLabel: Map<String, String>) = AbstractSource { byLabel[it.label] ?: byLabel[bracket(it.label)] }
    }
}

/** A reference label as cited in text: `3` and `[3]` both give `[3]`. */
fun bracket(label: String) = "[" + label.trim().trim('[', ']') + "]"

/** What the checks need besides the paper: the call for papers and the abstracts of cited works. */
data class CheckEnv(val cfp: String? = null, val abstracts: AbstractSource = AbstractSource.NONE)

/** One request a check makes: its parts, and whatever the check needs to read the answer. */
class LlmUnit(val label: String, val parts: List<Part>, val context: Any? = null)

sealed interface QuoteSource {
    /** Locate in the paper's body text. */
    data object Paper : QuoteSource

    /** Locate in the abstract of reference [ref]. */
    data class Abstract(val ref: String, val abstract: String) : QuoteSource
}

/** A quotation the model returned, to be found by the harness before anyone sees it. */
class Quote(val text: String, val hintPage: Int?, val label: String, val source: QuoteSource = QuoteSource.Paper)

/** A flag before its quotations are located. [anchored] are anchors the harness already has (a pattern match, a citing sentence). */
class Candidate(
    val kind: String,
    val ground: Ground?,
    val severity: Severity,
    val quotes: List<Quote>,
    val fields: Map<String, String> = emptyMap(),
    val anchored: List<FlagAnchor> = emptyList(),
)

class DraftItem(val section: String, val text: String, val quote: Quote)

class Interpretation(val candidates: List<Candidate> = emptyList(), val summary: List<DraftItem>? = null)

/**
 * An LLM check read from its directory (agent.md §3.2): `prompt.md` is the system text, `schema.json`
 * the output schema, `check.yaml` the spec. The version is the content hash of the directory plus the
 * code files `check.yaml` lists, so editing the prompt, the schema, or this check's code is a new version.
 */
abstract class ScreenLlmCheck(dir: Path, codeRoot: Path?) {
    val id: String = dir.fileName.toString()
    val version: String = CheckDirs.version(dir, codeRoot)
    val spec: CheckSpec = CheckSpec.read(dir)
    val system: String = Files.readString(dir.resolve("prompt.md"))
    val schema: JsonObject = Json.parseToJsonElement(Files.readString(dir.resolve("schema.json"))) as JsonObject
    val dependsOn: List<String> get() = spec.dependsOn

    open val maxOutputTokens: Int = 2000
    open val effort: Effort? = null

    /** Whether text in the paper can change this check's answer: then it is rerun without suspect spans (injection.effect). */
    open val readsPaper: Boolean = true

    /** The check's own subject is instructions (the classifier), so talking about them is not a signal. */
    open val aboutInstructions: Boolean = false

    /** How far two signatures may differ (Jaccard distance) before the difference is material. */
    open val materialThreshold: Double = 0.0

    abstract fun units(view: PaperView, env: CheckEnv): List<LlmUnit>

    abstract fun interpret(unit: LlmUnit, out: JsonObject, view: PaperView): Interpretation

    /** The decision-relevant content of an output, for comparing a run with and without a span. */
    abstract fun signature(unit: LlmUnit, out: JsonObject): Set<String>

    fun request(unit: LlmUnit, dataClass: DataClass, decisions: Decisions): CallRequest =
        CallRequest(
            CheckRef(id, version),
            dataClass,
            system,
            unit.parts,
            schema,
            maxOutputTokens,
            effort,
            decisions.keyTokens(dependsOn),
            variant = unit.label,
        )
}

// ---- reading outputs ----------------------------------------------------------------------

internal fun JsonElement?.str(): String? = (this as? JsonPrimitive)?.takeIf { it !is JsonNull }?.contentOrNull

internal fun JsonObject.s(k: String): String = this[k].str().orEmpty()

internal fun JsonObject.page(): Int? = (this["page"] as? JsonPrimitive)?.intOrNull

internal fun JsonObject.arr(k: String): List<JsonObject> = (this[k] as? JsonArray)?.mapNotNull { it as? JsonObject }.orEmpty()

internal fun squash(s: String) = s.replace(Regex("\\s+"), " ").trim()

/** A short comparable form of a quotation or sentence. */
internal fun sigOf(s: String) = squash(s).lowercase().take(60)
