package pcs.core

import kotlinx.coroutines.runBlocking
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
@org.junit.jupiter.api.Order(2)
@Family("T11")
@Covers("assume:A2")
class ContractTest {
    // Data-agnostic: runs on whatever scenario the harness holds (the smoke paper or `golden`).
    @Test
    fun `pc roster decodes strictly`() =
        runBlocking {
            Harness.client().use { c -> assertTrue(c.pc().isNotEmpty()) }
        }

    @Test
    fun `assignments decode, with clearreview rows dropped`() =
        runBlocking {
            Harness.client().use { c ->
                val rows = c.assignments()
                assertTrue(rows.any { it.action == "metareview" }, rows.toString())
                assertTrue(rows.none { it.action == "clearreview" })
            }
        }

    @Test
    fun `reviews decode strictly, with modified_at on every complete review`() =
        runBlocking {
            Harness.client().use { c ->
                val rs = c.reviews(c.paperIds())
                assertTrue(rs.any { it.rtype == 5 } && rs.any { it.rtype == 4 })
                assertTrue(rs.filter { it.status == "complete" }.all { it.modifiedAt != null && it.fields["OveMer"] != null })
                assertTrue(rs.any { it.ratings.isNotEmpty() })
            }
        }

    @Test
    fun `comments decode strictly`() =
        runBlocking {
            Harness.client().use { c ->
                val cs = c.comments(c.paperIds())
                assertTrue(cs.isNotEmpty() && cs.all { it.modifiedAt != null && it.authorEmail != null })
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
    fun `errors never carry the token`() =
        runBlocking {
            val bad = pcs.core.hotcrp.HotcrpClient(Harness.url, "hct_not-a-real-token", strict = true)
            val e = assertThrows(Exception::class.java) { runBlocking { bad.pc() } }
            assertTrue("hct_not-a-real-token" !in (e.message ?: "") && "hct_not-a-real-token" !in e.stackTraceToString())
            bad.close()
        }
}
