package net.jonbell.pcs.core.time

import java.time.Instant

/**
 * The only source of "now" in PC Supervisor (AGENTS.md). Phase logic must be testable at any
 * instant, so nothing else reads the system clock.
 */
public fun interface Clock {
    public fun now(): Instant

    public companion object {
        /** Real time, unless `PCS_NOW` pins it. */
        public fun fromSettings(pinned: Instant?): Clock = if (pinned != null) Fixed(pinned) else System
    }

    public object System : Clock {
        override fun now(): Instant = Instant.now()
    }

    public class Fixed(private val at: Instant) : Clock {
        override fun now(): Instant = at
    }
}
