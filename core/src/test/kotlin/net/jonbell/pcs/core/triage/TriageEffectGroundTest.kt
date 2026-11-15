package net.jonbell.pcs.core.triage

import net.jonbell.pcs.core.rules.Ground
import net.jonbell.pcs.core.rules.Stage
import net.jonbell.pcs.core.triage.TriageFixture.Companion.bundle
import net.jonbell.pcs.core.triage.TriageFixture.Companion.finding
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** Owner's ruling: a verified `injection.effect` finding carries `prompt-injection` like any admitted ground; `refs.use` is evidence only (no ground). */
@Family("T1")
class TriageEffectGroundTest {
    private fun plan(store: net.jonbell.pcs.core.store.Store, vararg fs: net.jonbell.pcs.core.bundle.BundleFinding) =
        (
            TriagePlan.compute(
                store,
                bundle(fs.toList()),
                emptyList(),
                TriageFixture.readings(),
                Stage.SCREENING,
                1_900_000_000L / 3600,
                TriageFixture.tiers,
            ) as TriageReport.Ready
        ).rows.associateBy { it.pid }

    @Test
    @Covers("card:E9")
    fun `an injection-effect finding is a prompt-injection ground in the queue, and a refs-use finding is shown as evidence with none`() {
        val store =
            TriageFixture.store {
                listOf("ac@example.org", "senior1@example.org").forEach { person(it) }
                paper(11)
                paper(12)
                paper(13, tags = listOf("pcs-refer-prompt-injection"))
                meta(13, "ac@example.org", round = null)
                opinion(13, "senior1@example.org")
            }
        val rows =
            plan(
                store,
                finding(11, "prompt-injection", check = "injection.effect"),
                finding(12, null, check = "refs.use"),
                finding(13, "prompt-injection", check = "injection.effect"),
            )
        assertEquals(listOf(Ground.PROMPT_INJECTION), rows.getValue(11).grounds)
        assertEquals(emptyList<Ground>(), rows.getValue(12).grounds)
        assertEquals(1, rows.getValue(12).findings.size, "the evidence is still listed for the AC")
        // With a referral on the same ground and a second opinion, the paper is removable, as for any admitted ground.
        assertEquals(TriageStatus.READY, rows.getValue(13).status)
        assertEquals(listOf(Ground.PROMPT_INJECTION), rows.getValue(13).grounds)
        // An unverified effect finding adds nothing.
        val none = plan(store, finding(11, "prompt-injection", check = "injection.effect", verified = false))
        assertTrue(none[11] == null || none.getValue(11).grounds.isEmpty())
    }
}
