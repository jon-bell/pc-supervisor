package pcs.core

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import pcs.core.hotcrp.HotcrpClient
import java.net.InetSocketAddress
import java.net.URI
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList

/**
 * The production client's rate-limit handling against a local stub HTTP server (CI raises the harness's own limits, so this is
 * the only coverage of that path). The stub answers from a script; the client's sleeper is replaced, so nothing sleeps.
 */
class HotcrpClientRateLimitTest {
    private class Reply(val code: Int, val headers: Map<String, String> = emptyMap(), val body: String = "") {
        companion object {
            val ok = Reply(200, mapOf("x-ratelimit-limit" to "5000", "x-ratelimit-remaining" to "4998", "x-ratelimit-reset" to "2000000000"), """{"ok":true,"pc":[]}""")

            fun limited(vararg h: Pair<String, String>) = Reply(429, h.toMap(), """{"ok":false}""")
        }
    }

    private val script = ConcurrentLinkedQueue<Reply>()
    private val requests = CopyOnWriteArrayList<String>()
    private val auth = CopyOnWriteArrayList<String?>()
    private val server =
        HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0).apply {
            createContext("/") { ex ->
                requests += ex.requestURI.path
                auth += ex.requestHeaders.getFirst("Authorization")
                val r = script.poll() ?: Reply(500, body = "script exhausted")
                r.headers.forEach { (k, v) -> ex.responseHeaders.add(k, v) }
                val bytes = r.body.toByteArray()
                ex.sendResponseHeaders(r.code, if (bytes.isEmpty()) -1 else bytes.size.toLong())
                if (bytes.isNotEmpty()) ex.responseBody.use { it.write(bytes) }
                ex.close()
            }
            start()
        }
    private val waits = mutableListOf<Long>()
    private var now = 1_000_000_000L

    @AfterEach
    fun stop() = server.stop(0)

    private fun client(attempts: Int = 8) =
        HotcrpClient(
            URI("http://127.0.0.1:${server.address.port}"),
            "hct_stub_token",
            strict = false,
            maxAttempts = attempts,
            sleeper = { waits += it },
            epochSeconds = { now },
        )

    private fun run(attempts: Int = 8) = runBlocking { client(attempts).use { it.pc() } }

    @Test
    fun `Retry-After is honored, in seconds`() {
        script += listOf(Reply.limited("Retry-After" to "7"), Reply.limited("Retry-After" to "3"), Reply.ok)
        assertEquals(emptyList<Any>(), run())
        assertEquals(listOf(7_000L, 3_000L), waits)
        assertEquals(3, requests.size)
        assertTrue(auth.all { it == "Bearer hct_stub_token" })
    }

    @Test
    fun `Retry-After is capped at a minute`() {
        script += listOf(Reply.limited("Retry-After" to "900"), Reply.ok)
        run()
        assertEquals(listOf(60_000L), waits)
    }

    @Test
    fun `without Retry-After the back-off doubles from a second and stops at a minute`() {
        script += List(9) { Reply.limited() } + Reply.ok
        run(attempts = 10)
        assertEquals(listOf(1_000L, 2_000L, 4_000L, 8_000L, 16_000L, 32_000L, 60_000L, 60_000L, 60_000L), waits)
    }

    @Test
    fun `a Retry-After that is not a number falls back to the back-off`() {
        script += listOf(Reply.limited("Retry-After" to "Wed, 21 Oct 2030 07:28:00 GMT"), Reply.ok)
        run()
        assertEquals(listOf(1_000L), waits)
    }

    @Test
    fun `a 429 with an x-ratelimit-reset in the future waits until then when it gives no Retry-After`() {
        script += listOf(Reply.limited("x-ratelimit-limit" to "250", "x-ratelimit-remaining" to "0", "x-ratelimit-reset" to "${now + 20}"), Reply.ok)
        run()
        assertEquals(listOf(20_000L), waits)
    }

    @Test
    fun `the x-ratelimit headers are read from every response`() {
        script += Reply.ok
        val c = client()
        assertEquals(null, c.rateLimit)
        runBlocking { c.use { it.pc() } }
        assertEquals(HotcrpClient.RateLimit(limit = 5000, remaining = 4998, resetAt = 2_000_000_000), c.rateLimit)
        assertEquals(emptyList<Long>(), waits)
    }

    @Test
    fun `a 5xx is retried the same way, and a 4xx is not retried`() {
        script += listOf(Reply(503), Reply.ok)
        run()
        assertEquals(listOf(1_000L), waits)
        requests.clear()
        script += Reply(403, body = """{"ok":false}""")
        val e = assertThrows<IllegalStateException> { run() }
        assertTrue("HTTP 403" in e.message!!, e.message)
        assertEquals(1, requests.size, "no retry on a refusal")
    }

    @Test
    fun `it gives up after the configured attempts with a message that says why, and never shows the token`() {
        script += List(10) { Reply.limited("Retry-After" to "1") }
        val e = assertThrows<IllegalStateException> { run(attempts = 4) }
        assertNotNull(e.message)
        assertTrue("rate-limited" in e.message!! && "4 attempts" in e.message!!, e.message)
        assertTrue("/api/pc" !in e.message!! && "hct_stub_token" !in e.message!!, "the URL and token stay out of the message: ${e.message}")
        assertEquals(4, requests.size)
        assertEquals(3, waits.size, "it waits between attempts, not after the last")
        assertFalse(script.isEmpty(), "and does not keep asking")
    }
}
