package net.jonbell.pcs.agent.engines

import com.sun.net.httpserver.HttpServer
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.engine.mock.toByteArray
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.testing.Covers
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.net.InetAddress
import java.net.InetSocketAddress
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions
import java.util.concurrent.CopyOnWriteArrayList

private val json = Json { ignoreUnknownKeys = true }

private fun Dispatcher.run(engineId: String, r: CallRequest) = runBlocking { call(engineId, r).result }

@Covers("prop:S5")
class ReplayEngineTest {
    @Test
    fun `replay serves what was recorded under the recorded engine's identity and never calls out`(
        @TempDir tmp: Path,
    ) {
        val rec = FileResultStore(tmp.resolve("rec"))
        val live = ScriptedEngine("live") { CallResult("", Status.OK, toyOutput("recorded"), "served", Usage(10, 5)) }
        val recorder = Dispatcher(listOf(Registered(cfg("live", model = "m"), live)), rec)
        val first = recorder.run("live", request())
        assertEquals(1, live.calls.get())

        // A fresh dispatcher whose cache is empty: the replay engine itself serves the result.
        val replay = ReplayEngine("ci", rec)
        val d = Dispatcher(listOf(Registered(cfg("ci", Adapter.REPLAY, model = "m", replayOf = "live", baseUrl = null), replay)), InMemoryResultStore())
        val r = runBlocking { d.call("ci", request()) }
        assertFalse(r.cached)
        assertEquals(Status.OK, r.result.status)
        assertEquals(first.output, r.result.output)
        assertEquals(first.key, r.result.key, "keyed as the engine it replays")
        assertEquals(mapOf("toy.summary" to 1), replay.recorded())
        assertEquals(1, live.calls.get())

        val missing = d.run("ci", request(text = "never recorded"))
        assertEquals(Status.ERROR, missing.status)
        assertTrue(missing.detail!!.contains("no recording"))
        val other = Dispatcher(listOf(Registered(cfg("ci", Adapter.REPLAY, model = "other-model", replayOf = "live", baseUrl = null), replay)))
        assertEquals(Status.ERROR, other.run("ci", request()).status, "a different model is a different key")
    }
}

@Covers("prop:S5")
class OpenAiCompatEngineTest {
    private fun engine(
        structured: String = "json_schema",
        handler: suspend (String) -> Pair<HttpStatusCode, String>,
        seen: MutableList<Triple<String, String?, String>> = mutableListOf(),
    ): Pair<Dispatcher, MutableList<Triple<String, String?, String>>> {
        val mock =
            MockEngine { req ->
                val body = String(req.body.toByteArray())
                seen += Triple(req.url.toString(), req.headers[HttpHeaders.Authorization], body)
                val (status, text) = handler(body)
                respond(text, status, headersOf(HttpHeaders.ContentType, "application/json"))
            }
        val c =
            cfg(
                "sh",
                baseUrl = "http://gpu.example.org:8000/v1",
                structured = structured,
                prices = Prices(java.math.BigDecimal("1"), java.math.BigDecimal("2")),
            )
        return Dispatcher(listOf(Registered(c, OpenAiCompatEngine(c, "dummy-key", mock)))) to seen
    }

    private fun ok(content: String, finish: String = "stop") =
        """{"model":"served-x","choices":[{"finish_reason":"$finish","message":{"role":"assistant","content":${kotlinx.serialization.json.JsonPrimitive(
            content,
        )}}}],"usage":{"prompt_tokens":100,"completion_tokens":20}}"""

