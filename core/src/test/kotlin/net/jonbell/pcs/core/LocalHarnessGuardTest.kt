package net.jonbell.pcs.core

import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import net.jonbell.pcs.testing.LocalHarness
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.net.URI

/** The test helper refuses to start unless `PCS_HOTCRP_URL` is 127.0.0.1 or localhost (PLAN M5, `prop:H4`). */
@Family("T7")
class LocalHarnessGuardTest {
    @Test
    @Covers("prop:H4")
    fun `the harness URLs are accepted`() {
        assertEquals(URI("http://127.0.0.1:18085"), LocalHarness.require("http://127.0.0.1:18085"))
        assertEquals("localhost", LocalHarness.require("http://localhost:8080/").host)
    }

    @Test
    @Covers("prop:H4")
    fun `anything else is refused`() {
        for (u in listOf(
            "https://hotcrp.example.org",
            "http://127.0.0.1.example.org",
            "http://evil.example/@127.0.0.1",
            "http://127.0.0.1@evil.example",
            "http://10.0.0.5",
            "ftp://localhost",
            "not a url",
            "",
        )) {
            assertThrows(IllegalStateException::class.java, { LocalHarness.require(u) }, u)
        }
    }

    @Test
    @Covers("prop:H4")
    fun `the integration harness helper goes through the guard`() {
        val src = java.nio.file.Files.readString(Repo.path("core/src/integrationTest/kotlin/net/jonbell/pcs/core/Harness.kt"))
        assertTrue("LocalHarness.require" in src, "Harness.kt must call the guard")
    }
}
