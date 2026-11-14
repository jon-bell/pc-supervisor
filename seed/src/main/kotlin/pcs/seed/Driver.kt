package pcs.seed

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.long
import kotlinx.serialization.json.put
import java.net.URI
import java.net.URLEncoder
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import java.nio.file.Path
import java.time.LocalDateTime
import java.time.ZoneId

/**
 * Seeds a scenario into the disposable harness (spec §9.3): structure through HotCRP's batch
 * scripts, activity through the API (`actas`, `notify=0`), then a SQL time-warp that moves each
 * object's timestamps together, keeping HotCRP's ordering invariants.
 *
 * Seeding is test infrastructure: it never runs against anything but the local harness.
 */
class Driver(
    private val url: URI,
    private val token: String,
    private val repo: Path,
    private val composeProject: String = "pcs",
    private val zone: ZoneId = ZoneId.of("America/New_York"),
    private val phases: Map<String, LocalDateTime> = CI_PHASES,
) {
    init {
        require(url.host == "127.0.0.1" || url.host == "localhost") { "the seeder runs only against the local harness, not ${url.host}" }
    }

    private val http = HttpClient.newHttpClient()
    private val json = Json { prettyPrint = false }

    fun epoch(at: At): Long {
        val base = phases[at.phase] ?: error("unknown phase ${at.phase}")
        return base.atZone(zone).toEpochSecond() + (at.days * 86400).toLong()
    }

    // ---- harness processes ---------------------------------------------------------

    private fun dc(vararg args: String, stdin: String? = null): String {
        val cmd = listOf("docker", "compose", "-p", composeProject, "-f", repo.resolve("hotcrp/compose.yaml").toString()) + args
        val p = ProcessBuilder(cmd).redirectErrorStream(true).start()
        if (stdin != null) p.outputStream.use { it.write(stdin.toByteArray()) } else p.outputStream.close()
        val out = p.inputStream.bufferedReader().readText()
        check(p.waitFor() == 0) { "docker compose ${args.take(4).joinToString(" ")} failed:\n$out" }
        return out
    }

    private fun php(vararg args: String, stdin: String? = null) = dc("exec", "-T", "hotcrp", "php", *args, stdin = stdin)

    private fun sql(statements: String) = dc("exec", "-T", "db", "mariadb", "-uroot", "-proot", "hotcrp", stdin = statements)

    // ---- API -------------------------------------------------------------------------

    private fun api(method: String, path: String, params: Map<String, String> = emptyMap(), body: String? = null, form: Boolean = false): JsonObject {
        val q = (params + ("pretty" to "0") + ("notify" to "0")).entries.joinToString("&") { "${it.key}=${URLEncoder.encode(it.value, Charsets.UTF_8)}" }
        val b = HttpRequest.newBuilder(URI("$url/api/$path?$q")).header("Authorization", "Bearer $token")
        val req =
            when {
                body == null -> b.method(method, HttpRequest.BodyPublishers.noBody())
                form -> b.header("Content-Type", "application/x-www-form-urlencoded").method(method, HttpRequest.BodyPublishers.ofString(body))
                else -> b.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(body))
            }.build()
        var resp = http.send(req, HttpResponse.BodyHandlers.ofString())
        repeat(40) {
            // the harness keeps HotCRP's rate limits (spec §1): wait out a 429
            if (resp.statusCode() != 429 && !resp.body().trimStart().startsWith("<")) return@repeat // an HTML error page is the harness struggling, not an answer
            Thread.sleep((resp.headers().firstValue("Retry-After").orElse("5").toLong() * 1000).coerceAtMost(60_000))
            resp = http.send(req, HttpResponse.BodyHandlers.ofString())
        }
        check(!resp.body().trimStart().startsWith("<")) { "$method $path: HTTP ${resp.statusCode()} gave HTML: ${resp.body().take(200)}" }
        val o = json.parseToJsonElement(resp.body()).jsonObject
        check(resp.statusCode() in 200..299 && o["ok"] == JsonPrimitive(true)) { "$method $path: HTTP ${resp.statusCode()} ${resp.body().take(400)}" }
        return o
    }

    private fun words(n: Int) = (1..n).joinToString(" ") { "word$it" }

    // ---- seeding -----------------------------------------------------------------------

    data class Seeded(val reviewTimes: Map<Pair<Int, String>, Pair<Long, Long>>, val commentTimes: Map<Long, Long>)

    fun seed(s: Scenario): Seeded {
        php(
            "batch/settings.php",
            "save",
            "-e",
            """{"review_open":true,"review":[{"id":1,"name":"","soft":"2099-01-01","done":"2099-01-02"}],"comment_allow_always":true,""" +
                """"response_active":true,"response":[{"id":1,"name":"","open":"2000-01-01","done":"2099-01-01"}]}""",
        )
        val users =
            buildJsonArray {
                s.pc.forEach { u ->
                    add(
                        buildJsonObject {
                            put("email", u.email)
                            put("firstName", u.first)
                            put("lastName", u.last)
                            put("roles", u.roles)
                            if (u.tags.isNotEmpty()) put("tags", u.tags.joinToString(" ")) // a string: an array is ignored
                        },
                    )
                }
            }
        php("batch/saveusers.php", "-e", users.toString())

        dc("exec", "-T", "hotcrp", "cp", "test/sample50pg.pdf", "/tmp/seed.pdf")
        val papers =
            buildJsonArray {
                s.papers.forEach { p ->
                    add(
                        buildJsonObject {
                            put("pid", p.pid)
                            put("title", p.title)
                            put("abstract", "A synthetic abstract.")
                            put("authors", JsonArray(p.authors.map { buildJsonObject { put("email", it) } }))
                            put("status", "submitted")
                            put(
                                "submission",
                                buildJsonObject {
                                    put("content_file", "seed.pdf")
                                    put("mimetype", "application/pdf")
                                },
                            )
                        },
                    )
                }
            }
        val tmp = Files.createTempFile("pcs-seed", ".json")
        Files.writeString(tmp, papers.toString())
        dc("cp", tmp.toString(), "hotcrp:/tmp/seed.json")
        Files.delete(tmp)
        php("batch/savepapers.php", "/tmp/seed.json")
        php("batch/assign.php", stdin = "paper,action,user\n" + s.assignments.joinToString("\n") { "${it.pid},${it.action},${it.email}" } + "\n")

        // rid and ordinal of each assigned review
        // all review ids at once; a rating re-reads its paper, because HotCRP assigns ordinals on submission
        val ridOf = mutableMapOf<Pair<Int, String>, Long>()
        for (pid in s.papers.map { it.pid }.chunked(200)) {
            api("POST", "reviews", mapOf("q" to "${pid.first()}-${pid.last()}", ":method:" to "GET"))["reviews"]!!.jsonArray.map { it.jsonObject }.forEach {
                val who = it["reviewer_email"]?.jsonPrimitive?.content ?: return@forEach
                ridOf[it["pid"]!!.jsonPrimitive.int to who] = it["rid"]!!.jsonPrimitive.long
            }
        }

        fun rid(pid: Int, who: String): JsonObject =
            api("GET", "reviews", mapOf("q" to "$pid"))["reviews"]!!.jsonArray.map {
                it.jsonObject
            }.first { it["reviewer_email"]?.jsonPrimitive?.content == who }

        val reviewTimes = mutableMapOf<Pair<Int, String>, Pair<Long, Long>>()
        val commentTimes = mutableMapOf<Long, Long>()
        val ordered = s.events.sortedBy { epoch(it.at) }
        // reviews go in batches of 50 per request (HotCRP's rate limit, spec §1); their times are set by the time-warp
        for (batch in ordered.filterIsInstance<SubmitReview>().chunked(50)) {
            val body =
                buildJsonArray {
                    batch.forEach { ev ->
                        add(
                            buildJsonObject {
                                put("pid", ev.pid)
                                put("rid", ridOf.getValue(ev.pid to ev.reviewer))
                                put("OveMer", ev.merit)
                                put("RevExp", ev.expertise)
                                put("PapSum", words(ev.words - 10))
                                put("ComAut", words(10))
                                put("submitted", true)
                            },
                        )
                    }
                }
            val r = api("POST", "reviews", body = body.toString())
            check(r["status_list"]!!.jsonArray.all { it.jsonObject["valid"] == JsonPrimitive(true) }) { "review not valid: $r" }
            batch.forEach { ev -> epoch(ev.at).let { t -> reviewTimes[ev.pid to ev.reviewer] = t to t } }
        }
        for (ev in ordered) {
            when (ev) {
                is SubmitReview -> {}
                is ChangeScore -> {
                    val body =
                        buildJsonArray {
                            add(
                                buildJsonObject {
                                    put("pid", ev.pid)
                                    put("rid", rid(ev.pid, ev.reviewer)["rid"]!!.jsonPrimitive.long)
                                    put("OveMer", ev.merit)
                                    put("submitted", true)
                                },
                            )
                        }
                    api("POST", "reviews", body = body.toString())
                    val (sub, _) = reviewTimes.getValue(ev.pid to ev.reviewer)
                    reviewTimes[ev.pid to ev.reviewer] = sub to epoch(ev.at)
                }
                is PostComment -> {
                    val body =
                        buildJsonObject {
                            put("text", ev.text)
                            if (ev.response) put("response", "1") else put("visibility", "rev")
                        }
                    val r = api("POST", "${ev.pid}/comment", mapOf("actas" to ev.author), body = body.toString())
                    val cid = r["comment"]!!.jsonObject["cid"]!!.jsonPrimitive.long
                    commentTimes[cid] = epoch(ev.at)
                }
                is Rate -> {
                    val ord = rid(ev.pid, ev.reviewer)["ordinal"]!!.jsonPrimitive.content
                    api(
                        "POST",
                        "${ev.pid}/reviewrating",
                        mapOf("r" to ord, "actas" to ev.rater),
                        body =
                            "user_rating=" + URLEncoder.encode(ev.flags.joinToString(" "), Charsets.UTF_8),
                        form = true,
                    )
                }
                is SetDecision -> api("POST", "${ev.pid}/decision", mapOf("decision" to ev.decision))
                is AddTag -> api("POST", "${ev.pid}/tags", body = "addtags=" + URLEncoder.encode(ev.tag, Charsets.UTF_8), form = true)
            }
        }

        // time-warp: each object's timestamps as a unit; timeRequested stays earliest
        val stmts = StringBuilder()
        for ((key, times) in reviewTimes) {
            val (pid, who) = key
            val (sub, mod) = times
            stmts.append(
                "update PaperReview r join ContactInfo c on r.contactId = c.contactId set r.timeRequested = ${sub - 86400 * 20}, " +
                    "r.reviewSubmitted = $sub, r.reviewModified = $mod, r.timeDisplayed = $sub where r.paperId = $pid and c.email = '$who';\n",
            )
        }
        // HotCRP's version history: a submitted earlier version carries the submission time; an empty
        // one, the request time. Otherwise /reviewhistory hides their modified_at (spec §9.3).
        for ((key, times) in reviewTimes) {
            val (pid, who) = key
            val (sub, _) = times
            stmts.append(
                "update PaperReviewHistory h join ContactInfo c on h.contactId = c.contactId set " +
                    "h.reviewModified = if(h.reviewSubmitted > 0, $sub, ${sub - 86400 * 20 + 60}), " +
                    "h.reviewSubmitted = if(h.reviewSubmitted > 0, $sub, h.reviewSubmitted), " +
                    "h.timeDisplayed = if(h.reviewSubmitted > 0, $sub, h.timeDisplayed) where h.paperId = $pid and c.email = '$who';\n",
            )
        }
        val unsubmittedRequested = epoch(At.disc(-33))
        stmts.append("update PaperReview set timeRequested = $unsubmittedRequested where reviewSubmitted is null or reviewSubmitted = 0;\n")
        for ((cid, t) in commentTimes) {
            stmts.append("update PaperComment set timeModified = $t, timeDisplayed = $t, timeNotified = $t where commentId = $cid;\n")
        }
        sql(stmts.toString())
        return Seeded(reviewTimes, commentTimes)
    }

    companion object {
        /** The synthetic conference's phase dates, as in .github/workflows/ci.yml. */
        val CI_PHASES: Map<String, LocalDateTime> =
            mapOf(
                "REVIEW_DUE" to "2030-02-01T23:59",
                "RESPONSE_OPEN" to "2030-02-08T00:00",
                "RESPONSE_CLOSE" to "2030-02-11T23:59",
                "DISCUSSION_OPEN" to "2030-02-12T00:00",
                "DISCUSSION_CLOSE" to "2030-03-01T23:59",
                "DECISIONS_DUE" to "2030-03-03T23:59",
                // the early-reject window (concepts EarlyReject): after review-due, 48 hours
                "EARLYREJECT_OPEN" to "2030-02-02T00:00",
                "EARLYREJECT_CLOSE" to "2030-02-04T00:00",
            ).mapValues { LocalDateTime.parse(it.value) }
    }
}
