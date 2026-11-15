package net.jonbell.pcs.core

import net.jonbell.pcs.core.config.Settings
import net.jonbell.pcs.core.config.SettingsException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class SettingsTest {
    private val ok = mapOf("PCS_HOTCRP_URL" to "https://conf.example.org", "PCS_ANSWERS" to "/tmp/answers.txt")

    @Test
    fun `every key in pcs conf example is known to the loader`() {
        val keys =
            Repo.path("pcs.conf.example").toFile().readLines()
                .map { it.trim().removePrefix("#").trim() }
                .mapNotNull { Regex("^(PCS_[A-Z_]+)=").find(it)?.groupValues?.get(1) }
        assertTrue(keys.size > 20, "found ${keys.size} keys")
        assertEquals(emptyList<String>(), keys.filterNot(Settings::isKnown))
    }

    @Test
    fun `all problems are reported at once`() {
        val e =
            Settings.load(
                mapOf(
                    "PCS_HOTCRP_URL" to "http://conf.example.org/",
                    "PCS_TZ" to "Mars/Base",
                    "PCS_SYNC_CHUNK" to "0",
                    "PCS_BOGUS" to "1",
                    "PCS_PHASE_REVIEW_DUE" to "tomorrow",
                ),
            ).exceptionOrNull() as SettingsException
        val p = e.problems.joinToString("\n")
        for (k in listOf("PCS_HOTCRP_URL", "PCS_ANSWERS", "PCS_TZ", "PCS_SYNC_CHUNK", "PCS_BOGUS", "PCS_PHASE_REVIEW_DUE")) {
            assertTrue(k in p, "$k missing from:\n$p")
        }
    }

    @Test
    fun `environment wins over the conference file, and phases parse in the zone`() {
        val s = Settings.load(ok + ("PCS_SYNC_CHUNK" to "50"), mapOf("PCS_SYNC_CHUNK" to "10", "PCS_PHASE_REVIEW_DUE" to "2030-02-01T23:59")).getOrThrow()
        assertEquals(50, s.syncChunk)
        assertEquals("2030-02-02T04:59:00Z", s.phases["REVIEW_DUE"].toString())
    }

    @Test
    fun `secrets come from the environment only for a localhost HotCRP`() {
        assertTrue(Settings.load(ok + ("PCS_HOTCRP_TOKEN" to "t")).isFailure)
        assertTrue(Settings.load(mapOf("PCS_HOTCRP_URL" to "http://127.0.0.1:8080", "PCS_ANSWERS" to "a", "PCS_HOTCRP_TOKEN" to "t")).isSuccess)
        assertTrue(Settings.load(ok, mapOf("PCS_DB_KEY" to "k")).isFailure)
    }

    @Test
    fun `the venue's numbers have the model's defaults, and are settings`() {
        val d = Settings.load(ok).getOrThrow().venue
        assertEquals(3, d.nomineesMax)
        assertEquals(3, d.patternMin)
        assertEquals(48, d.accGraceH)
        assertEquals(72, d.remedyWindowH)
        val v =
            Settings.load(
                ok + ("PCS_NOMINEES_MAX" to "5") + ("PCS_PATTERN_MIN" to "4") + ("PCS_ACC_GRACE_H" to "24") + ("PCS_REMEDY_WINDOW_H" to "120"),
            ).getOrThrow().venue
        assertEquals(net.jonbell.pcs.core.rules.Venue(5, 4, 24, 120), v)
        val e =
            Settings.load(
                ok + ("PCS_NOMINEES_MAX" to "0") + ("PCS_ACC_GRACE_H" to "soon") + ("PCS_REMEDY_WINDOW_H" to "0"),
            ).exceptionOrNull() as SettingsException
        assertTrue(e.problems.any { it.startsWith("PCS_NOMINEES_MAX") } && e.problems.any { it.startsWith("PCS_ACC_GRACE_H") }, e.problems.toString())
        assertTrue(e.problems.any { it.startsWith("PCS_REMEDY_WINDOW_H") }, e.problems.toString())
    }

    @Test
    fun `the early-reject window and the score map have defaults, and a bad map is reported`() {
        val d = Settings.load(ok).getOrThrow()
        assertEquals(48, d.earlyRejectWindowH)
        assertEquals(net.jonbell.pcs.core.rules.Score.WEAK_REJECT, d.scoreScale.of(2))
        val s = Settings.load(ok + ("PCS_EARLYREJECT_WINDOW_H" to "24") + ("PCS_SCORE_MAP" to "1:reject, 2:weak-reject,3:borderline")).getOrThrow()
        assertEquals(24, s.earlyRejectWindowH)
        assertEquals(net.jonbell.pcs.core.rules.Score.BORDERLINE, s.scoreScale.of(3))
        assertEquals(null, s.scoreScale.of(4))
        val e = Settings.load(ok + ("PCS_SCORE_MAP" to "1:rejected")).exceptionOrNull() as SettingsException
        assertTrue(e.problems.single().startsWith("PCS_SCORE_MAP: unknown score rejected"), e.problems.toString())
    }
}
