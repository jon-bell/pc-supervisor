package net.jonbell.pcs.agent.engines

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import net.jonbell.pcs.agent.checks.Checks
import net.jonbell.pcs.testing.Covers
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path

@Covers("prop:S5")
class EgressTest {
    @Test
    fun `an engine may reach exactly its configured host`() {
        val p = EgressPolicy.forEngine("e", "https://models.example.org/v1")
        p.require("https://models.example.org/v1/chat/completions")
        p.require("https://MODELS.example.org:8443/x")
        for (bad in listOf(
            "https://models.example.org.evil.example.net/v1",
            "https://evil.example.net/models.example.org",
            "https://sub.models.example.org/",
            "https://models.example.org@evil.example.net/",
            "https://evil.example.net@models.example.org/",
            "http://models.example.org/v1",
            "https://doi.org/10.1/x",
            "https://api.crossref.org/works",
            "file:///etc/passwd",
            "/relative",
        )) {
            assertThrows(EgressDenied::class.java, { p.require(URI.create(bad)) }, bad)
        }
    }

    @Test
    fun `plain http is allowed only where the configuration itself says http`() {
        EgressPolicy.forEngine("local", "http://127.0.0.1:8000/v1").require("http://127.0.0.1:8000/v1/chat/completions")
        assertThrows(EgressDenied::class.java) { EgressPolicy.forEngine("local", "http://127.0.0.1:8000/v1").require("http://127.0.0.2:8000/") }
    }

    @Test
    fun `the reference resolver has its own allowlist and no engine shares a host with it`() {
        val r = EgressPolicy.forResolver(null)
        assertEquals(setOf("doi.org", "api.crossref.org", "api.openalex.org", "export.arxiv.org", "arxiv.org"), r.allowedHosts)
        r.require("https://api.crossref.org/works?query=x")
        assertThrows(EgressDenied::class.java) { r.require("https://api.anthropic.com/v1/messages") }
        assertThrows(EgressDenied::class.java) { r.require("http://doi.org/10.1/x") }
        val engine = EgressPolicy.forEngine("e", "https://models.example.org/v1")
        assertThrows(EgressDenied::class.java) { engine.require("https://api.crossref.org/") }
        EgressPolicy.assertDisjoint(listOf(engine), r)
        assertThrows(IllegalArgumentException::class.java) { EgressPolicy.assertDisjoint(listOf(EgressPolicy.forEngine("x", "https://doi.org/")), r) }
        assertEquals(setOf("a.example.org"), EgressPolicy.forResolver(" a.example.org , ").allowedHosts)
        assertThrows(IllegalArgumentException::class.java) { EgressPolicy.forResolver("https://a.example.org/path") }
    }

    @Test
    fun `platform hosts are derived from configuration and can be pinned`() {
        assertEquals(setOf("api.anthropic.com"), cfg("a", Adapter.ANTHROPIC, baseUrl = null).egressHost()!!.allowedHosts)
        assertEquals(
            setOf("us-east5-aiplatform.googleapis.com"),
            cfg("v", Adapter.ANTHROPIC, baseUrl = null, platform = "vertex", region = "us-east5").egressHost()!!.allowedHosts,
        )
        assertEquals(
            setOf("pinned.example.org"),
            cfg("v", Adapter.ANTHROPIC, baseUrl = "https://pinned.example.org", platform = "bedrock", region = "r").egressHost()!!.allowedHosts,
        )
        assertEquals(null, cfg("c", Adapter.CLAUDE_CODE).egressHost(), "the CLI makes its own calls; the adapter opens no connection")
    }
}

class SchemaAndKeysTest {
    private fun schema(s: String) = Json.parseToJsonElement(s) as JsonObject

    private fun errors(s: String, v: String) = JsonSchema.validate(schema(s), Json.parseToJsonElement(v))

