package net.jonbell.pcs.runner

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse

/**
 * The raw HotCRP API as the harness's chair, or as any other user (`actas`, spec §11). The runner
 * only ever talks to the harness: [base] is the boundary observer's front for it (PLAN §A6).
 */
class HotcrpApi(val base: URI, private val token: String) {
    private val http = HttpClient.newHttpClient()

    init {
        require(base.host == "127.0.0.1" || base.host == "localhost") { "the runner reaches only the local harness, not ${base.host}" }
    }

    fun call(
        method: String,
        path: String,
        params: Map<String, String> = emptyMap(),
        actas: String? = null,
        json: String? = null,
        form: String? = null,
    ): JsonObject {
        val all = params + ("pretty" to "0") + ("notify" to "0") + (if (actas != null) mapOf("actas" to actas) else emptyMap())
        val q = all.entries.joinToString("&") { "${enc(it.key)}=${enc(it.value)}" }
        val b = HttpRequest.newBuilder(URI("$base/api/$path?$q")).header("Authorization", "Bearer $token")
        val req =
            when {
                json != null -> b.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(json))
                form != null -> b.header("Content-Type", "application/x-www-form-urlencoded").method(method, HttpRequest.BodyPublishers.ofString(form))
                else -> b.method(method, HttpRequest.BodyPublishers.noBody())
            }.build()
        // the harness keeps HotCRP's rate limits: wait out a 429 as the production client does
        repeat(40) {
            val r = http.send(req, HttpResponse.BodyHandlers.ofString())
            if (r.statusCode() != 429) return Json.parseToJsonElement(r.body()).jsonObject
            Thread.sleep((r.headers().firstValue("Retry-After").orElse("5").toLong() * 1000).coerceAtMost(60_000))
        }
        error("$path: still rate-limited")
    }

    fun ok(o: JsonObject): Boolean = o["ok"]?.jsonPrimitive?.content == "true"

    fun assign(vararg rows: String): JsonObject = call("POST", "assign", json = rows.joinToString(",", "[", "]"))

    fun reviews(pid: Long, actas: String? = null): List<JsonObject> =
        call("GET", "$pid/reviews", actas = actas)["reviews"]?.jsonArray?.map { it.jsonObject }.orEmpty()

    fun paper(pid: Long): JsonObject = call("GET", "papers", mapOf("q" to "$pid"))["papers"]!!.jsonArray.single().jsonObject

    fun paperIds(): List<Long> = call("GET", "search", mapOf("q" to "all", "t" to "all"))["ids"]?.jsonArray?.map { it.jsonPrimitive.content.toLong() }.orEmpty()

    private fun enc(s: String) = URLEncoder.encode(s, Charsets.UTF_8)
}

fun JsonObject.str(k: String): String? = this[k]?.let { if (it is JsonNull) null else it.jsonPrimitive.content }

fun JsonElement?.arrayOrEmpty(): JsonArray = (this as? JsonArray) ?: JsonArray(emptyList())
