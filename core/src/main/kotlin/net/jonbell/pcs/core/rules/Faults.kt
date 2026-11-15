package net.jonbell.pcs.core.rules

/**
 * The specification mutants of the Lean model (`Params` in model/ReviewProcess/Model.lean),
 * as fault switches in `core` (PLAN §A8). Every switch is off in the signed model. Tests turn
 * one on to check that the end-to-end suite notices; production code never does.
 */
public data class Faults(
    val secondOpinionFromAnyone: Boolean = false,
    val silenceRemoves: Boolean = false,
    val assignUnaccepted: Boolean = false,
    val combineIgnoresQ18: Boolean = false,
    val declinedShareToUnnamed: Boolean = false,
    val earlyRejectBeforeWindowCloses: Boolean = false,
    val dismissedSuggestionCounts: Boolean = false,
    val heuristicSendsItself: Boolean = false,
    val applyWithoutDryRun: Boolean = false,
    val cycleK1: Boolean = false,
) {
    public companion object {
        public val NONE: Faults = Faults()

        /** In the order of model/export/mutants.json. */
        public val MUTANTS: List<Faults> =
            listOf(
                Faults(secondOpinionFromAnyone = true),
                Faults(silenceRemoves = true),
                Faults(assignUnaccepted = true),
                Faults(combineIgnoresQ18 = true),
                Faults(declinedShareToUnnamed = true),
                Faults(earlyRejectBeforeWindowCloses = true),
                Faults(dismissedSuggestionCounts = true),
                Faults(heuristicSendsItself = true),
                Faults(applyWithoutDryRun = true),
                Faults(cycleK1 = true),
            )
    }
}
