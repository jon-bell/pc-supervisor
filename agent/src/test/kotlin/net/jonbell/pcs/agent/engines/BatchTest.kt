package net.jonbell.pcs.agent.engines

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.testing.Covers
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

/**
 * Message Batches for the `anthropic` adapter, against a stub server that speaks the documented API
 * (create, retrieve, results as JSON lines). No real call: the base URL is a loopback server.
 */
@Covers("prop:S5")
class BatchTest {
    private val log = CopyOnWriteArrayList<String>()
    private val polls = AtomicInteger()
    private var server: HttpServer? = null

    @AfterEach
    fun stop() {
        server?.stop(0)
    }

    private fun batchJson(id: String, status: String, url: String?) =
        """{"id":"$id","type":"message_batch","processing_status":"$status","request_counts":{"processing":0,"succeeded":2,"errored":1,"canceled":0,"expired":0},
           "ended_at":${if (status == "ended") "\"2026-11-15T12:00:00Z\"" else "null"},"created_at":"2026-11-15T11:00:00Z","expires_at":"2026-11-16T11:00:00Z",
           "cancel_initiated_at":null,"results_url":${if (url == null) "null" else "\"$url\""}}"""

    private fun succeeded(key: String, text: String) =
        """{"custom_id":"$key","result":{"type":"succeeded","message":{"id":"msg_$key","type":"message","role":"assistant","model":"served-batch","content":[{"type":"text","text":${JsonPrimitive(text)}}],"stop_reason":"end_turn","stop_sequence":null,"usage":{"input_tokens":100,"output_tokens":20}}}}"""

    /** Echoes custom_ids it was sent: answers the first two, errors the third, and takes two polls to end. */
    private fun start(): String {
        val s = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
        var ids = listOf<String>()
        val base = "http://127.0.0.1:${s.address.port}"
        s.createContext("/") { ex ->
            val body = String(ex.requestBody.readAllBytes())
            log += "${ex.requestMethod} ${ex.requestURI.path}"
            val path = ex.requestURI.path
            val (code, text) =
                when {
                    ex.requestMethod == "POST" && path == "/v1/messages/batches" -> {
                        val reqs = Json.parseToJsonElement(body).jsonObject["requests"]!!.jsonArray
                        ids = reqs.map { it.jsonObject["custom_id"]!!.jsonPrimitive.content }
                        log += "BODY " + body
                        200 to batchJson("msgbatch_1", "in_progress", null)
                    }
                    ex.requestMethod == "GET" && path == "/v1/messages/batches/msgbatch_1" ->
                        200 to if (polls.incrementAndGet() < 2) batchJson("msgbatch_1", "in_progress", null) else batchJson("msgbatch_1", "ended", "$base/v1/messages/batches/msgbatch_1/results")
                    path == "/v1/messages/batches/msgbatch_1/results" ->
                        200 to
                            listOf(
                                succeeded(ids[0], """{"summary":"first","notes":[]}"""),
                                succeeded(ids[1], """{"summary":"","notes":[]}"""), // fails the schema (minLength 1)
                                """{"custom_id":"${ids[2]}","result":{"type":"errored","error":{"type":"error","error":{"type":"overloaded_error","message":"busy"}}}}""",
                            ).joinToString("\n")
                    else -> 404 to """{"type":"error","error":{"type":"not_found_error","message":"no"}}"""
                }
            val bytes = text.toByteArray()
            ex.responseHeaders.add("content-type", if (path.endsWith("/results")) "application/x-jsonl" else "application/json")
            ex.sendResponseHeaders(code, bytes.size.toLong())
            ex.responseBody.use { it.write(bytes) }
        }
        s.start()
        server = s
        return base
    }

    private fun engineAt(base: String, platform: String = "api"): Pair<EngineConfig, AnthropicEngine> {
        val c = cfg("api", Adapter.ANTHROPIC, baseUrl = if (platform == "api") base else null, platform = platform, model = "claude-test-model", region = if (platform == "bedrock") "us-east-1" else null)
        return c to AnthropicEngine(c, "dummy-test-key", batchPollMs = 10)
    }

