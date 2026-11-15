package net.jonbell.pcs.agent.llm

import net.jonbell.pcs.agent.bundle.BundleCli
import net.jonbell.pcs.agent.bundle.BundleFixtures
import net.jonbell.pcs.agent.engines.AgentCli
import net.jonbell.pcs.testing.Covers
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.nio.file.Files
import java.nio.file.Path

/** The scope check's topic list comes from the file the chair sets in PCS_AGENT_CFP; a missing file is a stated, blocked state, never a default. */
@Covers("check:scope")
class CfpSourceTest {
    private val agentDir = File(System.getProperty("pcs.repoRoot"), "agent")
    private val decisions = Decisions.load(File(agentDir, "decisions.example.yaml").toPath())

    @Test
    fun `an unset, absent or empty file is a stated problem and a present one is the topic list`(
        @TempDir tmp: Path,
    ) {
        val unset = CfpSource.resolve(emptyMap())
        assertTrue(unset is Cfp.Missing && "PCS_AGENT_CFP is not set" in unset.problem)
        val gone = CfpSource.resolve(mapOf("PCS_AGENT_CFP" to tmp.resolve("nope.txt").toString()))
        assertTrue(gone is Cfp.Missing && "does not exist" in gone.problem)
        val empty = tmp.resolve("empty.txt").also { Files.writeString(it, "  \n") }
        assertTrue(CfpSource.resolve(mapOf("PCS_AGENT_CFP" to empty.toString())) is Cfp.Missing)
        val f = tmp.resolve("cfp.txt").also { Files.writeString(it, "Topics: testing, analysis.") }
        assertEquals("Topics: testing, analysis.", CfpSource.resolve(mapOf("PCS_AGENT_CFP" to f.toString())).textOrNull)
        assertEquals("Topics: testing, analysis.", CfpSource.resolve(emptyMap(), f.toString()).textOrNull, "--cfp works without the variable")
        assertEquals(null, CfpSource.resolve(emptyMap()).textOrNull, "no default text")
    }

    @Test
    fun `without a CFP file scope-cfp is unresolved, the scope check is blocked in the manifest, and with one nothing changes`(
        @TempDir tmp: Path,
    ) {
        val missing = CfpSource.resolve(emptyMap())
        val open = CfpSource.overlay(decisions, missing)
        assertEquals(listOf("scope.cfp"), open.blockers(listOf("scope.cfp")))
        assertTrue(decisions.blockers(listOf("scope.cfp")).isEmpty())
        val rows = Manifest.rows(File(agentDir, "checks").toPath(), open)
        assertEquals(listOf("scope"), rows.filter { "scope.cfp" in it.blockedBy }.map { it.check })
        // The request key follows the decision, so a run after the file is set is not served from a run without it.
        assertFalse(open.keyTokens(listOf("scope.cfp")) == decisions.keyTokens(listOf("scope.cfp")))
        val f = tmp.resolve("cfp.txt").also { Files.writeString(it, "Topics: testing.") }
        assertEquals(decisions, CfpSource.overlay(decisions, CfpSource.resolve(emptyMap(), f.toString())))
        assertEquals(null, CfpSource.warning(mapOf("anonymity.llm" to "e"), missing), "nothing to say if scope is not routed")
        assertTrue(CfpSource.warning(mapOf("scope" to "e"), missing)!!.startsWith("scope: BLOCKED"))
    }

    @Test
    fun `the CLIs say so when scope is routed and the file is missing, and the manifest lists it as blocked`(
        @TempDir tmp: Path,
    ) {
        val env =
            mapOf(
                "PCS_CHECK_scope_ENGINE" to "x",
                "PCS_AGENT_DECISIONS" to File(agentDir, "decisions.example.yaml").path,
                "PCS_AGENT_CHECKS" to File(agentDir, "checks").path,
            )
        val sb = StringBuilder()
        assertEquals(0, AgentCli(env, sb).manifest(emptyList()))
        assertTrue(sb.contains("scope.cfp (unresolved") && sb.contains("- `scope`: scope.cfp"), sb.toString())
        val ok = StringBuilder()
        val f = tmp.resolve("cfp.txt").also { Files.writeString(it, "Topics: testing.") }
        assertEquals(0, AgentCli(env + ("PCS_AGENT_CFP" to f.toString()), ok).manifest(emptyList()))
        assertFalse(ok.contains("scope.cfp (unresolved"), ok.toString())
        // The bundle command refuses nothing but prints the blocked state before it screens anything.
        val items = BundleFixtures.items(2)
        val run = BundleFixtures.prepare(tmp, items.mapIndexed { i, it -> "${101 + i}" to it })
        val out = StringBuilder()
        val args = BundleFixtures.args(run, tmp.resolve("out"), net.jonbell.pcs.core.bundle.ChairIdentity.generate().publicKey.text).toMutableList()
        val i = args.indexOf("--cfp")
        args.removeAt(i)
        args.removeAt(i)
        BundleCli(BundleFixtures.env(run), out).bundle(args)
        assertTrue(out.contains("scope: BLOCKED, scope.cfp is unresolved"), out.toString())
    }
}
