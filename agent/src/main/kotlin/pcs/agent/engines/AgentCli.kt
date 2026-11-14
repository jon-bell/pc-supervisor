package pcs.agent.engines

import kotlinx.coroutines.runBlocking
import pcs.agent.checks.Checks
import java.nio.file.Files
import java.nio.file.Path

/**
 * `pcs agent probe | plan | run` (agent.md §8). Configuration comes from [env] (`PCS_ENGINES`,
 * `PCS_ENGINE_<id>_*`, `PCS_CHECK_<check>_ENGINE`, `PCS_AGENT_STORE`). Nothing here calls a model:
 * `probe` prints configuration (and, for replay, what is recorded), `plan` reads the store, and `run`
 * calls whatever engine routing says, so point it at `replay` or a local fake unless you mean it.
 */
class AgentCli(private val env: Map<String, String>, private val out: Appendable = System.out) {
    private fun configs() = EngineConfigs.parse(env)

    private fun store(): ResultStore = FileResultStore(Path.of(env["PCS_AGENT_STORE"] ?: "agent-store"))

    fun probe(only: String?): Int {
        val cs = configs().filter { only == null || it.id == only }
        if (cs.isEmpty()) {
            out.appendLine(if (only == null) "no engines configured (PCS_ENGINES)" else "no engine '$only' configured")
            return 1
        }
        out.appendLine("# pcs agent probe: configuration only, no call is made")
        for (c in cs) {
            out.appendLine(c.describe())
            if (c.adapter == Adapter.REPLAY) {
                val rec = c.recordings?.let { Path.of(it) }
                val n = if (rec != null && Files.isDirectory(rec)) ReplayEngine(c.id, FileResultStore(rec)).recorded() else emptyMap()
                out.appendLine("  recorded: ${if (n.isEmpty()) "nothing" else n.entries.joinToString { "${it.key}=${it.value}" }}")
            }
        }
        val resolver = EgressPolicy.forResolver(env["PCS_AGENT_EGRESS"])
        out.appendLine("reference resolver egress: ${resolver.allowedHosts.sorted()}")
        out.appendLine("local checks: ${Checks.ids().sorted().joinToString { "$it@${Checks.version(it)}" }}")
        return 0
    }

    private class Setup(val dispatcher: Dispatcher, val runner: Runner, val papers: List<PaperInput>)

    private fun setup(pdfs: List<String>, llmDirs: List<String>, dataClass: DataClass): Setup {
        val cs = configs()
        val store = store()
        val registered = cs.map { EngineFactory.create(it, env) }
        EgressPolicy.assertDisjoint(cs.mapNotNull { it.egressHost() }, EgressPolicy.forResolver(env["PCS_AGENT_EGRESS"]))
        val dispatcher = Dispatcher(registered, store)
        val llm = llmDirs.map { d -> DirLlmCheck(Path.of(d), partsOf = DirLlmCheck.FULL_TEXT) }
        val runner = Runner(dispatcher, store, llm = llm, routing = EngineConfigs.routing(env))
        val papers = pdfs.map { f -> PaperInput(Path.of(f).fileName.toString(), dataClass, Files.readAllBytes(Path.of(f))) }
        return Setup(dispatcher, runner, papers)
    }

    /** `plan <pdf>... [--llm-check dir]... [--class synthetic|public|confidential]` */
    fun plan(args: List<String>): Int =
        withSetup(args) { s ->
            out.append(s.runner.plan(s.papers).render())
            0
        }

    fun run(args: List<String>): Int =
        withSetup(args) { s ->
            val results = runBlocking { s.runner.run(s.papers) }
            for (r in results) {
                out.appendLine(
                    "${if (r.cached) "cached" else "ran   "} ${r.checkId} ${r.engineId} ${r.paperId} ${r.result?.status ?: "findings=${r.findings?.size}"}",
                )
            }
            0
        }

    private fun withSetup(args: List<String>, f: (Setup) -> Int): Int {
        val pdfs = mutableListOf<String>()
        val dirs = mutableListOf<String>()
        var dc = DataClass.SYNTHETIC
        var i = 0
        while (i < args.size) {
            when (args[i]) {
                "--llm-check" -> dirs += args[++i]
                "--class" -> dc = DataClass.entries.first { it.name.equals(args[++i], ignoreCase = true) }
                else -> pdfs += args[i]
            }
            i++
        }
        return try {
            f(setup(pdfs, dirs, dc))
        } catch (e: EngineConfigException) {
            out.appendLine("configuration problems:\n  " + e.problems.joinToString("\n  "))
            1
        } catch (e: ClearanceRefused) {
            out.appendLine("refused: ${e.message}")
            1
        }
    }
}
