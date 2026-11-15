package net.jonbell.pcs.runner

import net.jonbell.pcs.core.rules.Tier

/** The people of the golden scenario, as the model's person ids (concepts §3.4: person 1 is the referring AC). */
object Persons {
    const val AC_REFERRING = "ac-normal@example.org"
    val CHAIR: String? = null

    data class Person(val who: Long, val email: String, val isAc: Boolean, val tier: Tier?)

    /** The referring AC is the model's person 1: her own note in the screening review is an opinion that never counts. */
    val AC_PERSON = Person(1, AC_REFERRING, true, Tier.SENIOR)

    val opinionGivers =
        listOf(
            AC_PERSON,
            Person(2, "ac-idle@example.org", true, Tier.SENIOR),
            Person(3, "r1@example.org", false, Tier.SENIOR),
            Person(4, "r-silent@example.org", false, Tier.JUNIOR),
            // a senior who says keep in the Triage field of their screen-round review (a disagreement)
            Person(5, "r5@example.org", false, Tier.SENIOR),
        )

    fun byWho(who: Long): Person = opinionGivers.firstOrNull { it.who == who } ?: error("the model's person $who has no harness user")

    fun byEmail(email: String): Person? = opinionGivers.firstOrNull { it.email == email }

    /** Reviewers of the early-reject traces: PC members for the model's "pc-member" role, and nominees (any user will do for HotCRP). */
    val EARLY_PC_MEMBERS = listOf("r3@example.org", "r4@example.org", "r5@example.org")
    val EARLY_NOMINEES = listOf("n-laggard@example.org", "r6@example.org", "r1@example.org")

    /** The harness's chair (scripts/hotcrp-up.sh): a PC chair's decision in the appointments sheet counts. */
    const val PC_CHAIR = "admin@example.org"

    /** The reviewer an accountability request is about (the model's person 7). */
    const val ACC_REVIEWER = "r3@example.org"

    /** Users that stand for the model's roles when an action is attempted as that role. */
    const val PC_MEMBER_OUTSIDER = "r2@example.org"
    const val NOMINEE_OUTSIDER = "n-laggard@example.org"
}
