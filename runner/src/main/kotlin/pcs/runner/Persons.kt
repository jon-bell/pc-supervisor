package pcs.runner

import pcs.core.rules.Tier

/** The people of the golden scenario, as the model's person ids (concepts §3.4: person 1 is the referring AC). */
object Persons {
    const val AC_REFERRING = "ac-normal@example.org"
    val CHAIR: String? = null

    data class Person(val who: Long, val email: String, val isAc: Boolean, val tier: Tier?)

    val opinionGivers =
        listOf(
            Person(2, "ac-idle@example.org", true, Tier.SENIOR),
            Person(3, "r1@example.org", false, Tier.SENIOR),
            Person(4, "r-silent@example.org", false, Tier.JUNIOR),
        )

    fun byWho(who: Long): Person = opinionGivers.firstOrNull { it.who == who } ?: error("the model's person $who has no harness user")

    fun byEmail(email: String): Person? = opinionGivers.firstOrNull { it.email == email }

    /** Users that stand for the model's roles when an action is attempted as that role. */
    const val PC_MEMBER_OUTSIDER = "r2@example.org"
    const val NOMINEE_OUTSIDER = "n-laggard@example.org"
}
