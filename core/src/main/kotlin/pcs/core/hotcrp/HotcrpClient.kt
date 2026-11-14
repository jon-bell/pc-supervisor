package pcs.core.hotcrp

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpMethod
import io.ktor.http.URLBuilder
import io.ktor.http.appendPathSegments
import io.ktor.http.isSuccess
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import java.net.URI

/**
 * The only way `core` talks to HotCRP (AGENTS.md). Bearer auth, `pretty=0`, POST-as-GET for
 * long queries, pid-range chunks with bounded concurrency, and retry with backoff on 429/5xx.
 * The token is held here and never appears in an exception or log message.
 *
 * In strict mode every response is decoded against the contract and any surprise throws a
 * [ContractException]; contract tests run strict, and the sync records surprises instead.
 */
public class HotcrpClient(
    private val base: URI,
    private val token: String,
    private val chunk: Int = 200,
    private val concurrency: Int = 2,
    // the default form, plus the screen round's triage field (spec §11)
    private val formFields: Set<String> = setOf("OveMer", "RevExp", "PapSum", "ComAut", "ComPC", "Tri"),
    public val strict: Boolean = true,
) : AutoCloseable {
    private val http = HttpClient(CIO) { expectSuccess = false }
    private val json = Json { isLenient = false }

    /** Problems found in lenient mode, for the sync's error record. */
    public val drift: MutableList<String> = java.util.Collections.synchronizedList(mutableListOf())

    override fun close(): Unit = http.close()

    private companion object {
        // Keys HotCRP returns that the sync deliberately doesn't read, as observed on the harness
        // at the pinned HOTCRP_REF. Anything else unexpected is drift (ContractTest).
        val PC_UNREAD = setOf("affiliation")
        val PAPER_UNREAD = setOf("abstract", "contacts", "object", "submission", "submitted", "submitted_at", "topics", "options", "final")
        val REVIEW_UNREAD = setOf("blind", "draft", "editable", "modified_at_text", "object", "reviewer", "user_rating", "submitted",
                // the ids of fields a review's round hides (the screen round hides the normal fields, spec §11)
                "hidden_fields", "my_request")
        val COMMENT_UNREAD =
            setOf(
                "author",
                "author_pseudonym",
                "blind",
                "editable",
                "modified_at_text",
                "object",
                "ordinal",
                "by_author",
                "by_shepherd",
                "author_pseudonymous",
                "word_count",
                // set on comments the reading token wrote (observed on the harness for chair-posted comments)
                "viewer_owned",
            )
    }

    private suspend fun call(method: HttpMethod, path: String, params: Map<String, String>): String {
        val url =
            URLBuilder(base.toString()).apply {
                appendPathSegments("api", path)
                parameters.append("pretty", "0")
                if (method == HttpMethod.Post) parameters.append(":method:", "GET")
                params.forEach { (k, v) -> parameters.append(k, v) }
            }.buildString()
        var wait = 1000L
        val attempts = 8
        repeat(attempts) { attempt ->
            val resp =
                http.request(url) {
                    this.method = method
                    header("Authorization", "Bearer $token")
                }
            val code = resp.status.value
            if (resp.status.isSuccess()) return resp.bodyAsText()
            if (code != 429 && code < 500 || attempt == attempts - 1) {
                throw IllegalStateException("HotCRP $path: HTTP $code") // never include the URL's auth or the token
            }
            // HotCRP rate-limits the API: honor Retry-After when given, else back off exponentially (capped)
            val retryAfter = resp.headers["Retry-After"]?.toLongOrNull()?.times(1000)
            delay(minOf(retryAfter ?: wait, 60_000L))
            wait = minOf(wait * 2, 60_000L)
        }
        error("unreachable")
    }

    private fun check(problems: List<String>) {
        if (problems.isEmpty()) return
        if (strict) throw ContractException(problems) else drift += problems
    }

    private fun envelope(where: String, body: String, listKey: String): List<JsonObject> {
        val o = json.parseToJsonElement(body).jsonObject
        val problems = mutableListOf<String>()
        if (o["ok"] != JsonPrimitive(true)) problems += "$where: ok is not true"
        val list = (o[listKey] as? JsonArray)?.map { it.jsonObject } ?: emptyList<JsonObject>().also { problems += "$where: no $listKey list" }
        val extra = o.keys - setOf("ok", listKey, "message_list")
        extra.forEach { problems += "$where: unexpected top-level key $it" }
        check(problems)
        return list
    }

    /** The tags HotCRP lists on `/pc` (those in use on users, not who has them; spec §1), as of the last [pc] call. */
    @Volatile
    public var pcTags: List<String> = emptyList()
        private set

    public suspend fun pc(): List<PcMember> {
        val body = call(HttpMethod.Get, "pc", emptyMap())
        val o = json.parseToJsonElement(body).jsonObject
        val problems = mutableListOf<String>()
        val list = (o["pc"] as? JsonArray) ?: JsonArray(emptyList()).also { problems += "pc: no pc list" }
        val out =
            list.mapIndexed { i, e ->
                val s = Strict("pc[$i]", e.jsonObject, problems)
                val email = s.string("email")
                val first = s.optString("given_name")
                val last = s.optString("family_name")
                val name = listOfNotNull(first, last).joinToString(" ").ifBlank { s.optString("name") }
                val roles = s.stringsOrOne("roles")
                val tags = s.optString("tags")?.split(' ')?.filter { it.isNotBlank() } ?: emptyList()
                s.finish(ignore = PC_UNREAD)
                PcMember(email, name, roles, tags)
            }
        (o.keys - setOf("ok", "pc", "tags", "message_list")).forEach { problems += "pc: unexpected top-level key $it" }
        check(problems)
        pcTags = (o["tags"] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.content }
        return out
    }

    /** `get/pcassignments` as CSV: `paper,action,email,title`, with a leading `clearreview` row per paper. */
    public suspend fun assignments(): List<AssignmentRow> {
        val body = call(HttpMethod.Get, "searchaction", mapOf("action" to "get/pcassignments", "q" to "all"))
        val lines = body.lines().filter { it.isNotBlank() }
        val problems = mutableListOf<String>()
        if (lines.isEmpty() || !lines.first().startsWith("paper,action,email")) problems += "get/pcassignments: unexpected header ${lines.firstOrNull()}"
        val rows =
            lines.drop(1).mapNotNull { line ->
                val f = line.split(",")
                val pid = f.getOrNull(0)?.toLongOrNull()
                if (pid == null || f.size < 2) {
                    problems += "get/pcassignments: bad row $line"
                    null
                } else if (f[1] == "clearreview") {
                    null
                } else {
                    AssignmentRow(pid, f[1], f.getOrElse(2) { "" })
                }
            }
        check(problems)
        return rows
    }

    private suspend fun <T> chunked(pids: List<Long>, f: suspend (String) -> List<T>): List<T> =
        coroutineScope {
            val sem = Semaphore(concurrency)
            val ranges = pids.sorted().chunked(chunk).map { "${it.first()}-${it.last()}" }
            ranges.map { r -> async { sem.withPermit { f(r) } } }.awaitAll().flatten()
        }

    /** Instance settings (admin only). Read leniently: it is configuration, and its key set varies by version. */
    public suspend fun settings(): Map<String, kotlinx.serialization.json.JsonElement> {
        val o = json.parseToJsonElement(call(HttpMethod.Get, "settings", emptyMap())).jsonObject
        return (o["settings"] as? JsonObject).orEmpty()
    }

    public suspend fun paperIds(): List<Long> {
        val body = call(HttpMethod.Get, "search", mapOf("q" to "all", "t" to "all"))
        val o = json.parseToJsonElement(body).jsonObject
        return o["ids"]?.jsonArray?.map { (it as JsonPrimitive).content.toLong() } ?: emptyList()
    }

    public suspend fun papers(pids: List<Long>): List<PaperRecord> =
        chunked(pids) { range ->
            val items = envelope("papers", call(HttpMethod.Post, "papers", mapOf("q" to range)), "papers")
            val problems = mutableListOf<String>()
            val out =
                items.mapIndexed { i, e ->
                    val s = Strict("papers[$i]", e, problems)
                    val authors =
                        (s.raw("authors") as? JsonArray).orEmpty().mapIndexed { j, a ->
                            val sa = Strict("papers[$i].authors[$j]", a.jsonObject, problems)
                            sa.optString("email").orEmpty().also {
                                sa.finish(ignore = setOf("first", "last", "given_name", "family_name", "affiliation", "orcid", "name"))
                            }
                        }
                    val conflicts = (s.raw("pc_conflicts") as? JsonObject).orEmpty().mapValues { (it.value as? JsonPrimitive)?.content ?: it.value.toString() }
                    PaperRecord(
                        pid = s.long("pid"),
                        title = s.optString("title"),
                        status = s.optString("status"),
                        decision = s.optString("decision"),
                        authors = authors,
                        pcConflicts = conflicts,
                        modifiedAt = s.optLong("modified_at"),
                        tags = s.tags("tags"),
                    ).also { s.finish(ignore = PAPER_UNREAD) }
                }
            check(problems)
            out
        }

    public suspend fun reviews(pids: List<Long>): List<Review> =
        chunked(pids) { range ->
            val items = envelope("reviews", call(HttpMethod.Post, "reviews", mapOf("q" to range)), "reviews")
            val problems = mutableListOf<String>()
            val out =
                items.mapIndexed { i, e ->
                    val s = Strict("reviews[$i]", e, problems)
                    val fields = e.filterKeys { it in formFields }
                    fields.keys.forEach { s.raw(it) }
                    Review(
                        rid = s.long("rid"),
                        pid = s.long("pid"),
                        rtype = s.long("rtype").toInt(),
                        status = s.optString("status") ?: "",
                        ordinal = s.optString("ordinal"),
                        reviewerEmail = s.optString("reviewer_email"),
                        version = s.raw("version")?.toString()?.trim('"'),
                        modifiedAt = s.optLong("modified_at"),
                        ratings = s.stringsOrOne("ratings"),
                        fields = fields,
                        round = s.optString("round"),
                    ).also { s.finish(ignore = REVIEW_UNREAD) }
                }
            check(problems)
            out
        }

    /** One review's full version history, newest first (`expand=1`; admin only; one request per review). */
    public suspend fun reviewHistory(pid: Long, rid: Long): List<Review> {
        val o = json.parseToJsonElement(call(HttpMethod.Get, "$pid/reviewhistory", mapOf("r" to "$rid", "expand" to "1"))).jsonObject
        val problems = mutableListOf<String>()
        val out = (o["versions"] as? JsonArray).orEmpty().mapIndexed { i, e -> decodeReview("reviewhistory[$i]", e.jsonObject, problems) }
        (o.keys - setOf("ok", "pid", "rid", "versions", "message_list")).forEach { problems += "reviewhistory: unexpected top-level key $it" }
        check(problems)
        return out
    }

    private fun decodeReview(where: String, e: JsonObject, problems: MutableList<String>): Review {
        val s = Strict(where, e, problems)
        val fields = e.filterKeys { it in formFields }
        fields.keys.forEach { s.raw(it) }
        return Review(
            rid = s.long("rid"),
            pid = s.long("pid"),
            rtype = s.optLong("rtype")?.toInt() ?: 0,
            status = s.optString("status") ?: "",
            ordinal = s.optString("ordinal"),
            reviewerEmail = s.optString("reviewer_email"),
            version = s.raw("version")?.toString()?.trim('"'),
            modifiedAt = s.optLong("modified_at"),
            ratings = s.stringsOrOne("ratings"),
            fields = fields,
            round = s.optString("round"),
        ).also { s.finish(ignore = REVIEW_UNREAD) }
    }

    public suspend fun comments(pids: List<Long>): List<Comment> =
        chunked(pids) { range ->
            val items = envelope("comments", call(HttpMethod.Post, "comments", mapOf("q" to range)), "comments")
            val problems = mutableListOf<String>()
            val out =
                items.mapIndexed { i, e ->
                    val s = Strict("comments[$i]", e, problems)
                    Comment(
                        cid = s.long("cid"),
                        pid = s.long("pid"),
                        authorEmail = s.optString("author_email"),
                        text = s.optString("text"),
                        topic = s.optString("topic"),
                        visibility = s.optString("visibility"),
                        responseRound = s.optString("response"),
                        draft = s.optBool("draft") ?: false,
                        modifiedAt = s.optLong("modified_at"),
                        tags = s.tags("tags"),
                    ).also { s.finish(ignore = COMMENT_UNREAD) }
                }
            check(problems)
            out
        }
}
