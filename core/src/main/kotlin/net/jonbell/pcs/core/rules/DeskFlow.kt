package net.jonbell.pcs.core.rules

import net.jonbell.pcs.core.readings.Q1
import net.jonbell.pcs.core.readings.Readings

/*
 * The desk-reject subsystem's step function (model/ReviewProcess/Policy.lean `deskRule`), ported so that every transition the model
 * exports (model/export/transitions-desk.json) can be replayed against `core` (T3). The policy's grants are applied by the caller,
 * as `AccFlow`'s are: this is the rule behind the gate, not the gate.
 */

/** The model's `DeskSt`: the referral so far, and whether the paper was removed (and on which ground). */
public data class DeskSt(val ref: Referral = Referral(ac = 1, ground = Ground.FORMAT), val referred: Boolean = false, val removed: Ground? = null)

/** The model's `DeskAct`. */
public sealed interface DeskAct {
    public data class Refer(val g: Ground) : DeskAct

    public data class Opine(val o: Opinion) : DeskAct

    public data object OfferRemedy : DeskAct

    public data object Warn : DeskAct

    public data object Cure : DeskAct

    public data object Tick : DeskAct

    public data object Advance : DeskAct

    public data object Remove : DeskAct
}

public object DeskFlow {
    /** The hours a fix window lasts once offered (the model's `remedyDue := now + 72`). */
    public const val REMEDY_WINDOW_H: Long = 72

    private fun next(s: Stage): Stage? = Stage.entries.getOrNull(s.ordinal + 1)

    /** Who may do what is the policy's; `who` here is the role key, used only where the rule itself looks at it (refer, cure, remove). */
    public fun rule(f: Faults, r: Readings, s: DeskSt, who: String?, a: DeskAct): DeskSt? =
        when (a) {
            is DeskAct.Refer -> if (!s.referred && s.removed == null && who == "ac") s.copy(referred = true, ref = s.ref.copy(ground = a.g)) else null
            is DeskAct.Opine ->
                if (s.referred && s.removed == null && s.ref.opinions.none { it.who == a.o.who }) {
                    s.copy(ref = s.ref.copy(opinions = (s.ref.opinions + a.o).sortedBy { it.who }))
                } else {
                    null
                }
            DeskAct.OfferRemedy ->
                if (s.referred && s.ref.ground == Ground.ANONYMITY && r.q1 == Q1.FIX_WINDOW && !s.ref.remedyOffered) {
                    s.copy(ref = s.ref.copy(remedyOffered = true, remedyDue = s.ref.now + REMEDY_WINDOW_H))
                } else {
                    null
                }
            DeskAct.Warn ->
                if (s.referred &&
                    s.ref.ground == Ground.NOMINATION_NONCOMPLIANCE &&
                    !s.ref.warned
                ) {
                    s.copy(ref = s.ref.copy(warned = true))
                } else {
                    null
                }
            DeskAct.Cure ->
                if (who == "author" && s.ref.remedyOffered && !s.ref.cured && s.ref.now <= s.ref.remedyDue) s.copy(ref = s.ref.copy(cured = true)) else null
            DeskAct.Tick -> if (s.ref.now < 200) s.copy(ref = s.ref.copy(now = s.ref.now + 100)) else null
            DeskAct.Advance -> next(s.ref.stage)?.let { s.copy(ref = s.ref.copy(stage = it)) }
            DeskAct.Remove ->
                if (s.referred && s.removed == null && who == "pc-chair" && DeskReject.mayRemove(f, r, s.ref)) s.copy(removed = s.ref.ground) else null
        }
}
