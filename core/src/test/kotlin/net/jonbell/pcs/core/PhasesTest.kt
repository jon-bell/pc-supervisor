package net.jonbell.pcs.core

import net.jonbell.pcs.core.config.Settings
import net.jonbell.pcs.core.phases.Phase
import net.jonbell.pcs.core.phases.Phases
import net.jonbell.pcs.core.phases.Window
import net.jonbell.pcs.core.time.Clock
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.time.Instant

class PhasesTest {
    private val env =
        mapOf(
            "PCS_HOTCRP_URL" to "https://conf.example.org",
            "PCS_ANSWERS" to "/tmp/a.txt",
            "PCS_TZ" to "America/New_York",
            "PCS_PHASE_REGISTRATION_DUE" to "2027-01-01T00:00",
            "PCS_PHASE_SUBMISSION_DUE" to "2027-01-08T00:00",
            "PCS_PHASE_DESKREJECT_DUE" to "2027-01-15T00:00",
            "PCS_PHASE_APPOINTMENTS_DUE" to "2027-01-22T00:00",
            "PCS_PHASE_ASSIGNMENT_DONE" to "2027-02-01T00:00",
            "PCS_PHASE_REVIEW_DUE" to "2027-03-01T00:00",
            "PCS_PHASE_EARLYREJECT_OPEN" to "2027-03-02T00:00",
            "PCS_PHASE_EARLYREJECT_CLOSE" to "2027-03-05T00:00",
            "PCS_PHASE_DISCUSSION_OPEN" to "2027-03-10T00:00",
            "PCS_PHASE_DISCUSSION_CLOSE" to "2027-03-24T00:00",
            "PCS_PHASE_DECISIONS_DUE" to "2027-03-31T00:00",
        )
    private val settings = Settings.load(env).getOrThrow()
    private val phases = settings.phaseModel

    private fun at(local: String): Instant = java.time.LocalDateTime.parse(local).atZone(settings.zone).toInstant()

    @Test
    fun `the current phase at and around every deadline`() {
        val cases =
            listOf(
                "2026-12-01T00:00" to Phase.REGISTRATION,
                "2026-12-31T23:59:59" to Phase.REGISTRATION,
                "2027-01-01T00:00" to Phase.SUBMISSION,
                "2027-01-07T23:59:59" to Phase.SUBMISSION,
                "2027-01-08T00:00" to Phase.DESKREJECT,
                "2027-01-15T00:00" to Phase.APPOINTMENTS,
                "2027-01-22T00:00" to Phase.ASSIGNMENT,
                "2027-02-01T00:00" to Phase.REVIEWING,
                "2027-02-28T23:59:59" to Phase.REVIEWING,
                "2027-03-01T00:00" to Phase.POST_REVIEW,
                "2027-03-10T00:00" to Phase.DISCUSSION,
                "2027-03-24T00:00" to Phase.DECISIONS,
                "2027-03-31T00:00" to Phase.CLOSED,
                "2030-01-01T00:00" to Phase.CLOSED,
            )
        for ((t, p) in cases) assertEquals(p, phases.current(at(t)), t)
    }

    @Test
    fun `windows open at their first date and close at their second`() {
        assertFalse(phases.isOpen(Window.EARLY_REJECT, at("2027-03-01T23:59:59")))
        assertTrue(phases.isOpen(Window.EARLY_REJECT, at("2027-03-02T00:00")))
        assertTrue(phases.isOpen(Window.EARLY_REJECT, at("2027-03-04T23:59:59")))
        assertFalse(phases.isOpen(Window.EARLY_REJECT, at("2027-03-05T00:00")))
        assertEquals(setOf(Window.EARLY_REJECT), phases.openWindows(at("2027-03-03T00:00")))
        assertFalse(phases.isOpen(Window.RESPONSE, at("2027-03-03T00:00")), "an unconfigured window is never open")
    }

    @Test
    fun `phase dates are interpreted in the configured time zone, across a DST change`() {
        val ny = Settings.load(env + ("PCS_PHASE_REVIEW_DUE" to "2027-03-14T12:00")).getOrThrow()
        assertEquals(Instant.parse("2027-03-14T16:00:00Z"), ny.phases["REVIEW_DUE"])
        val utc = Settings.load(env + ("PCS_TZ" to "UTC")).getOrThrow()
        assertEquals(Instant.parse("2027-03-01T00:00:00Z"), utc.phases["REVIEW_DUE"])
    }

    @Test
    fun `phases follow the pinned clock`() {
        val pinned = Settings.load(env + ("PCS_NOW" to "2027-02-10T09:00")).getOrThrow()
        assertEquals(Phase.REVIEWING, pinned.phaseModel.current(Clock.fromSettings(pinned.now).now()))
        val later = Settings.load(env + ("PCS_NOW" to "2027-03-12T09:00")).getOrThrow()
        assertEquals(Phase.DISCUSSION, later.phaseModel.current(Clock.fromSettings(later.now).now()))
    }

    @Test
    fun `dates that are not set are skipped`() {
        val p = Phases(mapOf("SUBMISSION_DUE" to Instant.parse("2027-01-08T05:00:00Z"), "REVIEW_DUE" to Instant.parse("2027-03-01T05:00:00Z")))
        assertEquals(Phase.SUBMISSION, p.current(Instant.parse("2026-01-01T00:00:00Z")))
        assertEquals(Phase.REVIEWING, p.current(Instant.parse("2027-02-01T00:00:00Z")))
        assertEquals(Phase.CLOSED, p.current(Instant.parse("2027-03-01T05:00:00Z")))
        assertEquals(Phase.CLOSED, Phases(emptyMap()).current(Instant.EPOCH))
    }

    @Test
    fun `the loader rejects an unknown phase date, and a window that closes before it opens`() {
        val e =
            Settings.load(
                env + ("PCS_PHASE_SUBMISSON_DUE" to "2027-01-08T00:00") + ("PCS_PHASE_EARLYREJECT_CLOSE" to "2027-03-01T00:00"),
            ).exceptionOrNull() as net.jonbell.pcs.core.config.SettingsException
        val p = e.problems.joinToString("\n")
        assertTrue("SUBMISSON_DUE: unknown phase date" in p, p)
        assertTrue("PCS_PHASE_EARLYREJECT_CLOSE is before PCS_PHASE_EARLYREJECT_OPEN" in p, p)
    }

    @Test
    fun `out-of-order deadlines are reported but not rejected`() {
        val s = Settings.load(env + ("PCS_PHASE_APPOINTMENTS_DUE" to "2027-02-15T00:00")).getOrThrow()
        assertEquals(listOf("PCS_PHASE_ASSIGNMENT_DONE is before PCS_PHASE_APPOINTMENTS_DUE"), s.phaseModel.orderProblems())
    }

    @Test
    fun `import freshness settings`() {
        val s = Settings.load(env + ("PCS_IMPORT_FRESH_APPOINTMENTS_DAYS" to "2") + ("PCS_IMPORT_FRESH_TPMS_SCORES_DAYS" to "9")).getOrThrow()
        assertEquals(
            mapOf(net.jonbell.pcs.core.imports.ImportKind.APPOINTMENTS to 2, net.jonbell.pcs.core.imports.ImportKind.TPMS_SCORES to 9),
            s.importFreshDays,
        )
        assertTrue(Settings.load(env + ("PCS_IMPORT_FRESH_NOPE_DAYS" to "2")).isFailure)
        assertTrue(Settings.load(env + ("PCS_IMPORT_FRESH_APPOINTMENTS_DAYS" to "0")).isFailure)
    }
}
