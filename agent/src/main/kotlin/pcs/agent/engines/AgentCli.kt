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

    private fun checksDir(): Path = Path.of(env["PCS_AGENT_CHECKS"] ?: "agent/checks")

    private fun decisions(): pcs.agent.llm.Decisions =
        env["PCS_AGENT_DECISIONS"]?.let { pcs.agent.llm.Decisions.load(Path.of(it)) } ?: pcs.agent.llm.Decisions.EMPTY.also {
            out.appendLine("# no decision file (PCS_AGENT_DECISIONS): every decision a check cites counts as unresolved")
        }

    /** `manifest [--checks dir] [--decisions file] [--qualifications file]` (agent.md §3.3): one table from the check directories, the decisions, and the qualification records. */
    fun manifest(args: List<String>): Int {
        var checks = checksDir()
        var dec = env["PCS_AGENT_DECISIONS"]?.let { Path.of(it) }
        var qual = env["PCS_AGENT_QUALIFICATIONS"]?.let { Path.of(it) }
        var i = 0
        while (i < args.size) {
            when (args[i]) {
                "--checks" -> checks = Path.of(args[++i])
                "--decisions" -> dec = Path.of(args[++i])
                "--qualifications" -> qual = Path.of(args[++i])
                else -> {
                    out.appendLine("unknown option ${args[i]}")
                    return 2
                }
            }
            i++
        }
        return try {
            val d = dec?.let { pcs.agent.llm.Decisions.load(it) } ?: pcs.agent.llm.Decisions.EMPTY
            out.append(pcs.agent.llm.Manifest.render(pcs.agent.llm.Manifest.rows(checks, d, pcs.agent.llm.Manifest.loadQualifications(qual)), d))
            0
        } catch (e: pcs.agent.llm.DecisionFileException) {
            out.appendLine("decision file problems:\n  " + e.problems.joinToString("\n  "))
            1
        }
    }

    /**
     * `screen <pdf>... [--class synthetic|public|confidential] [--cfp file] [--abstracts file.json] [--no-effect]`:
     * the LLM checks routed in the environment (`PCS_CHECK_<id>_ENGINE`), then the flag cards and the summary.
     * Unverified flags are counted, never printed.
     */
    fun screen(args: List<String>): Int {
        val pdfs = mutableListOf<String>()
        var dc = DataClass.SYNTHETIC
        var cfp = env["PCS_AGENT_CFP"]
        var abstracts: String? = null
        var effect = true
        var i = 0
        while (i < args.size) {
            when (args[i]) {
                "--class" -> dc = DataClass.entries.first { it.name.equals(args[++i], ignoreCase = true) }
                "--cfp" -> cfp = args[++i]
                "--abstracts" -> abstracts = args[++i]
                "--no-effect" -> effect = false
                else -> pdfs += args[i]
            }
            i++
        }
        return try {
            val cs = configs()
            val registered = cs.map { EngineFactory.create(it, env) }
            EgressPolicy.assertDisjoint(cs.mapNotNull { it.egressHost() }, EgressPolicy.forResolver(env["PCS_AGENT_EGRESS"]))
            val dispatcher = Dispatcher(registered, store())
            val decisions = decisions()
            val routing = EngineConfigs.routing(env)
            val dir = checksDir()
            val all = pcs.agent.llm.Screener.checks(dir)
            val routed = all.filter { it.id in routing }
            out.appendLine(
                "# LLM checks run: ${routed.joinToString {
                    it.id
                }.ifEmpty { "none (set PCS_CHECK_<id>_ENGINE)" }}; skipped: ${(all - routed.toSet()).joinToString { it.id }.ifEmpty { "none" }}",
            )
            val abs =
                abstracts?.let { f ->
                    val m = kotlinx.serialization.json.Json.decodeFromString<Map<String, String>>(Files.readString(Path.of(f)))
                    pcs.agent.llm.AbstractSource.fixed(m)
                } ?: pcs.agent.llm.AbstractSource.NONE
            val checkEnv = pcs.agent.llm.CheckEnv(cfp?.let { Files.readString(Path.of(it)) }, abs)
            val screener =
                pcs.agent.llm.Screener(
                    dispatcher,
                    routing,
                    routed,
                    decisions,
                    checkEnv,
                    pcs.agent.llm.Screener.deterministicDeps(dir),
                    options = pcs.agent.llm.ScreenOptions(effect = effect),
                )
            for (f in pdfs) {
                val p = PaperInput(Path.of(f).fileName.toString(), dc, Files.readAllBytes(Path.of(f)))
                val r = runBlocking { screener.screen(p) }
                val withheld = r.flags.size - r.shown.size
                val cached = r.calls.count { it.cached }
                out.appendLine("\n## ${p.id}: ${r.shown.size} flag(s) shown, $withheld unverified and withheld; ${r.calls.size} call(s), $cached cached")
                pcs.agent.llm.FlagCards.visible(r.flags, decisions).forEach { out.appendLine(it.text()) }
                r.summary?.let { out.appendLine(it.text()) }
            }
            0
        } catch (e: EngineConfigException) {
            out.appendLine("configuration problems:\n  " + e.problems.joinToString("\n  "))
            1
        } catch (e: ClearanceRefused) {
            out.appendLine("refused: ${e.message}")
            1
        } catch (e: pcs.agent.llm.DecisionFileException) {
            out.appendLine("decision file problems:\n  " + e.problems.joinToString("\n  "))
            1
        }
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
