package net.jonbell.pcs.core.rules

/**
 * Who takes the optional seats under Q13's "zero to two juniors" (the owner's ruling, 2026-11-15: the chair running the assignment chooses,
 * as `PCS_JUNIOR_SEATS` and in the Assignment tab; the model's `JuniorSeats`). [FILL]: whenever load and `owes(u)` leave room, up to two a
 * paper. [WHEN_SHORT]: seniors first, and a junior sits only to bring a paper to three reviewers (two seniors and one more). [RECIPROCAL_ONLY]:
 * reciprocal nominee juniors take the optional seats, PC juniors only as in [WHEN_SHORT].
 */
public enum class JuniorSeats(public val key: String) {
    FILL("fill"),
    WHEN_SHORT("when-short"),
    RECIPROCAL_ONLY("reciprocal-only"),
    ;

    public companion object {
        public fun ofKey(k: String): JuniorSeats? = entries.firstOrNull { it.key == k }
    }
}

/**
 * Venue parameters (model `Venue`, Readings.lean): numbers a venue sets, not questions with readings. Each is an app
 * setting (`PCS_NOMINEES_MAX`, `PCS_PATTERN_MIN`, `PCS_ACC_GRACE_H`, `PCS_REMEDY_WINDOW_H`, `PCS_JUNIOR_SEATS`) and a `venue.*` line in the model's answers file.
 */
public data class Venue(
    /** Q8 "up to n": the most nominees a paper may name. */
    val nomineesMax: Int = DEFAULT_NOMINEES_MAX,
    /** Q9: a pattern shows once a senior has made this many nominations, repeats of one junior included. */
    val patternMin: Int = DEFAULT_PATTERN_MIN,
    /** AR5: hours after a request's due date before "no reply" may be recorded. */
    val accGraceH: Long = DEFAULT_GRACE_H,
    /** Q1 "fix window": hours the author has to cure an anonymity problem once the chair offers the fix. */
    val remedyWindowH: Long = DEFAULT_REMEDY_WINDOW_H,
    /** Q13 "zero to two juniors": who takes the optional seats (the chair running the assignment chooses). */
    val juniorSeats: JuniorSeats = JuniorSeats.FILL,
) {
    /** This venue with the parameters not named in [names] at their defaults, so cases compare on what a card depends on. */
    public fun restrictedTo(names: List<String>): Venue =
        Venue(
            if ("nominees-max" in names) nomineesMax else DEFAULT_NOMINEES_MAX,
            if ("pattern-min" in names) patternMin else DEFAULT_PATTERN_MIN,
            if ("acc-grace-h" in names) accGraceH else DEFAULT_GRACE_H,
            if ("remedy-window-h" in names) remedyWindowH else DEFAULT_REMEDY_WINDOW_H,
            if ("junior-seats" in names) juniorSeats else JuniorSeats.FILL,
        )

    public companion object {
        public const val DEFAULT_NOMINEES_MAX: Int = 3
        public const val DEFAULT_PATTERN_MIN: Int = 3
        public const val DEFAULT_GRACE_H: Long = 48
        public const val DEFAULT_REMEDY_WINDOW_H: Long = 72
    }
}