    @Test
    fun `the schema validator covers the keywords check schemas use`() {
        val s =
            """{"type":"object","required":["a"],"additionalProperties":false,"properties":{"a":{"type":"integer","minimum":1},""" +
                """"b":{"enum":["x","y",null]},"c":{"type":"array","minItems":1,"items":{"${'$'}ref":"#/${'$'}defs/s"}}},""" +
                """"${'$'}defs":{"s":{"type":"string","pattern":"^k"}}}"""
        assertEquals(emptyList<String>(), errors(s, """{"a":2,"b":null,"c":["kk"]}"""))
        assertTrue(errors(s, """{}""").single().contains("missing required"))
        assertTrue(errors(s, """{"a":0}""").single().contains("minimum"))
        assertTrue(errors(s, """{"a":1.5}""").single().contains("integer"))
        assertTrue(errors(s, """{"a":1,"z":1}""").single().contains("unexpected property"))
        assertTrue(errors(s, """{"a":1,"b":"q"}""").single().contains("allowed"))
        assertTrue(errors(s, """{"a":1,"c":[]}""").single().contains("fewer"))
        assertTrue(errors(s, """{"a":1,"c":["z"]}""").single().contains("pattern"))
        assertFalse(errors("""{"anyOf":[{"type":"string"},{"type":"null"}]}""", "3").isEmpty())
        assertThrows(IllegalArgumentException::class.java) { errors("""{"unevaluatedProperties":false}""", "{}") }
    }

    @Test
    fun `every existing check schema is a valid schema for the validator`() {
        val root = Path.of(System.getProperty("pcs.repoRoot"), "agent/checks")
        for (d in root.toFile().listFiles()!!.filter { it.isDirectory && it.resolve("schema.json").isFile }) {
            val s = schema(d.resolve("schema.json").readText())
            when (s["type"]?.let { (it as? kotlinx.serialization.json.JsonPrimitive)?.content }) {
                "array" -> assertEquals(emptyList<String>(), JsonSchema.validate(s, Json.parseToJsonElement("[]")), d.name)
                // An output schema is an object: the validator must accept the schema itself (it throws on a keyword it does not know).
                else -> JsonSchema.validate(s, Json.parseToJsonElement("{}"))
            }
        }
    }

    @Test
    fun `a key changes with exactly what could change the result`() {
        val who = EngineIdentity("e", "m1", "o")
        val base = request()
        val k = Keys.key(base, who)
        assertEquals(k, Keys.key(base.copy(key = "ignored"), who))
        assertNotEquals(k, Keys.key(base.copy(check = base.check.copy(version = "v2")), who), "check version")
        assertNotEquals(k, Keys.key(request(text = "other"), who), "input")
        assertNotEquals(k, Keys.key(request(system = "other"), who), "system prompt")
        assertNotEquals(k, Keys.key(base, who.copy(model = "m2")), "model")
        assertNotEquals(k, Keys.key(base, who.copy(id = "e2")), "engine")
        assertNotEquals(k, Keys.key(base, who.copy(options = "o2")), "options")
        assertNotEquals(k, Keys.key(base.copy(effort = Effort.HIGH), who), "effort")
        assertNotEquals(k, Keys.key(base.copy(variant = "pdf"), who), "variant")
        assertNotEquals(k, Keys.key(base.copy(decisionVersions = listOf("Q1@2")), who), "decision version")
        assertNotEquals(k, Keys.key(base.copy(dataClass = DataClass.PUBLIC), who), "data class")
        assertNotEquals(k, Keys.key(base.copy(maxOutputTokens = 1), who), "output bound")
        val reordered =
            Json.parseToJsonElement(
                """{"required":["summary","notes"],"type":"object","additionalProperties":false,"properties":${TOY_SCHEMA["properties"]}}""",
            ) as JsonObject
        assertEquals(k, Keys.key(base.copy(schema = reordered), who), "key order in a schema does not matter")
    }

    @Test
    fun `the runtime check-directory hash matches the one the build computes`(
        @TempDir tmp: Path,
    ) {
        val agentRoot = Path.of(System.getProperty("pcs.repoRoot"), "agent")
        for (id in Checks.ids()) assertEquals(Checks.version(id), CheckDirs.version(agentRoot.resolve("checks/$id"), agentRoot), id)
        val d = toyCheckDir(tmp)
        val v = CheckDirs.version(d)
        Files.writeString(d.resolve("prompt.md"), "changed")
        assertNotEquals(v, CheckDirs.version(d))
    }
}
