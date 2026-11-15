package net.jonbell.pcs.core.hotcrp

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpMethod
import io.ktor.http.URLBuilder
import io.ktor.http.appendPathSegments
import io.ktor.http.contentType
import kotlinx.coroutines.delay
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.net.URI

/** HotCRP's answer to a bulk assignment (`/api/assign`), a dry run or the real thing. */
public data class AssignResult(
    val ok: Boolean,
    val valid: Boolean,
    val dryRun: Boolean,
    val count: Int,
    /** HotCRP's own diff: the assignments that would change something (or did), as it normalizes them. */
    val changes: List<Map<String, String>>,
    val messages: List<String>,
)

/** HotCRP's answer to a comment save, a dry run or the real thing. */
public data class CommentResult(
    val ok: Boolean,
    val dryRun: Boolean,
    val cid: Long?,
    val changeList: List<String>,
    val messages: List<String>,
)

/** The token's own user (`/api/whoami`). */
public data class Whoami(val email: String, val roles: List<String>)

/**
 * The only code in `core` that changes HotCRP (AGENTS.md: every write is a Writeback artifact).
 * Its constructor is internal, so only [net.jonbell.pcs.core.writeback.Writeback] can build one; the read
 * client [HotcrpClient] has no write method. Every call carries `notify=0`: PC Supervisor never
 * sends email (spec §6).
 */
public class HotcrpWriter internal constructor(private val base: URI, private val token: String) : AutoCloseable {
    private val http = HttpClient(CIO) { expectSuccess = false }
    private val json = Json { isLenient = false }

    override fun close(): Unit = http.close()

    private suspend fun post(path: String, params: Map<String, String>, body: String?, method: HttpMethod = HttpMethod.Post): JsonObject {
        val url =
            URLBuilder(base.toString()).apply {
                appendPathSegments("api", path)
                parameters.append("pretty", "0")
                parameters.append("notify", "0")
                params.forEach { (k, v) -> parameters.append(k, v) }
            }.buildString()
        var wait = 1000L
        repeat(8) { attempt ->
            val resp =
                http.request(url) {
                    this.method = method
                    header("Authorization", "Bearer $token")
                    if (body != null) {
                        contentType(ContentType.Application.Json)
                        setBody(body)
                    }
                }
            val code = resp.status.value
            if (code == 429 || code >= 500) {
                if (attempt == 7) throw IllegalStateException("HotCRP $path: HTTP $code")
                val retryAfter = resp.headers["Retry-After"]?.toLongOrNull()?.times(1000)
                delay(minOf(retryAfter ?: wait, 60_000L))
                wait = minOf(wait * 2, 60_000L)
            } else {
                // HotCRP reports refusals as ok=false JSON with a 4xx status; both are decoded the same way
                return json.parseToJsonElement(resp.bodyAsText()).jsonObject
            }
        }
        error("unreachable")
    }

    private fun messages(o: JsonObject): List<String> =
        (o["message_list"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonObject)?.get("message")?.let { m -> (m as? JsonPrimitive)?.content } }
            .map { it.removePrefix("<0>") }

    private fun flag(o: JsonObject, k: String) = (o[k] as? JsonPrimitive)?.content == "true"

    public suspend fun whoami(): Whoami {
        val o = post("whoami", emptyMap(), null, HttpMethod.Get)
        return Whoami(
            (o["email"] as? JsonPrimitive)?.content ?: error("whoami: no email"),
            (o["roles"] as? JsonArray).orEmpty().map { (it as JsonPrimitive).content },
        )
    }

    /** Bulk assignments as a JSON array of rows. With [dryRun], HotCRP changes nothing and answers with the diff. */
    public suspend fun assign(rows: JsonArray, dryRun: Boolean): AssignResult {
        val o = post("assign", mapOf("format" to "json") + (if (dryRun) mapOf("dry_run" to "1") else emptyMap()), rows.toString())
        val changes =
            (o["assignments"] as? JsonArray).orEmpty().map { r -> r.jsonObject.mapValues { (_, v) -> (v as? JsonPrimitive)?.content ?: v.toString() } }
        return AssignResult(
            ok = flag(o, "ok"),
            valid = flag(o, "valid"),
            dryRun = flag(o, "dry_run"),
            count = (o["assignment_count"] as? JsonPrimitive)?.content?.toIntOrNull() ?: changes.size,
            changes = changes,
            messages = messages(o),
        )
    }

    /** Save a comment on [pid] (a new one, or edit [cid]); [actas] posts it as that user (a chair's token only). */
    public suspend fun comment(pid: Long, body: JsonObject, cid: Long?, actas: String?, dryRun: Boolean): CommentResult {
        val params =
            buildMap {
                if (cid != null) put("c", cid.toString())
                if (actas != null) put("actas", actas)
                if (dryRun) put("dry_run", "1")
            }
        val o = post("$pid/comment", params, body.toString())
        return CommentResult(
            ok = flag(o, "ok"),
            dryRun = flag(o, "dry_run"),
            cid = ((o["comment"] as? JsonObject)?.get("cid") as? JsonPrimitive)?.content?.toLongOrNull(),
            changeList = (o["change_list"] as? JsonArray).orEmpty().map { (it as JsonPrimitive).content },
            messages = messages(o),
        )
    }
}
