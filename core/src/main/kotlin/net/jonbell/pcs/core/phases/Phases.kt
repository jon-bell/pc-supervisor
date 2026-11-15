package net.jonbell.pcs.core.phases

import java.time.Instant

/** The primary phases of the extended model (spec §10.1), in order. Each ends at one configured date. */
public enum class Phase(public val endsAt: String?) {
    REGISTRATION("REGISTRATION_DUE"),
    SUBMISSION("SUBMISSION_DUE"),
    DESKREJECT("DESKREJECT_DUE"),
    APPOINTMENTS("APPOINTMENTS_DUE"),
    ASSIGNMENT("ASSIGNMENT_DONE"),
    REVIEWING("REVIEW_DUE"),

    /** After reviews are due, before discussion opens: early reject and responses happen here (see [Window]). */
    POST_REVIEW("DISCUSSION_OPEN"),
    DISCUSSION("DISCUSSION_CLOSE"),
    DECISIONS("DECISIONS_DUE"),
    CLOSED(null),
}

/** Windows that overlay the primary phases: open at the first date, closed from the second. */
public enum class Window(public val open: String, public val close: String) {
    EARLY_REJECT("EARLYREJECT_OPEN", "EARLYREJECT_CLOSE"),
    RESPONSE("RESPONSE_OPEN", "RESPONSE_CLOSE"),
}

/**
 * Phase logic over the `PCS_PHASE_*` dates (spec §10.1), as instants. It never reads a clock:
 * callers pass `now` from core's [net.jonbell.pcs.core.time.Clock], so every boundary is testable.
 *
 * A date is a deadline: at the instant itself the phase it closes has ended. A date that is not
 * configured is skipped, so a conference that doesn't use a phase doesn't enter it.
 */
public class Phases(private val dates: Map<String, Instant>) {
    public companion object {
        /** Every key spec §10.1 defines (the suffix of `PCS_PHASE_<KEY>`). */
        public val KEYS: Set<String> =
            setOf(
                "REGISTRATION_DUE",
                "SUBMISSION_DUE",
                "DESKREJECT_DUE",
                "APPOINTMENTS_DUE",
                "ASSIGNMENT_DONE",
                "REVIEW_DUE",
                "EARLYREJECT_OPEN",
                "EARLYREJECT_CLOSE",
                "RESPONSE_OPEN",
                "RESPONSE_CLOSE",
                "DISCUSSION_OPEN",
                "DISCUSSION_CLOSE",
                "DECISIONS_DUE",
            )
    }

    /** The primary phase at [now]: the first phase whose closing date is configured and still ahead. */
    public fun current(now: Instant): Phase {
        for (p in Phase.entries) {
            val end = p.endsAt?.let(dates::get) ?: continue
            if (now.isBefore(end)) return p
        }
        return Phase.CLOSED
    }

    /** True from the opening date (inclusive) until the closing date (exclusive); false if it has no opening date. */
    public fun isOpen(w: Window, now: Instant): Boolean {
        val open = dates[w.open] ?: return false
        val close = dates[w.close]
        return !now.isBefore(open) && (close == null || now.isBefore(close))
    }

    public fun openWindows(now: Instant): Set<Window> = Window.entries.filter { isOpen(it, now) }.toSet()

    /** A window that closes before it opens, or closes without opening. The settings loader rejects these. */
    public fun windowProblems(): List<String> {
        val out = mutableListOf<String>()
        for (w in Window.entries) {
            val o = dates[w.open]
            val c = dates[w.close]
            if (o != null && c != null && c.isBefore(o)) out += "PCS_PHASE_${w.close} is before PCS_PHASE_${w.open}"
            if (o == null && c != null) out += "PCS_PHASE_${w.close} is set but PCS_PHASE_${w.open} is not"
        }
        return out
    }

    /** Deadlines out of order. Reported, not enforced, because a conference may legitimately reorder some phases. */
    public fun orderProblems(): List<String> {
        val out = mutableListOf<String>()
        val chain = Phase.entries.mapNotNull { it.endsAt }.filter { it in dates }
        for ((a, b) in chain.zipWithNext()) if (dates[b]!!.isBefore(dates[a]!!)) out += "PCS_PHASE_$b is before PCS_PHASE_$a"
        return out
    }
}