    @Test
    fun `a schema-valid answer comes back with usage and cost, and the request carries no sampling parameters`() {
        val (d, seen) = engine(handler = { HttpStatusCode.OK to ok("""{"summary":"s","notes":["n"]}""") })
        val r = d.run("sh", request())
        assertEquals(Status.OK, r.status)
        assertEquals("served-x", r.servedModel)
        assertEquals(Usage(100, 20), r.usage)
        assertEquals(java.math.BigDecimal("0.00014000"), r.costUsd)
        val (url, auth, body) = seen.single()
        assertEquals("http://gpu.example.org:8000/v1/chat/completions", url)
        assertEquals("Bearer dummy-key", auth)
        val b = json.parseToJsonElement(body).jsonObject
        assertEquals("m-sh", b["model"]!!.jsonPrimitive.content)
        assertEquals("json_schema", b["response_format"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals(TOY_SCHEMA, b["response_format"]!!.jsonObject["json_schema"]!!.jsonObject["schema"])
        for (k in listOf("temperature", "top_p", "top_k", "seed")) assertFalse(k in b, k)
        assertTrue(body.contains("<<<DATA"), "paper text is delimited data")
    }

    @Test
    fun `schema failures, refusals, truncation, and http errors are reported as such`() {
        val answers =
            ArrayDeque(
                listOf(
                    HttpStatusCode.OK to ok("""{"summary":""}"""), // schema-invalid (minLength)
                    HttpStatusCode.OK to ok("not json"),
                    HttpStatusCode.OK to ok("{", finish = "length"),
                    HttpStatusCode.OK to """{"model":"m","choices":[{"finish_reason":"stop","message":{"content":null,"refusal":"no"}}]}""",
                    HttpStatusCode.InternalServerError to "oops",
                ),
            )
        val (d, _) = engine(handler = { answers.removeFirst() })
        val statuses = (1..5).map { d.run("sh", request(text = "p$it")).status }
        assertEquals(listOf(Status.SCHEMA_INVALID, Status.SCHEMA_INVALID, Status.TRUNCATED, Status.REFUSAL, Status.ERROR), statuses)
    }

    @Test
    fun `tool mode reads the forced function call, and prompt mode puts the schema in the prompt`() {
        val toolAnswer =
            """{"model":"m","choices":[{"finish_reason":"tool_calls","message":{"tool_calls":""" +
                """[{"function":{"name":"result","arguments":"{\"summary\":\"t\",\"notes\":[]}"}}]}}]}"""
        val (d, seen) = engine("tool", { HttpStatusCode.OK to toolAnswer })
        assertEquals(Status.OK, d.run("sh", request()).status)
        val b = json.parseToJsonElement(seen.single().third).jsonObject
        assertEquals("result", b["tool_choice"]!!.jsonObject["function"]!!.jsonObject["name"]!!.jsonPrimitive.content)
        val (p, seenP) = engine("prompt", { HttpStatusCode.OK to ok("""{"summary":"p","notes":[]}""") })
        assertEquals(Status.OK, p.run("sh", request()).status)
        assertTrue(seenP.single().third.contains("JSON Schema"))
        assertFalse("response_format" in json.parseToJsonElement(seenP.single().third).jsonObject)
    }

    @Test
    fun `it refuses to send a PDF and never contacts a host other than its own`() {
        val (d, seen) = engine(handler = { HttpStatusCode.OK to ok("{}") })
        val pdf = request().copy(parts = listOf(Part.Pdf("p", "AAAA")))
        assertEquals(Status.ERROR, d.run("sh", pdf).status)
        assertTrue(seen.isEmpty())
        // A base URL on a resolver host is rejected when the egress allowlists are checked together.
        val bad = cfg("x", baseUrl = "https://api.crossref.org/v1")
        val e =
            org.junit.jupiter.api.assertThrows<IllegalArgumentException> {
                EgressPolicy.assertDisjoint(listOfNotNull(bad.egressHost()), EgressPolicy.forResolver(null))
            }
        assertTrue(e.message!!.contains("api.crossref.org"))
    }
}

@Covers("prop:S5")
class AnthropicEngineTest {
    private class Fake(val respond: (String) -> Pair<Int, String>) {
        val requests = CopyOnWriteArrayList<Triple<String, Map<String, String>, String>>()
        val server: HttpServer = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)

        init {
            server.createContext("/") { ex ->
                val body = String(ex.requestBody.readAllBytes())
                requests += Triple(ex.requestURI.path, ex.requestHeaders.entries.associate { it.key.lowercase() to it.value.first() }, body)
                val (code, text) = respond(body)
                val bytes = text.toByteArray()
                ex.responseHeaders.add("content-type", "application/json")
                ex.sendResponseHeaders(code, bytes.size.toLong())
                ex.responseBody.use { it.write(bytes) }
            }
            server.start()
        }

        val url get() = "http://127.0.0.1:${server.address.port}"
    }

    private var fake: Fake? = null

    @AfterEach
    fun stop() {
        fake?.server?.stop(0)
    }

    private fun message(text: String, stop: String = "end_turn") =
        """{"id":"msg_1","type":"message","role":"assistant","model":"served-claude","content":[{"type":"text","text":${kotlinx.serialization.json.JsonPrimitive(
            text,
        )}}],"stop_reason":"$stop","stop_sequence":null,"usage":{"input_tokens":120,"output_tokens":30,"cache_read_input_tokens":50,"cache_creation_input_tokens":10}}"""

    private fun dispatcher(f: Fake, key: String? = "dummy-test-key"): Dispatcher {
        fake = f
        val c =
            cfg(
                "api",
                Adapter.ANTHROPIC,
                baseUrl = f.url,
                model = "claude-test-model",
                prices = Prices(java.math.BigDecimal("2"), java.math.BigDecimal("10"), java.math.BigDecimal("0.2"), java.math.BigDecimal("2.5")),
            )
        return Dispatcher(listOf(Registered(c, AnthropicEngine(c, key))))
    }

    @Test
    fun `a native structured request goes to the configured host and a schema-valid answer comes back`() {
        val f = Fake { 200 to message("""{"summary":"s","notes":[]}""") }
        val d = dispatcher(f)
        val r = d.run("api", request().copy(effort = Effort.HIGH))
        assertEquals(Status.OK, r.status)
        assertEquals("served-claude", r.servedModel)
        assertEquals(Usage(120, 30, 50, 10), r.usage)
        assertEquals(java.math.BigDecimal("0.00057500"), r.costUsd.setScale(8), "120 in, 30 out, 50 cache read, 10 cache write at the configured prices")
        val (path, headers, body) = f.requests.single()
        assertEquals("/v1/messages", path)
        assertTrue(headers.values.any { "dummy-test-key" in it }, headers.keys.toString())
        val b = json.parseToJsonElement(body).jsonObject
        assertEquals("claude-test-model", b["model"]!!.jsonPrimitive.content)
        for (k in listOf("temperature", "top_p", "top_k")) assertFalse(k in b, "no sampling parameter $k")
        val oc = b["output_config"]!!.jsonObject
        assertEquals("json_schema", oc["format"]!!.jsonObject["type"]!!.jsonPrimitive.content)
        assertEquals(TOY_SCHEMA["required"], oc["format"]!!.jsonObject["schema"]!!.jsonObject["required"])
        assertEquals("high", oc["effort"]!!.jsonPrimitive.content)
        assertTrue(body.contains("cache_control"), "the stable system prefix has a cache breakpoint")
        assertTrue(body.contains("<<<DATA"))
    }

    @Test
    fun `refusal, truncation, non-JSON, and server errors map to statuses`() {
        val answers =
            ArrayDeque(
                listOf(
                    200 to message("", "refusal"),
                    200 to message("{", "max_tokens"),
                    200 to message("plain words"),
                    400 to """{"type":"error","error":{"type":"invalid_request_error","message":"bad"}}""",
                ),
            )
        val d = dispatcher(Fake { answers.removeFirst() })
        val s = (1..4).map { d.run("api", request(text = "p$it")).status }
        assertEquals(listOf(Status.REFUSAL, Status.TRUNCATED, Status.SCHEMA_INVALID, Status.ERROR), s)
    }

    @Test
    fun `bedrock, vertex, and foundry are configuration only, needing no credential or call is needed to configure them`() {
        val cs =
            listOf(
                cfg("b", Adapter.ANTHROPIC, baseUrl = null, platform = "bedrock", region = "us-east-1"),
                cfg("v", Adapter.ANTHROPIC, baseUrl = null, platform = "vertex", region = "global").copy(project = "p"),
                cfg("f", Adapter.ANTHROPIC, baseUrl = null, platform = "foundry").copy(resource = "res"),
            )
        for (c in cs) {
            assertNotNull(AnthropicEngine(c)) // lazy client: building it here would need credentials
            assertTrue(c.describe().contains("platform=${c.platform}"))
            assertFalse(c.describe().contains("key", ignoreCase = true).and(c.describe().contains("sk-")))
        }
        assertEquals(setOf("bedrock-mantle.us-east-1.api.aws"), cs[0].egressHost()!!.allowedHosts)
        assertEquals(setOf("aiplatform.googleapis.com"), cs[1].egressHost()!!.allowedHosts)
        assertEquals(setOf("res.services.ai.azure.com"), cs[2].egressHost()!!.allowedHosts)
    }
}

@Covers("prop:S5")
class ClaudeCodeEngineTest {
    private fun script(dir: Path, envelope: String, exit: Int = 0): Path {
        val s = dir.resolve("claude")
        Files.writeString(
            s,
            """#!/bin/bash
printf '%s\n' "$@" > "$dir/args.txt"
cat > "$dir/stdin.txt"
pwd > "$dir/cwd.txt"
cat <<'JSON'
$envelope
JSON
exit $exit
""",
        )
        Files.setPosixFilePermissions(s, PosixFilePermissions.fromString("rwxr-xr-x"))
        return s
    }

