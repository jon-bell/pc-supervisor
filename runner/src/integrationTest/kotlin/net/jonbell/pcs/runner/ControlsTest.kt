package net.jonbell.pcs.runner

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import net.jonbell.pcs.core.rules.Faults
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test

/**
 * Binding controls (PLAN §A8): a positive control per binding, and every binding mutant (and the
 * specification mutant that desk-reject traces can catch) switched on and caught. The evidence goes
 * to build/evidence/controls.json, where `check-evidence` re-derives each outcome.
 */
@Order(2)
@Family("T7")
class ControlsTest {
    private val specs by lazy { (Session.traces() + Session.earlyTraces() + Session.accTraces() + Session.apptTraces()).associateBy { it.id } }

    @Test
    @Covers("prop:H4", "prop:H5", "prop:C1")
    fun `every binding mutant is caught by a control, and every positive control passes`() {
        val runner = Session.runner
        val second = specs.getValue("desk/signed/cell-pc-member-second-opinion")
        val silence = specs.getValue("desk/signed/silence-does-not-remove")
        val needed = 17
        val pids = runner.createPapers(needed).iterator()
        val controls = mutableListOf<JsonObject>()

        fun positive(name: String, binding: String, spec: TraceSpec) {
            val r = runner.run(spec, pids.next())
            assertEquals(emptyList<String>(), r.mismatches, "positive control $name")
            controls += Controls.traceControl(name, "positive", binding, null, r.record, caught = false)
        }

        fun negative(name: String, binding: String, mutant: String, spec: TraceSpec, faults: BindingFaults = BindingFaults(), impl: Faults = Faults.NONE) {
            val r = runner.run(spec, pids.next(), faults, impl, implFaultName = if (impl != Faults.NONE) mutant else null)
            assertTrue(r.mismatches.isNotEmpty(), "negative control $name: the mutant $mutant was not caught")
            controls += Controls.traceControl(name, "negative", binding, mutant, r.record, caught = true)
        }
        positive("the HotCRP actor performs a second opinion", "hotcrp-actor", second)
        positive("the clock advances and core reads it", "clock", silence)
        positive("the role reader sees nothing a PC member or nominee may not", "role-reader", second)
        positive("the HotCRP reader reads every review row", "hotcrp-reader", second)
        positive("the state reader follows each sync", "state-reader", second)

        negative("an actor that skips an action", "hotcrp-actor", "actor-skips-action", second, BindingFaults.of("actor-skips-action"))
        negative("a clock that does not advance", "clock", "clock-does-not-advance", silence, BindingFaults.of("clock-does-not-advance"))
        negative("a role reader that reads as a chair", "role-reader", "role-reader-reads-as-chair", second, BindingFaults.of("role-reader-reads-as-chair"))
        negative(
            "a HotCRP reader that drops the last row",
            "hotcrp-reader",
            "hotcrp-reader-drops-last-row",
            second,
            BindingFaults.of("hotcrp-reader-drops-last-row"),
        )
        negative("a state reader that never refreshes", "state-reader", "state-reader-stale", second, BindingFaults.of("state-reader-stale"))
        // a specification mutant switched on in core: silence removes (model mutant 1); the model refuses, the mutant core removes
        negative("core with the 'silence removes' mutant", "core", "spec:silence-removes", silence, impl = Faults.MUTANTS[1])

        // model mutant 0: a second opinion from anyone, here the referring AC's own note; the model keeps the paper, the mutant core removes it
        negative(
            "core with the 'second opinion from anyone' mutant",
            "core",
            "spec:second-opinion-from-anyone",
            specs.getValue("desk/signed/ac-own-opinion-does-not-count"),
            impl = Faults.MUTANTS[0],
        )

        // the early-reject mutant: a chair's removal before the window closes (model mutant 5); the model refuses, the mutant core confirms
        negative(
            "core with the 'early reject before the window closes' mutant",
            "core",
            "spec:early-reject-before-close",
            specs.getValue("early/bump-reject-only/remove-before-close-refused"),
            impl = Faults.MUTANTS[5],
        )

        // the accountability mutants (model mutants 6 and 7): a dismissed suggestion counted as a failed engagement, and a
        // heuristic suggestion counted as a request nobody sent; the model's engagement record and `sent` say otherwise
        negative(
            "core with the 'dismissed suggestion counts' mutant",
            "core",
            "spec:dismissed-suggestion-counts",
            specs.getValue("acc/q20-needs-request/dismissed-leaves-no-trace"),
            impl = Faults.MUTANTS[6],
        )
        negative(
            "core with the 'heuristic sends itself' mutant",
            "core",
            "spec:heuristic-sends-itself",
            specs.getValue("acc/q20-needs-request/heuristic-does-not-send"),
            impl = Faults.MUTANTS[7],
        )

        // the assignment mutant: a nominee who has not consented, planned anyway (model mutant 2); the model leaves them out, the mutant core plans them
        negative(
            "core with the 'assign unaccepted' mutant",
            "core",
            "spec:assign-unaccepted",
            specs.getValue("appt/signed/unconsented-never-planned"),
            impl = Faults.MUTANTS[2],
        )
        // and the same trace, unmutated, as the positive control for the plan's binding
        positive("the plan binding leaves out a nominee who has not consented", "core", specs.getValue("appt/signed/unconsented-never-planned"))

        controls += Controls.observerControls(Session.harness, Session.token)
        runner.write(
            "controls.json",
            buildJsonObject {
                put("kind", "controls")
                put("controls", JsonArray(controls))
                put(
                    "requiredSpecMutants",
                    JsonArray(
                        listOf(
                            JsonPrimitive("spec:silence-removes"),
                            JsonPrimitive("spec:second-opinion-from-anyone"),
                            JsonPrimitive("spec:early-reject-before-close"),
                            JsonPrimitive("spec:dismissed-suggestion-counts"),
                            JsonPrimitive("spec:heuristic-sends-itself"),
                            JsonPrimitive("spec:assign-unaccepted"),
                        ),
                    ),
                )
            },
        )
    }
}
