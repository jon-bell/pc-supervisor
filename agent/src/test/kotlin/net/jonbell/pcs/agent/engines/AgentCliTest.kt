package net.jonbell.pcs.agent.engines

import kotlinx.coroutines.runBlocking
import net.jonbell.pcs.agent.TestCorpus
import net.jonbell.pcs.testing.Covers
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.nio.file.Files
import java.nio.file.Path

@Covers("prop:S5")
class AgentCliTest {
    private fun cli(env: Map<String, String>): Pair<AgentCli, StringBuilder> = StringBuilder().let { AgentCli(env, it) to it }

    @Test
    fun `probe prints configuration and what replay has recorded, and makes no call`(
        @TempDir tmp: Path,
    ) {
        val rec = FileResultStore(tmp.resolve("rec"))
        val live = ScriptedEngine("dev")
        runBlocking { Dispatcher(listOf(Registered(cfg("dev", model = "m"), live)), rec).call("dev", request()) }
        val env =
            mapOf(
                "PCS_ENGINES" to "dev,ci,api,sh",
                "PCS_ENGINE_dev_ADAPTER" to "claude-code",
                "PCS_ENGINE_dev_MODEL" to "dev-model",
                "PCS_ENGINE_ci_ADAPTER" to "replay",
                "PCS_ENGINE_ci_REPLAY_OF" to "dev",
                "PCS_ENGINE_ci_MODEL" to "m",
                "PCS_ENGINE_ci_RECORDINGS" to tmp.resolve("rec").toString(),
                "PCS_ENGINE_api_ADAPTER" to "anthropic",
                "PCS_ENGINE_api_MODEL" to "api-model",
                "PCS_ENGINE_api_PLATFORM" to "vertex",
                "PCS_ENGINE_api_REGION" to "us-east5",
                "PCS_ENGINE_sh_ADAPTER" to "openai-compat",
                "PCS_ENGINE_sh_MODEL" to "x",
                "PCS_ENGINE_sh_BASE_URL" to "https://gpu.example.org/v1",
                "PCS_ENGINE_sh_CLEARANCE" to "public",
                "ANTHROPIC_API_KEY" to "must-never-be-printed",
            )
        val (c, out) = cli(env)
        assertEquals(0, c.probe(null))
        val text = out.toString()
        assertTrue(text.contains("dev: adapter=claude-code model=dev-model clearance=public"), text)
        assertTrue(text.contains("ci: adapter=replay") && text.contains("recorded: toy.summary=1"), text)
        assertTrue(text.contains("us-east5-aiplatform.googleapis.com"), text)
        assertTrue(text.contains("sh: adapter=openai-compat") && text.contains("clearance=public"), text)
        assertTrue(text.contains("reference resolver egress: [api.crossref.org"), text)
        assertFalse(text.contains("must-never-be-printed"))
        assertEquals(1, live.calls.get(), "probe called no engine")
    }

    @Test
    fun `plan and run through replay show a cache hit, then one check stale after a prompt edit`(
        @TempDir tmp: Path,
    ) {
        val paper = tmp.resolve("p1.pdf").also { Files.write(it, TestCorpus.clean.first().bytes) }
        val checks = tmp.resolve("checks")
        val a = toyCheckDir(checks, "toy.a", "Prompt A.")
        val b = toyCheckDir(checks, "toy.b", "Prompt B.")
        // Record both toy checks as engine `dev` (what a maintainer's live run would have produced).
        val rec = FileResultStore(tmp.resolve("rec"))
        val recorder = Dispatcher(listOf(Registered(cfg("dev", model = "m"), ScriptedEngine("dev"))), rec)
        val extraction =
            net.jonbell.pcs.agent.extract.PdfExtractor(
                net.jonbell.pcs.agent.extract.HeuristicReferenceParser,
            ).extract(TestCorpus.clean.first().bytes)
        val ctx = net.jonbell.pcs.agent.checks.ScreenContext(TestCorpus.clean.first().bytes, extraction, net.jonbell.pcs.agent.checks.ScreenConfig())

        fun record(dir: Path) {
            val c = DirLlmCheck(dir, partsOf = DirLlmCheck.FULL_TEXT)
            runBlocking {
                recorder.call("dev", CallRequest(CheckRef(c.id, c.version), DataClass.SYNTHETIC, c.system, c.parts(ctx), c.schema, c.maxOutputTokens))
            }
        }
        record(a)
        record(b)
        val env =
            mapOf(
                "PCS_ENGINES" to "ci",
                "PCS_ENGINE_ci_ADAPTER" to "replay",
                "PCS_ENGINE_ci_REPLAY_OF" to "dev",
                "PCS_ENGINE_ci_MODEL" to "m",
                "PCS_ENGINE_ci_RECORDINGS" to tmp.resolve("rec").toString(),
                "PCS_AGENT_STORE" to tmp.resolve("store").toString(),
                "PCS_CHECK_toy.a_ENGINE" to "ci",
                "PCS_CHECK_toy.b_ENGINE" to "ci",
            )
        val args = listOf(paper.toString(), "--llm-check", a.toString(), "--llm-check", b.toString())

        fun plan() =
            cli(env).let { (c, out) ->
                assertEquals(0, c.plan(args))
                out.toString()
            }

        assertTrue(plan().lines().first().contains("0 cached, 8 would run"), plan())
        val (runCli, runOut) = cli(env)
        assertEquals(0, runCli.run(args))
        assertEquals(8, runOut.lines().count { it.startsWith("ran") }, runOut.toString())
        val cached = plan()
        assertTrue(cached.lines().first().contains("8 cached, 0 would run"), cached)

        Files.writeString(a.resolve("prompt.md"), "Prompt A, edited.")
        val stale = plan()
        assertTrue(stale.lines().first().contains("7 cached, 1 would run"), stale)
        assertEquals(listOf("toy.a"), stale.lines().filter { it.startsWith("run ") }.map { it.split(Regex(" +"))[1].substringBefore('@') })
    }

    @Test
    fun `configuration problems are printed, not thrown`() {
        val (c, out) = cli(mapOf("PCS_ENGINES" to "x", "PCS_ENGINE_x_ADAPTER" to "nope"))
        assertEquals(1, c.plan(emptyList()))
        assertTrue(out.toString().contains("ADAPTER must be one of"))
    }
}
