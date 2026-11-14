package pcs.core

import kotlinx.serialization.json.Json
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
 * Raw access to the harness's HotCRP for integration tests: acting as the chair or, with `actas`,
 * as anyone (spec §11), plus the harness's own batch scripts. Expected results are read here, apart
 * from `core`'s client, so a test never judges Writeback by the code it is testing.
 */
object Hotcrp {
    private val http = HttpClient.newHttpClient()
    private val token = System.getenv("PCS_HOTCRP_TOKEN")!!

    fun api(
        method: String,
        path: String,
        params: Map<String, String> = emptyMap(),
        form: String? = null,
        json: String? = null,
        actas: String? = null,
        auth: Boolean = true,
    ): JsonObject {
        val all = params + ("pretty" to "0") + ("notify" to "0") + (if (actas != null) mapOf("actas" to actas) else emptyMap())
        val q = all.entries.joinToString("&") { "${it.key}=${URLEncoder.encode(it.value, Charsets.UTF_8)}" }
        val b = HttpRequest.newBuilder(URI("${Harness.url}/api/$path?$q")).also { if (auth) it.header("Authorization", "Bearer $token") }
        val req =
            when {
                json != null -> b.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(json))
                form != null -> b.header("Content-Type", "application/x-www-form-urlencoded").method(method, HttpRequest.BodyPublishers.ofString(form))
                else -> b.method(method, HttpRequest.BodyPublishers.noBody())
            }.build()
        repeat(8) {
            val r = http.send(req, HttpResponse.BodyHandlers.ofString())
            if (r.statusCode() != 429) {
                // HotCRP may print PHP deprecation notices before the JSON
                return Json.parseToJsonElement(r.body().let { b -> b.substring(maxOf(0, b.indexOf("{\""))) }).jsonObject
            }
            Thread.sleep((r.headers().firstValue("Retry-After").orElse("5").toLong() * 1000).coerceAtMost(60_000))
        }
        error("$path: still rate-limited")
    }

    /** The HTTP status of a request to a non-API page, for what a token can't reach. */
    fun pageStatus(path: String, form: String): Int {
        val req =
            HttpRequest.newBuilder(URI("${Harness.url}/$path")).header("Authorization", "Bearer $token")
                .header("Content-Type", "application/x-www-form-urlencoded").POST(HttpRequest.BodyPublishers.ofString(form)).build()
        return http.send(req, HttpResponse.BodyHandlers.discarding()).statusCode()
    }

    fun ok(o: JsonObject) = o["ok"]?.jsonPrimitive?.content == "true"

    fun JsonObject.str(k: String) = this[k]?.let { if (it is kotlinx.serialization.json.JsonNull) null else it.jsonPrimitive.content }

    fun php(vararg args: String, stdin: String? = null): String {
        val cmd =
            listOf(
                "docker",
                "compose",
                "-p",
                System.getenv("HOTCRP_COMPOSE_PROJECT") ?: "pcs",
                "-f",
                Repo.path("hotcrp/compose.yaml").toString(),
                "exec",
                "-T",
                "hotcrp",
                "php",
            ) +
                args
        val p = ProcessBuilder(cmd).redirectErrorStream(true).start()
        if (stdin != null) p.outputStream.use { it.write(stdin.toByteArray()) } else p.outputStream.close()
        val out = p.inputStream.bufferedReader().readText()
        check(p.waitFor() == 0) { out }
        return out
    }

    /** The convention setup of spec §11, idempotent: hidden pcs-* tags, the screen round and its Triage field. */
    fun conventions() {
        php(
            "batch/settings.php",
            "save",
            "-e",
            """{"tag_hidden":"pcs-*","review":[{"name":"screen"}],"review_visibility_pc":"after_review",""" +
                """"rf":[{"id":"s90","name":"Triage","type":"radio","required":false,"visibility":"admin","condition":"round:screen",""" +
                """"values":[{"name":"Keep","symbol":1},{"name":"Refer: format","symbol":2},{"name":"Refer: scope","symbol":3}]},""" +
                """{"id":"s01","condition":"round:unnamed"},{"id":"s02","condition":"round:unnamed"}]}""",
        )
    }

    fun tags(pid: Long, actas: String? = null): List<String> =
        api("GET", "$pid/tags", actas = actas)["tags"]?.jsonArray?.map { it.jsonPrimitive.content }.orEmpty()

    fun reviews(pid: Long, actas: String? = null): List<JsonObject> =
        api("GET", "$pid/reviews", actas = actas)["reviews"]?.jsonArray?.map {
            it.jsonObject
        }.orEmpty()

    fun comments(pid: Long, actas: String? = null): List<JsonObject> =
        api("GET", "$pid/comments", actas = actas)["comments"]?.jsonArray?.map {
            it.jsonObject
        }.orEmpty()

    fun paper(pid: Long): JsonObject = api("GET", "papers", mapOf("q" to "$pid"))["papers"]!!.jsonArray.single().jsonObject

    fun pcEmails(): List<String> = api("GET", "pc")["pc"]!!.jsonArray.map { it.jsonObject.str("email")!! }

    fun assign(vararg rows: String): JsonObject = api("POST", "assign", json = rows.joinToString(",", "[", "]"))

    /** A PC member with no review on the paper and not a chair or AC (the golden naming: admin@, ac-*). */
    fun outsider(pid: Long): String {
        val onPaper = reviews(pid).mapNotNull { it.str("reviewer_email") }.toSet()
        return pcEmails().first { it !in onPaper && !it.startsWith("admin") && !it.startsWith("ac-") }
    }

    /** The paper's metareviewer (its AC). */
    fun acOf(pid: Long): String? = reviews(pid).firstOrNull { it.str("rtype") == "5" }?.str("reviewer_email")
}