    @Test
    fun `submit sends every request under its content address, collect polls until ended and maps each result`() {
        val base = start()
        val (c, e) = engineAt(base)
        assertTrue(e.caps.batch)
        val d = Dispatcher(listOf(Registered(c, e)), InMemoryResultStore())
        val items = (1..3).map { request(text = "paper $it") to "p$it" }
        val out = runBlocking { d.callBatch("api", items) }
        assertEquals(listOf(Status.OK, Status.SCHEMA_INVALID, Status.ERROR), out.map { it.result.status })
        assertEquals("served-batch", out[0].result.servedModel)
        assertEquals(Usage(100, 20), out[0].result.usage)
        assertEquals(Keys.key(items[0].first, c.identity), out[0].result.key)
        assertTrue(out[2].result.detail!!.contains("errored"))
        assertTrue(polls.get() >= 2, "it polled until the batch ended")
        // The same parameters as a single call, plus a custom_id; never a sampling parameter.
        val body = Json.parseToJsonElement(log.first { it.startsWith("BODY ") }.removePrefix("BODY ")).jsonObject
        val reqs = body["requests"] as JsonArray
        assertEquals(3, reqs.size)
        val p = reqs[0].jsonObject["params"]!!.jsonObject
        assertEquals("claude-test-model", p["model"]!!.jsonPrimitive.content)
        assertTrue("output_config" in p && "system" in p && "messages" in p)
        for (k in listOf("temperature", "top_p", "top_k")) assertFalse(k in p)
        assertEquals(out.map { it.result.key }, reqs.map { it.jsonObject["custom_id"]!!.jsonPrimitive.content })
        // Only a definitive OK or refusal is stored; the schema failure and the error are asked again on a rerun.
        assertEquals(1, d.stored().size)
        log.clear()
        val again = runBlocking { d.callBatch("api", items.take(1)) }
        assertTrue(again.all { it.cached })
        assertTrue(log.none { it.startsWith("POST") }, "nothing cached is resubmitted: $log")
    }

    @Test
    fun `the clearance check and the qualification gate come before any batch is submitted`() {
        val base = start()
        val c = cfg("api", Adapter.ANTHROPIC, baseUrl = base, platform = "api")
        val d = Dispatcher(listOf(Registered(c, AnthropicEngine(c, "dummy-test-key", batchPollMs = 10))))
        assertThrows<ClearanceRefused> { runBlocking { d.callBatch("api", listOf(request() to "a", request(DataClass.CONFIDENTIAL) to "b")) } }
        assertTrue(log.isEmpty(), "one refused request refuses the batch before any I/O: $log")
    }

    @Test
    fun `an engine without batch support is called one request at a time, and a platform without batches says so`() {
        val e = ScriptedEngine("plain")
        val d = Dispatcher(listOf(Registered(cfg("plain", model = "m"), e)))
        val out = runBlocking { d.callBatch("plain", listOf(request(text = "x") to "1", request(text = "y") to "2", request(text = "x") to "3")) }
        assertEquals(3, out.size)
        assertEquals(2, e.calls.get(), "an identical request in one batch is asked once")
        assertEquals(out[0].result.key, out[2].result.key)
        val (_, bedrock) = engineAt("", "bedrock")
        assertFalse(bedrock.caps.batch)
        assertNull(runBlocking { bedrock.submitBatch(listOf(request().copy(key = "a".repeat(64)))) })
    }

    @Test
    fun `a request the API says nothing about comes back as an error, and a bad custom id or an empty batch is refused locally`() {
        val base = start()
        val (c, e) = engineAt(base)
        val keyed = (1..4).map { request(text = "q$it").copy(key = Keys.sha256("k$it")) }
        val h = runBlocking { e.submitBatch(keyed.take(3)) }!!
        val got = runBlocking { e.collectBatch(h.copy(keys = h.keys + Keys.sha256("missing"))).toList() }
        assertEquals(4, got.size)
        assertEquals(Status.ERROR, got.last().status)
        assertTrue(got.last().detail!!.contains("no result"))
        assertThrows<IllegalArgumentException> { runBlocking { e.submitBatch(listOf(request().copy(key = "has spaces"))) } }
        assertThrows<IllegalArgumentException> { runBlocking { e.submitBatch(emptyList()) } }
        assertEquals(setOf("127.0.0.1"), setOf(c.egressHost()!!.allowedHosts.single()))
    }
}
