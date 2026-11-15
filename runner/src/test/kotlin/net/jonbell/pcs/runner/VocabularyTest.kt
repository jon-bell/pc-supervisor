package net.jonbell.pcs.runner

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.runner.model.DeskRejectRefer
import net.jonbell.pcs.runner.model.ModelActions
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.nio.file.Files
import java.nio.file.Path

/** The generated action vocabulary against the model's export (PLAN §A4: the compiler checks completeness; this checks the export). */
@Family("T3")
class VocabularyTest {
    private val repo = Path.of(System.getProperty("pcs.repoRoot"))

    @Test
    fun `every action of every subsystem parses into its generated type`() {
        val systems = Json.parseToJsonElement(Files.readString(repo.resolve("model/export/actions.json"))).jsonArray
        var n = 0
        for (s in systems) {
            for (a in s.jsonObject["actions"]!!.jsonArray) {
                val o = a.jsonObject
                val parsed =
                    ModelActions.parse(
                        s.jsonObject["subsystem"]!!.jsonPrimitive.content,
                        o["key"]!!.jsonPrimitive.content,
                        o["args"]!!.jsonObject,
                        o["action"]!!.jsonPrimitive.content,
                    )
                assertEquals(o["key"]!!.jsonPrimitive.content, parsed.key)
                assertEquals(o["perm"]!!.let { if (it is kotlinx.serialization.json.JsonNull) null else it.jsonPrimitive.content }, parsed.perm)
                n++
            }
        }
        assertTrue(n >= 40, "$n actions")
    }

    @Test
    fun `the early-reject traces carry every observation of the subsystem`() {
        val traces = TraceSpec.load(repo.resolve("model/export/traces-early.json"))
        assertTrue(traces.any { it.id == "early/bump-reject-only/early-reject" })
        val obs = net.jonbell.pcs.runner.model.earlyRejectObservations.map { it.first }.toSet()
        for (t in traces) {
            assertEquals("early reject", t.subsystem)
            for (s in t.steps) {
                ModelActions.parse(s.subsystem, s.key, s.args, s.label)
                assertEquals(obs, s.expect.keys, "${t.id}: ${s.label}")
            }
        }
    }

    @Test
    fun `the accountability traces carry every observation of the subsystem`() {
        val traces = TraceSpec.load(repo.resolve("model/export/traces-acc.json"))
        assertTrue(traces.any { it.id == "acc/q20-needs-request/dismissed-leaves-no-trace" })
        assertTrue(traces.any { it.id == "acc/q20-needs-request/heuristic-does-not-send" })
        val obs = net.jonbell.pcs.runner.model.accountabilityRequestsObservations.map { it.first }.toSet()
        for (t in traces) {
            assertEquals("accountability requests", t.subsystem)
            for (s in t.steps) {
                ModelActions.parse(s.subsystem, s.key, s.args, s.label)
                assertEquals(obs, s.expect.keys, "${t.id}: ${s.label}")
            }
        }
    }

    @Test
    fun `the exported traces use only actions the generated types know, and carry every observation`() {
        val traces = TraceSpec.load(repo.resolve("model/export/traces-desk.json"))
        assertTrue(traces.any { it.id == "desk/signed/remove-format" })
        val obs = net.jonbell.pcs.runner.model.deskRejectObservations.map { it.first }.toSet()
        for (t in traces) {
            for (s in t.steps) {
                ModelActions.parse(s.subsystem, s.key, s.args, s.label)
                assertEquals(obs, s.expect.keys, "${t.id}: ${s.label}")
            }
        }
        val refer = ModelActions.parse("desk reject", "refer", mapOf("ground" to kotlinx.serialization.json.JsonPrimitive("scope")), "refer on scope")
        assertEquals(DeskRejectRefer("scope", "refer on scope"), refer)
    }

    @Test
    fun `the appointment traces carry every observation of the subsystem`() {
        val traces = TraceSpec.load(repo.resolve("model/export/traces-appt.json"))
        assertTrue(traces.any { it.id == "appt/signed/appointed-senior" })
        val obs = net.jonbell.pcs.runner.model.appointmentAndAssignmentObservations.map { it.first }.toSet()
        for (t in traces) {
            assertEquals("appointment and assignment", t.subsystem)
            for (s in t.steps) {
                ModelActions.parse(s.subsystem, s.key, s.args, s.label)
                assertEquals(obs, s.expect.keys, "${t.id}: ${s.label}")
            }
        }
    }
}
