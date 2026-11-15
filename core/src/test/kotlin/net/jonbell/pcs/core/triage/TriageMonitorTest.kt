package net.jonbell.pcs.core.triage

import net.jonbell.pcs.core.rules.Stage
import net.jonbell.pcs.core.triage.TriageFixture.Companion.bundle
import net.jonbell.pcs.core.triage.TriageFixture.Companion.finding
import net.jonbell.pcs.core.triage.TriageFixture.Companion.readings
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** T10: `prop:M1`, one positive and one negative, then the per-AC view over a mirror. */
@Family("T10")
class TriageMonitorTest {
    private fun ac(name: String, papers: Int, referred: Int, removed: Int) =
        AcRates(name, papers, flagged = referred, triaged = papers, referred = referred, kept = papers - referred, removed = removed)

    @Test
    @Covers("prop:M1")
    fun `M1 positive - an AC whose referral and removal rates fall outside the others' band is reported to the chairs`() {
        val perAc = (1..6).map { ac("ac$it@example.org", 20, referred = 1 + it % 2, removed = 0) } + ac("odd@example.org", 20, referred = 14, removed = 9)
        val alerts = Consistency.bandAlerts(perAc)
        assertEquals(setOf("referral rate", "desk-reject rate"), alerts.map { it.metric }.toSet())
        assertEquals(setOf("odd@example.org"), alerts.map { it.ac }.toSet())
        assertTrue(alerts.all { it.rate > it.high })
        // an AC who never refers while the others do is outside the band too
        val quiet = (1..6).map { ac("ac$it@example.org", 20, referred = 8 + it % 3, removed = 3) } + ac("quiet@example.org", 20, 0, 0)
        assertEquals(setOf("quiet@example.org"), Consistency.bandAlerts(quiet).map { it.ac }.toSet())
    }

    @Test
    @Covers("prop:M1")
    fun `M1 negative - ACs inside the band, too few ACs, or too few papers raise nothing`() {
        val spread = (1..7).map { ac("ac$it@example.org", 20, referred = 2 + it % 3, removed = it % 2) }
        assertEquals(emptyList<BandAlert>(), Consistency.bandAlerts(spread))
        assertEquals(emptyList<BandAlert>(), Consistency.bandAlerts(spread.take(2) + ac("odd@example.org", 20, 19, 19)), "three ACs form no band")
        assertEquals(emptyList<BandAlert>(), Consistency.bandAlerts(spread + ac("new@example.org", 3, 3, 3)), "an AC with 3 papers is not compared")
    }

    @Test
    @Covers("prop:M1")
    fun `M1 at non-default band settings - the fence pad, the paper minimum and the AC minimum are each a setting`() {
        val calm = (1..7).map { ac("ac$it@example.org", 20, referred = 2, removed = 0) }

        fun odd(referred: Int) = calm + ac("odd@example.org", 20, referred, 0)

        fun who(perAc: List<AcRates>, band: ConsistencyBand) = Consistency.bandAlerts(perAc, band).map { it.ac }
        // the fence pad: a rate 0.1 above a flat population is out at the default pad (0.05), in at 0.15, and 0.05 above is out only at pad 0
        assertEquals(listOf("odd@example.org"), who(odd(4), ConsistencyBand()))
        assertEquals(emptyList<String>(), who(odd(4), ConsistencyBand(fencePad = 0.15)))
        assertEquals(emptyList<String>(), who(odd(3), ConsistencyBand()))
        assertEquals(listOf("odd@example.org"), who(odd(3), ConsistencyBand(fencePad = 0.0)))
        val wide = Consistency.bandAlerts(odd(4), ConsistencyBand(fencePad = 0.0)).single { it.metric == "referral rate" }
        assertEquals(0.1, wide.high, 1e-9)
        assertEquals(0.25, Consistency.bandAlerts(odd(9), ConsistencyBand(fencePad = 0.15)).single { it.metric == "referral rate" }.high, 1e-9)
        // the paper minimum: an AC with 3 papers is compared only when the minimum is 3
        val small = calm + ac("small@example.org", 3, 3, 0)
        assertEquals(emptyList<String>(), who(small, ConsistencyBand()))
        assertEquals(listOf("small@example.org"), who(small, ConsistencyBand(minPapers = 3)))
        assertEquals(emptyList<String>(), who(odd(4), ConsistencyBand(minPapers = 21)), "nobody has 21 papers: no band")
        // the AC minimum: four comparable ACs form a band by default, not when 5 are required; eight form one only if 8 or fewer are required
        val four = calm.take(3) + ac("odd@example.org", 20, 19, 0)
        assertEquals(listOf("odd@example.org"), who(four, ConsistencyBand()))
        assertEquals(emptyList<String>(), who(four, ConsistencyBand(minAcs = 5)))
        assertEquals(emptyList<String>(), who(calm.take(2) + ac("odd@example.org", 20, 19, 0), ConsistencyBand()), "three form none")
        assertEquals(emptyList<String>(), who(odd(4), ConsistencyBand(minAcs = 9)))
        assertEquals(listOf("odd@example.org"), who(odd(4), ConsistencyBand(minAcs = 8)))
    }

    @Test
    @Covers("prop:M1")
    fun `the consistency view counts per AC from the mirror, lists ACs alphabetically, and shows distributions`() {
        val store =
            TriageFixture.store {
                listOf("b@example.org", "a@example.org", "s@example.org").forEach { person(it) }
                for (pid in 1L..10L) {
                    paper(
                        pid,
                        tags =
                            if (pid <= 3) {
                                listOf("pcs-refer-format")
                            } else if (pid == 4L) {
                                listOf("pcs-keep")
                            } else {
                                emptyList()
                            },
                        decision = if (pid == 1L) "Rejected" else null,
                    )
                    meta(pid, if (pid <= 6) "b@example.org" else "a@example.org", round = null)
                }
                opinion(1, "s@example.org")
            }
        val rep =
            TriagePlan.compute(
                store,
                bundle(
                    (1L..5L).map {
                        finding(it, "format")
                    },
                ),
                emptyList(),
                readings(),
                Stage.SCREENING,
                1_900_000_000L / 3600,
                TriageFixture.tiers,
            )
                as TriageReport.Ready
        val v = Consistency.view(store, rep.rows)
        assertEquals(listOf("a@example.org", "b@example.org"), v.perAc.map { it.ac })
        val b = v.perAc.single { it.ac == "b@example.org" }
        assertEquals(listOf(6, 5, 4, 3, 1), listOf(b.papers, b.flagged, b.triaged, b.referred, b.removed))
        assertEquals(1, b.kept)
        assertEquals(0.5, b.referralRate)
        assertEquals(listOf("flag rate", "referral rate", "desk-reject rate"), v.histograms.keys.toList())
        assertEquals(1, v.histograms.getValue("referral rate").sum(), "only b has the 5 papers the comparison needs")
        assertTrue(v.alerts.isEmpty() && v.note!!.contains("Topic areas"))
        // the paper minimum is the band's: with 6 papers required only b is compared, with 1 both are, and the note says which
        assertEquals(1, Consistency.view(store, rep.rows, ConsistencyBand(minPapers = 6)).histograms.getValue("referral rate").sum())
        val loose = Consistency.view(store, rep.rows, ConsistencyBand(minPapers = 1))
        assertEquals(2, loose.histograms.getValue("referral rate").sum())
        assertTrue("fewer than 1 papers" in loose.note!!)
        store.close()
    }
}
