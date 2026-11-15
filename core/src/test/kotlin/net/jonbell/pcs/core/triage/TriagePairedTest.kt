package net.jonbell.pcs.core.triage

import net.jonbell.pcs.core.rules.Ground
import net.jonbell.pcs.core.writeback.DecisionArtifact
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test
import java.util.Random

/** T4: pairs of worlds that differ only in a secret give the stated observer the same view. Here the observer is the paper's authors. */
@Family("T4")
class TriagePairedTest {
    @Test
    @Covers("prop:C2")
    fun `worlds that differ only in who gave the second opinion and which engine found it give the authors the same text`() {
        val rnd = Random(2030)
        // worlds are built once per ground and variant: each has its own giver and a canary-bearing engine id
        val worlds =
            Ground.entries.associateWith { g ->
                (1..2).map { v -> triageWorld(7L to g.key, engine = "engine-$v-${g.key}-CANARY", giver = "giver$v${g.ordinal}@example.org") }
            }
        var pairs = 0
        repeat(200) {
            val g = Ground.entries[rnd.nextInt(Ground.entries.size)]
            val (w1, w2) = worlds.getValue(g)
            val (d1, m1) = TriageDrafts.remove(w1.second.rows)
            val (d2, m2) = TriageDrafts.remove(w2.second.rows)
            assertEquals(d1, d2)
            assertEquals(m1, m2)
            assertEquals(emptyList<String>(), Notices.lint((d1 as DecisionArtifact).notice.orEmpty()))
            val all = (m1.map { it.body + it.subject + it.search } + listOf(d1.notice.orEmpty())).joinToString("\n")
            assertFalse("CANARY" in all || "@example.org" in all, "nothing of the engine or the giver reaches the authors' text")
            pairs++
        }
        worlds.values.flatten().forEach { it.first.close() }
        assertEquals(200, pairs)
    }
}