    private val good =
        """{"type":"result","subtype":"success","is_error":false,"duration_ms":1234,"total_cost_usd":0.0123,"result":"","structured_output":{"summary":"cc","notes":["a"]},"usage":{"input_tokens":200,"output_tokens":40,"cache_read_input_tokens":5,"cache_creation_input_tokens":6},"modelUsage":{"claude-served-model":{}}}"""

    @Test
    fun `a fake claude script is driven with isolation flags, the paper on stdin, and the envelope is parsed`(
        @TempDir tmp: Path,
    ) {
        val s = script(tmp, good)
        val c = cfg("dev", Adapter.CLAUDE_CODE, DataClass.PUBLIC, model = "some-model", baseUrl = null, command = s.toString())
        val d = Dispatcher(listOf(Registered(c, ClaudeCodeEngine(c))))
        val marker = "UNIQUE-PAPER-TEXT-91c4"
        val r = d.run("dev", request(DataClass.PUBLIC, text = marker, system = "System prompt here."))
        assertEquals(Status.OK, r.status)
        assertEquals("claude-served-model", r.servedModel)
        assertEquals(Usage(200, 40, 5, 6), r.usage)
        assertEquals(java.math.BigDecimal("0.0123"), r.costUsd)
        assertEquals(1234, r.latencyMs)
        val args = Files.readAllLines(tmp.resolve("args.txt"))
        for (f in listOf("-p", "--strict-mcp-config", "--no-session-persistence")) assertTrue(f in args, f)

        fun after(flag: String) = args[args.indexOf(flag) + 1]
        assertEquals("json", after("--output-format"))
        assertEquals("", after("--setting-sources"))
        assertEquals("", after("--tools"))
        assertEquals("System prompt here.", after("--system-prompt"))
        assertEquals("some-model", after("--model"))
        assertEquals(TOY_SCHEMA["required"], json.parseToJsonElement(after("--json-schema")).jsonObject["required"])
        assertFalse("--bare" in args, "--bare reads only an API key")
        assertTrue(args.none { marker in it }, "paper text must not appear on the command line")
        assertTrue(Files.readString(tmp.resolve("stdin.txt")).contains(marker))
        assertTrue(Files.readString(tmp.resolve("cwd.txt")).trim().contains("pcs-claude-"), "runs in an empty temporary directory")
    }

