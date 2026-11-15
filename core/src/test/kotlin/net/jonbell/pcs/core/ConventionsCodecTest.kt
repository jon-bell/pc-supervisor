package net.jonbell.pcs.core

import net.jonbell.pcs.core.rules.Conventions
import net.jonbell.pcs.core.rules.Ground
import net.jonbell.pcs.core.rules.ReqDisposition
import net.jonbell.pcs.core.rules.Trace
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

/** T8 at unit level: every trace the spec §11 conventions define survives encode then decode (as HotCRP returns it, `name#value`). */
@Family("T8")
class ConventionsCodecTest {
    private fun asHotcrp(tag: String) = if ('#' in tag) tag else "$tag#0"

    @Test
    @Covers("conv:1", "conv:9", "conv:10", "conv:15", "conv:16", "conv:17", "conv:18")
    fun `every trace round-trips`() {
        val traces =
            listOf(Trace.Keep(1)) + Ground.entries.map { Trace.Refer(1, it) } +
                (listOf<ReqDisposition?>(null) + ReqDisposition.entries).mapIndexed { i, d -> Trace.RequestSent(1, "C", i + 1, d) } +
                listOf(
                    Trace.Reminder(1, "C", 2),
                    Trace.Case(1, 3, 2),
                    Trace.RemedyDue(1, 1_893_456_000),
                    Trace.Warned(1),
                    Trace.EarlyObjection(1),
                    Trace.Opinion(1, 77, true),
                    Trace.Opinion(1, 78, false),
                )
        for (t in traces) assertEquals(listOf(t), Conventions.decode(1, listOf(asHotcrp(Conventions.encode(t)))), Conventions.encode(t))
    }

    @Test
    fun `malformed traces are reported, and other tags are ignored`() {
        val out = Conventions.decode(2, listOf("pcs-refer-astrology#0", "pcs-req-C1#9", "pcs-opinion-5#7", "pcs-mystery#1", "accept#0", "~ac-private#0"))
        assertEquals(4, out.size)
        assertTrue(out.all { it is Trace.Unparsed }, out.toString())
    }
}
