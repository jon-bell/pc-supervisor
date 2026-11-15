package net.jonbell.pcs.agent.llm

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.longOrNull
import net.jonbell.pcs.agent.checks.Severity
import net.jonbell.pcs.agent.engines.CallResult
import net.jonbell.pcs.agent.engines.Status

/** What a per-call monitor saw. [detail] never repeats paper or model text beyond a short matched phrase. */
data class MonitorHit(val kind: String, val severity: Severity, val detail: String)

/**
 * The per-call monitors of `injection.effect` (agent.md §3.2). Every LLM call is inspected for: a
 * recommendation, score, or verdict the check's schema does not ask for; text that talks about
 * instructions; a refusal or schema failure; a quotation that does not verify (counted by the
 * caller); and a tool call outside the paper's scope. Hits are signals for a person.
 */
object Monitors {
    private val verdictLanguage =
        Regex(
            """\b(?:recommend(?:s|ed|ing|ation)?\s+(?:to\s+|for\s+)?(?:accept|reject|acceptance|rejection)|(?:should|must|deserves? to) be (?:accepted|rejected)|(?:strong(?:ly)?|clear|definite) (?:accept|reject)|top score|highest (?:score|rating)|(?:score|rating) (?:of|is|:)\s*\d|\d+\s*/\s*(?:5|10)\b|outstanding paper|best paper|accept this paper|reject this paper)""",
            RegexOption.IGNORE_CASE,
        )
    private val instructionTalk =
        Regex(
            """\b(?:instructions?|ignore (?:the |all |any |previous |prior )|system prompt|as (?:instructed|requested|directed)|i (?:was|am|have been) (?:told|asked|instructed)|prompt injection)\b""",
            RegexOption.IGNORE_CASE,
        )
    private val toolBlock = Regex(""""type"\s*:\s*"(?:tool_use|server_tool_use)"|"tool_calls"\s*:\s*\[\s*\{""")

    /** Free-text values of an output: everything but fields that hold verbatim quotations. */
    internal fun freeText(e: JsonElement, key: String? = null): List<String> =
        when (e) {
            is JsonObject -> e.entries.flatMap { (k, v) -> freeText(v, k) }
            is JsonArray -> e.flatMap { freeText(it, key) }
            is JsonPrimitive -> if (e.isString && key !in QUOTE_KEYS && key !in STRUCTURAL_KEYS) listOf(e.content) else emptyList()
        }

    private val QUOTE_KEYS = setOf("quote", "abstract_quote")
    private val STRUCTURAL_KEYS = setOf("verdict", "kind", "id", "ref")

    fun inspect(check: ScreenLlmCheck, res: CallResult): List<MonitorHit> {
        val hits = mutableListOf<MonitorHit>()
        when (res.status) {
            Status.REFUSAL -> hits += MonitorHit("refusal", Severity.MEDIUM, "the engine refused")
            Status.SCHEMA_INVALID -> hits += MonitorHit("schema-failure", Severity.MEDIUM, res.detail?.take(120).orEmpty())
            Status.TRUNCATED -> hits += MonitorHit("schema-failure", Severity.MEDIUM, "the output hit the length bound")
            else -> {}
        }
        val out = res.output
        if (res.status == Status.OK && out != null) {
            val text = freeText(out)
            text.firstNotNullOfOrNull { verdictLanguage.find(it)?.value }?.let {
                hits +=
                    MonitorHit("unasked-verdict", Severity.MEDIUM, "output contains \"${it.take(60)}\"")
            }
            if (!check.aboutInstructions) {
                text.firstNotNullOfOrNull { instructionTalk.find(it)?.value }?.let {
                    hits +=
                        MonitorHit("talks-about-instructions", Severity.LOW, "output contains \"${it.take(60)}\"")
                }
            }
            unaskedKeys(check.schema, out)?.let { hits += MonitorHit("unasked-verdict", Severity.MEDIUM, "output has fields the schema does not ask for: $it") }
        }
        toolUse(res.raw)?.let { hits += MonitorHit("tool-call", Severity.HIGH, it) }
        return hits
    }

    /** Keys in the output that the schema's `properties` do not list, at any depth. Null when there are none. */
    private fun unaskedKeys(schema: JsonObject, out: JsonElement): String? {
        val extra = mutableListOf<String>()

        fun walk(s: JsonObject, v: JsonElement, path: String) {
            when (v) {
                is JsonObject -> {
                    val props = s["properties"] as? JsonObject
                    for ((k, child) in v.entries) {
                        val sub = props?.get(k) as? JsonObject
                        if (props != null && sub == null) {
                            extra += "$path.$k"
                        } else if (sub != null) {
                            walk(resolve(schema, sub), child, "$path.$k")
                        }
                    }
                }
                is JsonArray -> (s["items"] as? JsonObject)?.let { items -> v.forEachIndexed { i, c -> walk(resolve(schema, items), c, "$path[$i]") } }
                else -> {}
            }
        }
        walk(schema, out, "$")
        return extra.takeIf { it.isNotEmpty() }?.take(3)?.joinToString()
    }

    private fun resolve(root: JsonObject, s: JsonObject): JsonObject {
        val ref = (s["\$ref"] as? JsonPrimitive)?.content ?: return s
        var cur: JsonElement = root
        for (seg in ref.removePrefix("#/").split('/')) cur = (cur as JsonObject)[seg] ?: return s
        return cur as? JsonObject ?: s
    }

    /** A tool call in a call that offered no tools: block types in the body, or the `claude` envelope's own counters. */
    internal fun toolUse(raw: String): String? {
        if (raw.isBlank()) return null
        toolBlock.find(raw)?.let { return "the response contains a tool call" }
        val env = runCatching { Json.parseToJsonElement(raw.trim()).jsonObject }.getOrNull() ?: return null
        if ((env["permission_denials"] as? JsonArray)?.isNotEmpty() == true) return "the CLI reports denied tool permissions"
        val spawned = ((env["subagent_stats"] as? JsonObject)?.get("spawned") as? JsonPrimitive)?.longOrNull ?: 0L
        if (spawned > 0) return "the CLI reports a spawned sub-agent"
        val st = env["usage"]?.let { (it as? JsonObject)?.get("server_tool_use") as? JsonObject }
        val web = listOf("web_search_requests", "web_fetch_requests").sumOf { (st?.get(it) as? JsonPrimitive)?.longOrNull ?: 0L }
        if (web > 0) return "the CLI reports web tool use"
        return null
    }
}
