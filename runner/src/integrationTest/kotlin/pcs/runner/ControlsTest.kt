package pcs.runner

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import pcs.core.rules.Faults
import pcs.testing.Covers
import pcs.testing.Family

/**
 * Binding controls (PLAN §A8): a positive control per binding, and every binding mutant (and the
 * specification mutant that desk-reject traces can catch) switched on and caught. The evidence goes
 * to build/evidence/controls.json, where `check-evidence` re-derives each outcome.
 */
@Order(2)
@Family("T7")
class ControlsTest {
    private val specs by lazy { Session.traces().associateBy { it.id } }

    @Test
    @Covers("prop:H4", "prop:H5", "prop:C1")
    fun `every binding mutant is caught by a control, and every positive control passes`() {
        val runner = Session.runner
        val second = specs.getValue("desk/signed/cell-pc-member-second-opinion")
        val silence = specs.getValue("desk/signed/silence-does-not-remove")
        val needed = 11
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

        controls += Controls.observerControls(Session.harness, Session.token)
        runner.write(
            "controls.json",
            buildJsonObject {
                put("kind", "controls")
                put("controls", JsonArray(controls))
                put("requiredSpecMutants", JsonArray(listOf(JsonPrimitive("spec:silence-removes"))))
            },
        )
    }
}
