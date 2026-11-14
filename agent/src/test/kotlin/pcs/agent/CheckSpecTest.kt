package pcs.agent

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.snakeyaml.engine.v2.api.Load
import org.snakeyaml.engine.v2.api.LoadSettings
import pcs.agent.checks.Checks
import pcs.agent.eval.Operators
import pcs.agent.eval.Oracle
import pcs.core.rules.Ground
import pcs.testing.Covers
import java.io.File

/** The check directories (agent.md §3.2): each has a spec, a schema, and an oracle, and the corpus is built from the oracle. */
@Covers("check:format", "check:refs.doi", "check:anonymity", "check:injection.hidden", "check:injection.channels", "check:injection.addressed")
class CheckSpecTest {
    private val root = File(System.getProperty("pcs.repoRoot"), "agent/checks")

    @Suppress("UNCHECKED_CAST")
    private fun spec(
        id: String,
    ): Map<String, Any?> = Load(LoadSettings.builder().build()).loadFromString(File(root, "$id/check.yaml").readText()) as Map<String, Any?>

    @Test
    fun `every check has a spec naming itself, a schema, and an oracle`() {
        for (id in Oracle.checks) {
            val s = spec(id)
            assertEquals(id, s["id"])
            assertEquals("deterministic", s["category"])
            for (k in listOf("version", "depends_on", "inputs", "schema", "grounds", "evidence", "affected", "code")) assertTrue(k in s, "$id: $k")
            assertTrue(File(root, "$id/${s["schema"]}").isFile)
            assertTrue(File(root, "$id/oracle/operators.json").isFile)
            @Suppress("UNCHECKED_CAST")
            (s["grounds"] as List<String>).forEach { assertTrue(Ground.ofKey(it) != null, "$id grounds: $it") }
            @Suppress("UNCHECKED_CAST")
            (s["code"] as List<String>).forEach { assertTrue(File(System.getProperty("pcs.repoRoot"), "agent/$it").isFile, "$id code: $it") }
        }
        assertEquals(Oracle.checks.toSet(), root.listFiles()!!.filter { it.isDirectory }.map { it.name }.toSet())
    }

    @Test
    fun `the version of a check is a content hash computed by the build`() {
        for (id in Oracle.checks) assertTrue(Regex("[0-9a-f]{12}").matches(Checks.version(id)), "$id: ${Checks.version(id)}")
        assertEquals(Oracle.checks.toSet(), Checks.ids())
        assertEquals(Oracle.checks.size, Oracle.checks.map { Checks.version(it) }.toSet().size, "different directories, different versions")
        assertEquals(Oracle.checks.toSet(), Checks.all().map { it.id }.toSet())
    }

    @Test
    fun `oracle operators and their implementations agree`() {
        val declared = Oracle.checks.flatMap { c -> Oracle.operators(c).filterNot { it.control }.map { "$c/${it.operator}" } }.toSet()
        assertEquals(declared, Operators.impl.keys)
        val controls = Oracle.checks.flatMap { c -> Oracle.operators(c).filter { it.control }.map { it.operator } }.toSet()
        assertEquals(controls, Operators.controls.keys)
        // Every declared vector is one the check's schema allows.
        for (c in Oracle.checks) {
            val schema = File(root, "$c/schema.json").readText()
            Oracle.operators(c).filterNot { it.control }.forEach { assertTrue("\"${it.vector}\"" in schema, "$c: vector ${it.vector} not in its schema") }
        }
    }

    @Test
    fun `every finding of the corpus validates against its check's schema`() {
        val json = kotlinx.serialization.json.Json
        for (c in Oracle.checks) {
            val schema = json.parseToJsonElement(File(root, "$c/schema.json").readText()) as kotlinx.serialization.json.JsonObject
            val item = schema["items"] as kotlinx.serialization.json.JsonObject
            val props = item["properties"] as kotlinx.serialization.json.JsonObject
            val required = (item["required"] as kotlinx.serialization.json.JsonArray).map { (it as kotlinx.serialization.json.JsonPrimitive).content }

            fun enumOf(o: kotlinx.serialization.json.JsonElement?) =
                ((o as kotlinx.serialization.json.JsonObject)["enum"] as kotlinx.serialization.json.JsonArray).map {
                    (it as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { p -> p.isString }?.content
                }
            val vectors = enumOf((props["vectors"] as kotlinx.serialization.json.JsonObject)["items"]).toSet()
            val grounds = enumOf(props["ground"]).toSet()
            val severities = enumOf(props["severity"]).toSet()
            for (s in TestCorpus.screened.values) {
                for (f in s.report.findings.filter { it.check == c }) {
                    val obj = json.parseToJsonElement(json.encodeToString(pcs.agent.checks.Finding.serializer(), f)) as kotlinx.serialization.json.JsonObject
                    required.forEach { assertTrue(it in obj, "$c: $it missing") }
                    assertTrue(f.vectors.all { it in vectors }, "$c: ${f.vectors}")
                    assertTrue(f.ground in grounds && f.severity.name in severities, "$c: ${f.ground} ${f.severity}")
                }
            }
        }
    }
}
