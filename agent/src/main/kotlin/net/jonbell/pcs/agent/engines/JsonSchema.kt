package net.jonbell.pcs.agent.engines

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/**
 * A validator for the subset of JSON Schema that check schemas use (type, enum, const, properties,
 * required, additionalProperties, items, min/max bounds, pattern, anyOf/oneOf/allOf, local `$ref`).
 * It fails closed: a keyword it does not know and that is not an annotation is an error in the
 * schema, so a schema never silently validates less than it says.
 */
object JsonSchema {
    private val annotations = setOf("\$schema", "\$id", "\$comment", "title", "description", "default", "examples", "\$defs", "definitions", "deprecated")
    private val known =
        setOf(
            "type",
            "enum",
            "const",
            "properties",
            "required",
            "additionalProperties",
            "items",
            "minItems",
            "maxItems",
            "minLength",
            "maxLength",
            "minimum",
            "maximum",
            "exclusiveMinimum",
            "exclusiveMaximum",
            "pattern",
            "anyOf",
            "oneOf",
            "allOf",
            "\$ref",
            "uniqueItems",
            "format",
        )

    /** Returns the violations, each as `path: message`; empty means valid. */
    fun validate(schema: JsonObject, value: JsonElement): List<String> {
        val errors = mutableListOf<String>()
        check(schema, schema, value, "$", errors)
        return errors
    }

    private fun resolve(root: JsonObject, ref: String): JsonObject {
        require(ref.startsWith("#/")) { "only local \$ref is supported: $ref" }
        var cur: JsonElement = root
        for (seg in ref.removePrefix("#/").split('/')) {
            cur =
                (cur as? JsonObject)?.get(seg.replace("~1", "/").replace("~0", "~")) ?: error("unresolved \$ref $ref")
        }
        return cur.jsonObject
    }

    private fun typeOk(t: String, v: JsonElement): Boolean =
        when (t) {
            "object" -> v is JsonObject
            "array" -> v is JsonArray
            "string" -> v is JsonPrimitive && v.isString
            "null" -> v is JsonNull
            "boolean" -> v is JsonPrimitive && !v.isString && v.booleanOrNull != null
            "integer" -> v is JsonPrimitive && !v.isString && (v.longOrNull != null || v.doubleOrNull?.let { it == Math.floor(it) } == true)
            "number" -> v is JsonPrimitive && !v.isString && v.doubleOrNull != null
            else -> error("unknown type $t")
        }

    private fun check(root: JsonObject, s: JsonObject, v: JsonElement, path: String, errors: MutableList<String>) {
        for (k in s.keys) require(k in known || k in annotations) { "unsupported schema keyword '$k' at $path" }
        s["\$ref"]?.let { check(root, resolve(root, it.jsonPrimitive.content), v, path, errors) }
        s["type"]?.let { t ->
            val types = if (t is JsonArray) t.map { it.jsonPrimitive.content } else listOf(t.jsonPrimitive.content)
            if (types.none { typeOk(it, v) }) {
                errors += "$path: expected ${types.joinToString("|")}"
                return
            }
        }
        s["enum"]?.let { e -> if (e.jsonArray.none { it == v }) errors += "$path: not one of the allowed values" }
        s["const"]?.let { c -> if (c != v) errors += "$path: must equal $c" }
        s["anyOf"]?.let { alts -> if (alts.jsonArray.none { validate(root, it.jsonObject, v).isEmpty() }) errors += "$path: matches none of anyOf" }
        s["oneOf"]?.let { alts ->
            val n = alts.jsonArray.count { validate(root, it.jsonObject, v).isEmpty() }
            if (n != 1) errors += "$path: matches $n of oneOf (need exactly 1)"
        }
        s["allOf"]?.let { alts -> alts.jsonArray.forEach { check(root, it.jsonObject, v, path, errors) } }
        if (v is JsonObject) {
            val props = s["properties"]?.jsonObject.orEmpty()
            s["required"]?.jsonArray?.forEach { r -> if (r.jsonPrimitive.content !in v) errors += "$path: missing required '${r.jsonPrimitive.content}'" }
            for ((k, child) in v) {
                val ps = props[k]
                if (ps != null) {
                    check(root, ps.jsonObject, child, "$path.$k", errors)
                } else {
                    when (val ap = s["additionalProperties"]) {
                        null -> {}
                        is JsonObject -> check(root, ap, child, "$path.$k", errors)
                        else -> if (ap.jsonPrimitive.booleanOrNull == false) errors += "$path: unexpected property '$k'"
                    }
                }
            }
        }
        if (v is JsonArray) {
            s["minItems"]?.let { if (v.size < it.jsonPrimitive.content.toInt()) errors += "$path: fewer than ${it.jsonPrimitive.content} items" }
            s["maxItems"]?.let { if (v.size > it.jsonPrimitive.content.toInt()) errors += "$path: more than ${it.jsonPrimitive.content} items" }
            if (s["uniqueItems"]?.jsonPrimitive?.booleanOrNull == true && v.toSet().size != v.size) errors += "$path: items not unique"
            s["items"]?.let { items -> v.forEachIndexed { i, e -> check(root, items.jsonObject, e, "$path[$i]", errors) } }
        }
        if (v is JsonPrimitive && v.isString) {
            s["minLength"]?.let { if (v.content.length < it.jsonPrimitive.content.toInt()) errors += "$path: shorter than ${it.jsonPrimitive.content}" }
            s["maxLength"]?.let { if (v.content.length > it.jsonPrimitive.content.toInt()) errors += "$path: longer than ${it.jsonPrimitive.content}" }
            s["pattern"]?.let { if (!Regex(it.jsonPrimitive.content).containsMatchIn(v.content)) errors += "$path: does not match pattern" }
        }
        if (v is JsonPrimitive && !v.isString && v.doubleOrNull != null) {
            val d = v.doubleOrNull!!
            s["minimum"]?.let { if (d < it.jsonPrimitive.content.toDouble()) errors += "$path: below minimum" }
            s["maximum"]?.let { if (d > it.jsonPrimitive.content.toDouble()) errors += "$path: above maximum" }
            s["exclusiveMinimum"]?.let { if (d <= it.jsonPrimitive.content.toDouble()) errors += "$path: not above exclusive minimum" }
            s["exclusiveMaximum"]?.let { if (d >= it.jsonPrimitive.content.toDouble()) errors += "$path: not below exclusive maximum" }
        }
    }

    private fun validate(root: JsonObject, s: JsonObject, v: JsonElement): List<String> = mutableListOf<String>().also { check(root, s, v, "$", it) }
}
