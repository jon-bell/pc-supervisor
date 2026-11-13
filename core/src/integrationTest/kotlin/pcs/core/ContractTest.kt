package pcs.core

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import pcs.core.config.Settings
import pcs.testing.Covers
import pcs.testing.Family
import java.net.URI

/**
 * T11: every endpoint the sync reads, decoded strictly against the seeded harness
 * (scripts/harness-smoke.sh). A surprise from HotCRP fails here, not in production.
 */
@Family("T11")
@Covers("assume:A2")
class ContractTest {
    @Test
    fun `pc roster decodes strictly`() = runBlocking {
        Harness.client().use { c ->
            val pc = c.pc()
            assertTrue(pc.any { it.email == "ac1@example.org" }, pc.toString())
        }
    }

    @Test
    fun `assignments decode, with clearreview rows dropped`() = runBlocking {
        Harness.client().use { c ->
            val rows = c.assignments()
            assertTrue(rows.any { it.pid == 1L && it.action == "metareview" && it.email == "ac1@example.org" }, rows.toString())
            assertTrue(rows.none { it.action == "clearreview" })
        }
    }

    @Test
    fun `reviews decode strictly, with ratings and modified_at`() = runBlocking {
        Harness.client().use { c ->
            val rs = c.reviews(c.paperIds())
            assertEquals(listOf(4, 4, 5), rs.map { it.rtype }.sorted())
            val a = rs.first { it.ordinal == "A" }
            assertEquals(listOf("short", "short", "vague"), a.ratings)
            assertTrue(rs.filter { it.status == "complete" }.all { it.modifiedAt != null })
            assertNotNull(a.fields["OveMer"])
        }
    }

    @Test
    fun `comments decode strictly`() = runBlocking {
        Harness.client().use { c ->
            val cs = c.comments(c.paperIds())
            assertEquals(1, cs.size)
            assertEquals("ac1@example.org", cs[0].authorEmail)
            assertNotNull(cs[0].modifiedAt)
        }
    }
}

@Family("T11")
@Covers("prop:H4")
class HarnessGuardTest {
    @Test
    fun `integration tests refuse a non-harness URL`() {
        assertTrue(Settings.isLocalhost(Harness.url))
        assertTrue(!Settings.isLocalhost(URI("https://conf.hotcrp.com")))
    }

    @Test
    fun `errors never carry the token`() = runBlocking {
        val bad = pcs.core.hotcrp.HotcrpClient(Harness.url, "hct_not-a-real-token", strict = true)
        val e = assertThrows(Exception::class.java) { runBlocking { bad.pc() } }
        assertTrue("hct_not-a-real-token" !in (e.message ?: "") && "hct_not-a-real-token" !in e.stackTraceToString())
        bad.close()
    }
}
