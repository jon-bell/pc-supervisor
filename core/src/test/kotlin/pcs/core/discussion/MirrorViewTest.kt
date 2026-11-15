package pcs.core.discussion

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import pcs.core.store.MirrorView
import pcs.testing.Covers
import pcs.testing.Family
import pcs.testing.MirrorFixture

/** The mirror's view for the rules: what is marked approximate (H3), and when a review counts as having landed. */
@Family("T2")
class MirrorViewTest {
    @Test
    @Covers("prop:H3")
    fun `version times are approximate until the review's history has been read`() {
        val store =
            MirrorFixture.temp {
                paper(1)
                review(1, "a", Triple(100L, 1, "complete"), Triple(200L, 2, "complete"))
            }
        val before = MirrorView.load(store).single().reviews.single()
        assertEquals(listOf(true, true), before.versions.map { it.approx })
        store.conn.createStatement().use { it.executeUpdate("INSERT INTO backfill(rid, done_at) VALUES(1, 300)") }
        val after = MirrorView.load(store).single().reviews.single()
        assertEquals(listOf(false, false), after.versions.map { it.approx })
        assertEquals(java.time.Instant.ofEpochSecond(100), after.completeAt, "the first complete version's time")
    }
}
