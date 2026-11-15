package net.jonbell.pcs.core.rules

/**
 * Venue parameters (model `Venue`, Readings.lean): numbers a venue sets, not questions with readings. Each is an app
 * setting (`PCS_NOMINEES_MAX`, `PCS_PATTERN_MIN`, `PCS_ACC_GRACE_H`) and a `venue.*` line in the model's answers file.
 */
public data class Venue(
    /** Q8 "up to n": the most nominees a paper may name. */
    val nomineesMax: Int = DEFAULT_NOMINEES_MAX,
    /** Q9: a pattern shows once a senior has made this many nominations, repeats of one junior included. */
    val patternMin: Int = DEFAULT_PATTERN_MIN,
    /** AR5: hours after a request's due date before "no reply" may be recorded. */
    val accGraceH: Long = DEFAULT_GRACE_H,
) {
    /** This venue with the parameters not named in [names] at their defaults, so cases compare on what a card depends on. */
    public fun restrictedTo(names: List<String>): Venue =
        Venue(
            if ("nominees-max" in names) nomineesMax else DEFAULT_NOMINEES_MAX,
            if ("pattern-min" in names) patternMin else DEFAULT_PATTERN_MIN,
            if ("acc-grace-h" in names) accGraceH else DEFAULT_GRACE_H,
        )

    public companion object {
        public const val DEFAULT_NOMINEES_MAX: Int = 3
        public const val DEFAULT_PATTERN_MIN: Int = 3
        public const val DEFAULT_GRACE_H: Long = 48
    }
}
