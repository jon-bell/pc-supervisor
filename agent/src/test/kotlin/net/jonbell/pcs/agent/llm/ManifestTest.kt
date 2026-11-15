package net.jonbell.pcs.agent.llm

import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.Json
import net.jonbell.pcs.agent.checks.Checks
import net.jonbell.pcs.agent.engines.AgentCli
import net.jonbell.pcs.testing.Covers
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Files
import java.nio.file.Path

/** The manifest (agent.md §3.3): one table from the check directories, the decision file, and the qualification records. */
@Covers(
    "check:novelty",
    "check:format",
    "check:refs.doi",
    "check:anonymity",
    "check:scope",
    "check:refs.use",
    "check:summary",
    "check:injection.hidden",
    "check:injection.channels",
    "check:injection.addressed",
    "check:injection.effect",
)
class ManifestTest {
    private val agentDir = File(System.getProperty("pcs.repoRoot"), "agent")
    private val checks = File(agentDir, "checks").toPath()
    private val decisions by lazy { Decisions.load(File(agentDir, "decisions.example.yaml").toPath()) }

    @Test
    fun `the manifest has one row per check directory, each in exactly one category, with the build's version`() {
        val rows = Manifest.rows(checks, decisions)
        val dirs = checks.toFile().listFiles()!!.filter { it.isDirectory }.map { it.name }
        assertEquals(dirs.sorted(), rows.map { it.check })
        assertEquals(
            setOf("deterministic, with evidence", "LLM judgment, bounded", "differential, at run time", "escalated to a person"),
            rows.map { it.category }.toSet(),
        )
        assertEquals(1, rows.count { it.category == "escalated to a person" })
        assertEquals("novelty", rows.single { it.category == "escalated to a person" }.check)
        // The hash computed at run time over a directory equals the one the Gradle task computed.
        for (r in rows) assertEquals(Checks.version(r.check), r.version, r.check)
        assertTrue(rows.filter { it.category == "LLM judgment, bounded" }.all { it.establishedBy.contains("labelled cases") })
    }

    @Test
    fun `decisions appear with their status and a check that cites an unresolved one is listed as blocked`() {
        val rows = Manifest.rows(checks, decisions)
        val text = Manifest.render(rows, decisions)
        assertTrue(text.contains("| Check | Version | Category | Established by | Qualified on | Decisions (status) |"))
        assertTrue(text.contains("Q1 (provisional)") && text.contains("Q6 (assumed)") && text.contains("format.limits (settled)"))
        assertEquals(listOf("refs.use"), rows.filter { it.blockedBy.isNotEmpty() }.map { it.check })
        assertTrue(text.contains("- `refs.use`: refs.use.policy"))
        assertTrue(text.contains("Decisions not settled:") && text.contains("refs.use.policy (unresolved"))
        // Settling the decision changes the manifest, with no change to any check.
        val settled = Decisions(decisions.all.map { if (it.id == "refs.use.policy") it.copy(status = DecisionStatus.SETTLED) else it })
        assertTrue(Manifest.render(Manifest.rows(checks, settled), settled).contains("No check depends on an unresolved decision."))
        // With no decision file at all, every cited decision is unresolved.
        val none = Manifest.rows(checks, Decisions.EMPTY)
        assertTrue(none.filter { it.decisions.isNotEmpty() }.all { it.blockedBy.isNotEmpty() })
        assertTrue(Manifest.render(none, Decisions.EMPTY).contains("no record, so unresolved"))
    }

    @Test
    fun `a check directory edit is a new version, and a qualification record is shown only for the current version`(
        @TempDir tmp: Path,
    ) {
        val root = tmp.resolve("agent/checks")
        for (id in listOf("summary", "novelty")) File(checks.toFile(), id).copyRecursively(root.resolve(id).toFile())
        // The code files `check.yaml` lists are hashed too, so the copy needs them under the same relative paths.
        for (rel in listOf("SummaryCheck.kt", "ScreenLlmCheck.kt", "Anchoring.kt")) {
            val to = tmp.resolve("agent/src/main/kotlin/net/jonbell/pcs/agent/llm/$rel")
            Files.createDirectories(to.parent)
            Files.copy(File(agentDir, "src/main/kotlin/net/jonbell/pcs/agent/llm/$rel").toPath(), to)
        }
        val before = Manifest.rows(root, decisions).single { it.check == "summary" }
        assertEquals("unqualified", before.qualifiedOn)
        val q = Qualification("summary", before.version, "dev", "m1", "abstract", "held-out run 1")
        val quals = tmp.resolve("quals.json")
        Files.writeString(quals, Json.encodeToString(ListSerializer(Qualification.serializer()), listOf(q)))
        val loaded = Manifest.loadQualifications(quals)
        assertEquals("dev/m1 (abstract)", Manifest.rows(root, decisions, loaded).single { it.check == "summary" }.qualifiedOn)
        // Editing the prompt makes a new version: the record is stale, and the manifest says so.
        Files.writeString(root.resolve("summary/prompt.md"), Files.readString(root.resolve("summary/prompt.md")) + "\nBe brief.\n")
        val after = Manifest.rows(root, decisions, loaded).single { it.check == "summary" }
        assertNotEquals(before.version, after.version)
        assertTrue(after.qualifiedOn.startsWith("stale: qualified at ${before.version}"))
        assertEquals("n/a", Manifest.rows(root, decisions, loaded).single { it.check == "novelty" }.qualifiedOn)
    }

    @Test
    fun `pcs agent manifest renders the table from the directories and the decision file`() {
        val out = StringBuilder()
        val code = AgentCli(emptyMap(), out).manifest(listOf("--checks", checks.toString(), "--decisions", File(agentDir, "decisions.example.yaml").toString()))
        assertEquals(0, code)
        val text = out.toString()
        assertTrue(text.startsWith("# Screening manifest"))
        assertTrue(text.lines().count { it.startsWith("| `") } == checks.toFile().listFiles()!!.count { it.isDirectory })
        val bad = Files.createTempFile("decisions", ".yaml")
        Files.writeString(bad, "decisions:\n  - id: X\n    status: bogus\n    title: t\n    statement: s\n    owner_role: r\n")
        val err = StringBuilder()
        assertEquals(1, AgentCli(emptyMap(), err).manifest(listOf("--checks", checks.toString(), "--decisions", bad.toString())))
        assertTrue(err.toString().contains("decision file problems"))
    }
}