    @Test
    fun `refusal, truncation, errors, and a missing binary are statuses`(
        @TempDir tmp: Path,
    ) {
        fun run(envelope: String, exit: Int = 0, command: String? = null): CallResult {
            val dir = Files.createTempDirectory(tmp, "s")
            val c = cfg("dev", Adapter.CLAUDE_CODE, DataClass.PUBLIC, baseUrl = null, command = command ?: script(dir, envelope, exit).toString())
            return Dispatcher(listOf(Registered(c, ClaudeCodeEngine(c)))).run("dev", request(DataClass.PUBLIC))
        }
        assertEquals(Status.REFUSAL, run("""{"is_error":false,"stop_reason":"refusal","result":""}""").status)
        assertEquals(Status.TRUNCATED, run("""{"is_error":false,"stop_reason":"max_tokens","result":"{"}""").status)
        assertEquals(Status.ERROR, run("""{"is_error":true,"subtype":"error_during_execution"}""", exit = 1).status)
        assertEquals(Status.ERROR, run("not an envelope").status)
        assertEquals(Status.OK, run("""{"is_error":false,"result":"{\"summary\":\"from result\",\"notes\":[]}"}""").status, "falls back to parsing result")
        assertEquals(Status.SCHEMA_INVALID, run("""{"is_error":false,"result":"free text"}""").status)
        val missing = run("", command = tmp.resolve("no-such-claude").toString())
        assertEquals(Status.ERROR, missing.status)
        assertTrue(missing.detail!!.contains("cannot start"))
    }
}
