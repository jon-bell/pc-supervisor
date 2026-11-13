package pcs.core.hotcrp

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.longOrNull

/** A HotCRP response that doesn't match what we decode: a missing or mistyped key, or a key we don't know. */
public class ContractException(public val problems: List<String>) :
    IllegalStateException("HotCRP response does not match the contract:\n" + problems.joinToString("\n") { "  - $it" })

/**
 * Strict decoding of one JSON object (AGENTS.md: fix the schema, don't hide surprises).
 * Every key read is marked consumed; [finish] reports keys nobody read, except those the
 * caller declares open (review-form fields, which vary by instance).
 */
public class Strict(private val where: String, private val o: JsonObject, private val problems: MutableList<String>) {
    private val used = mutableSetOf<String>()

    private fun el(k: String): JsonElement? { used += k; return o[k] }
    private fun bad(k: String, want: String, got: JsonElement?) { problems += "$where.$k: expected $want, got ${got ?: "nothing"}" }

    public fun string(k: String): String = optString(k) ?: "".also { if (o[k] == null) bad(k, "string", null) }
    public fun optString(k: String): String? = when (val e = el(k)) {
        null, JsonNull -> null
        is JsonPrimitive -> if (e.isString) e.content else e.content.also { bad(k, "string", e) }
        else -> null.also { bad(k, "string", e) }
    }
    public fun long(k: String): Long = optLong(k) ?: 0L.also { if (o[k] == null) bad(k, "number", null) }
    public fun optLong(k: String): Long? = when (val e = el(k)) {
        null, JsonNull -> null
        is JsonPrimitive -> e.longOrNull ?: null.also { bad(k, "number", e) }
        else -> null.also { bad(k, "number", e) }
    }
    public fun optBool(k: String): Boolean? = when (val e = el(k)) {
        null, JsonNull -> null
        is JsonPrimitive -> e.booleanOrNull ?: null.also { bad(k, "boolean", e) }
        else -> null.also { bad(k, "boolean", e) }
    }
    /** A list of strings, or one bare string (HotCRP's encoding of a single flag), or absent. */
    public fun stringsOrOne(k: String): List<String> = when (val e = el(k)) {
        null, JsonNull -> emptyList()
        is JsonPrimitive -> listOf(e.content)
        is JsonArray -> e.map { (it as? JsonPrimitive)?.content ?: "".also { _ -> bad(k, "strings", e) } }
        else -> emptyList<String>().also { bad(k, "strings", e) }
    }
    public fun raw(k: String): JsonElement? = el(k)

    /** Keys not consumed and not in [open]; [ignore] lists keys we know and deliberately don't read. */
    public fun finish(open: (String) -> Boolean = { false }, ignore: Set<String> = emptySet()) {
        val extra = o.keys - used - ignore
        extra.filterNot(open).forEach { problems += "$where: unexpected key $it" }
    }
}
