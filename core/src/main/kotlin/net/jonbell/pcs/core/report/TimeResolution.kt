package net.jonbell.pcs.core.report

import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

/**
 * How finely the research export writes a timestamp (owner's ruling 2026-11-15, `PCS_EXPORT_TIME_RESOLUTION`). Times of day are a way to match
 * rows against HotCRP's own records, so the default is the day; `hour` and `exact` are for a recipient the chair trusts.
 * All three read in UTC, whatever the conference's time zone, so an export is a function of the mirror and the key.
 *
 * - [DAY]: `2030-01-10`. No time of day.
 * - [HOUR]: `2030-01-10T17Z`.
 * - [EXACT]: epoch seconds, as before.
 */
public enum class TimeResolution(public val key: String) {
    DAY("day"),
    HOUR("hour"),
    EXACT("exact"),
    ;

    public fun format(epochSeconds: Long): String =
        when (this) {
            DAY -> DAY_FORMAT.format(Instant.ofEpochSecond(epochSeconds))
            HOUR -> HOUR_FORMAT.format(Instant.ofEpochSecond(epochSeconds))
            EXACT -> epochSeconds.toString()
        }

    /** A stored value (epoch seconds as text, or empty) in this resolution; anything that is not a whole number of seconds is dropped, never passed through. */
    public fun format(stored: String?): String = stored?.trim()?.toLongOrNull()?.let(::format).orEmpty()

    public companion object {
        public const val SETTING: String = "PCS_EXPORT_TIME_RESOLUTION"
        private val DAY_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd").withZone(ZoneOffset.UTC)
        private val HOUR_FORMAT = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH'Z'").withZone(ZoneOffset.UTC)

        public fun ofKey(k: String): TimeResolution? = entries.firstOrNull { it.key == k.trim().lowercase() }

        /** The setting's value, `day` when it is unset. A value that is not `day`, `hour` or `exact` is an error, never a quiet fall back to something finer. */
        public fun resolve(settings: Map<String, String>): TimeResolution {
            val v = settings[SETTING]?.takeIf { it.isNotBlank() } ?: return DAY
            return ofKey(v) ?: throw IllegalArgumentException("$SETTING must be day, hour or exact, not '$v'")
        }
    }
}
