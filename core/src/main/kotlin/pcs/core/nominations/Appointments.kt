package pcs.core.nominations

import pcs.core.rules.Tier
import pcs.core.writeback.UserArtifact
import pcs.core.writeback.UserChange
import pcs.core.writeback.Writeback
import pcs.core.writeback.WritebackStatus

/**
 * Appointment (concepts §3.3, spec §10.4 A): a candidate the sheet shows as accepted, classified and
 * consenting, and not yet on the PC, becomes a Writeback draft that adds them with their tier tag. The
 * sheet stays the source of truth and is never edited. HotCRP's API writes no users, so the artifact is
 * handed to a chair (spec §11); the sync then sees the role.
 */
public object Appointments {
    /** A candidate eligible for a membership draft, and why not for the others. */
    public data class Plan(val drafts: List<UserChange>, val skipped: List<Pair<String, String>>)

    /**
     * The tags a new PC member gets: the tag for their tier and, for a reciprocal nominee, the nominee tag, as
     * `PCS_TIER_TAGS` maps them (tier name to tag). Senior is the untagged default unless the map names it.
     */
    public fun tagsFor(c: Candidate, tierTags: Map<String, String>): List<String> {
        val tierName = if (c.tier == Tier.SENIOR) "senior" else "junior"
        return listOfNotNull(tierTags[tierName], if (c.origin == "nominee") tierTags["nominee"] else null).distinct()
    }

    public fun plan(input: NominationInput, tierTags: Map<String, String>): Plan {
        val drafts = mutableListOf<UserChange>()
        val skipped = mutableListOf<Pair<String, String>>()
        for (c in NominationRules.effective(input).first.sortedBy { it.email }) {
            val why =
                when {
                    c.decision != Decision.ACCEPT ->
                        if (c.decision ==
                            Decision.PENDING
                        ) {
                            "the AC has not decided (or the decision isn't an AC's)"
                        } else {
                            "declined"
                        }
                    c.tier == null -> "not classified"
                    c.consent != true -> if (c.consent == false) "did not consent" else "consent not recorded"
                    c.email.lowercase() in input.pc -> "already on the PC"
                    else -> null
                }
            if (why != null) skipped += c.email to why else drafts += UserChange(c.email, roles = "pc", tags = tagsFor(c, tierTags))
        }
        return Plan(drafts, skipped)
    }

    /**
     * Drafts one artifact for the candidates that don't have one waiting (drafted, confirmed, or handed off and
     * not yet seen on the PC). Returns the artifact id, or null when there is nothing new to draft.
     */
    public fun draft(wb: Writeback, plan: Plan): Long? {
        val waiting =
            wb.list().filter { it.status !in setOf(WritebackStatus.FAILED, WritebackStatus.OBSERVED) }
                .mapNotNull { it.artifact as? UserArtifact }.flatMap { a -> a.users.map { it.email.lowercase() to it } }.toMap()
        val fresh = plan.drafts.filter { waiting[it.email.lowercase()] != it }
        if (fresh.isEmpty()) return null
        return wb.draft(UserArtifact(fresh))
    }
}
