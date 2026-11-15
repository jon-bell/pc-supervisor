@file:Suppress("ktlint:standard:max-line-length")

package net.jonbell.pcs.agent.bundle

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.serializer
import net.jonbell.pcs.agent.checks.AuthorInfo
import net.jonbell.pcs.agent.checks.ScreenConfig
import net.jonbell.pcs.agent.engines.Adapter
import net.jonbell.pcs.agent.engines.DataClass
import net.jonbell.pcs.agent.engines.Dispatcher
import net.jonbell.pcs.agent.engines.EngineConfig
import net.jonbell.pcs.agent.engines.FileResultStore
import net.jonbell.pcs.agent.engines.PaperInput
import net.jonbell.pcs.agent.engines.Registered
import net.jonbell.pcs.agent.eval.EvalItem
import net.jonbell.pcs.agent.eval.HeldOut
import net.jonbell.pcs.agent.eval.Profiles
import net.jonbell.pcs.agent.eval.ScriptedEngine
import net.jonbell.pcs.agent.llm.AbstractSource
import net.jonbell.pcs.agent.llm.CheckEnv
import net.jonbell.pcs.agent.llm.Decisions
import net.jonbell.pcs.agent.llm.Flag
import net.jonbell.pcs.agent.llm.LlmCorpus
import net.jonbell.pcs.agent.llm.Screener
import java.io.File
import java.nio.file.Files
import java.nio.file.Path

/**
 * A screening run on synthetic papers with no live engine: the answers come from a scripted stand-in, are recorded
 * once, and `pcs agent bundle` then runs against a `replay` engine serving them. Shared by the unit and integration tests.
 */
object BundleFixtures {
    val agentDir = File(System.getProperty("pcs.repoRoot"), "agent")
    val checksDir: Path = agentDir.toPath().resolve("checks")
    val decisionsFile: Path = agentDir.toPath().resolve("decisions.example.yaml")
    const val ENGINE = "strong"
    const val MODEL = "scripted-strong"
    val llmChecks = listOf("anonymity.llm", "scope", "refs.use", "injection.addressed.llm", "summary")

    private val strongCfg = EngineConfig(ENGINE, Adapter.ANTHROPIC, MODEL, DataClass.PUBLIC, null, baseUrl = "http://127.0.0.1:0/v1")

    /** Synthetic papers of the held-out corpus: [n] of them, spread over the kinds of defect (injected ones and clean controls included). */
    fun items(n: Int): List<EvalItem> {
        val all = HeldOut.generate(perKind = 1, clean = 2).items
        val step = maxOf(1, all.size / n)
        return all.filterIndexed { i, _ -> i % step == 0 }.take(n)
    }

    class Run(
        val pids: List<String>,
        val dir: Path,
        val recordings: Path,
        val screens: Map<String, List<Flag>>,
        val cfp: Path,
    ) {
        val pdfDir: Path get() = dir.resolve("pdfs")
        val authorsFile: Path get() = dir.resolve("authors.json")
        val abstractsFile: Path get() = dir.resolve("abstracts.json")
    }

    /**
     * Writes the papers as `<pid>.pdf` with the authors and abstracts files a chair would export, and records the scripted
     * stand-in's answers, so that a replay engine can serve the same run. [papers] is (pid, item).
     */
    fun prepare(dir: Path, papers: List<Pair<String, EvalItem>>): Run {
        val pdfs = dir.resolve("pdfs").also { Files.createDirectories(it) }
        val json = Json
        papers.forEach { (pid, it) -> Files.write(pdfs.resolve("$pid.pdf"), it.case.pdf) }
        Files.writeString(
            dir.resolve("authors.json"),
            json.encodeToString(
                MapSerializer(serializer<String>(), AuthorInfo.serializer()),
                papers.associate { (pid, it) ->
                    pid to
                        it.case.authors
                },
            ),
        )
        Files.writeString(
            dir.resolve("abstracts.json"),
            json.encodeToString(
                MapSerializer(serializer<String>(), MapSerializer(serializer<String>(), serializer<String>())),
                papers.associate { (pid, it) ->
                    pid to
                        it.case.abstracts
                },
            ),
        )
        val cfp = dir.resolve("cfp.txt").also { Files.writeString(it, LlmCorpus.CFP) }
        val rec = dir.resolve("recordings")
        val dispatcher = Dispatcher(listOf(Registered(strongCfg, ScriptedEngine(ENGINE, Profiles.STRONG, 1, emptyMap(), MODEL))), FileResultStore(rec))
        val decisions = Decisions.load(decisionsFile)
        val all = Screener.checks(checksDir).filter { it.id in llmChecks }
        val screens =
            runBlocking {
                papers.associate { (pid, it) ->
                    val s =
                        Screener(
                            dispatcher,
                            llmChecks.associateWith {
                                ENGINE
                            },
                            all,
                            decisions,
                            CheckEnv(LlmCorpus.CFP, AbstractSource.fixed(it.case.abstracts)),
                            Screener.deterministicDeps(checksDir),
                        )
                    pid to s.screen(PaperInput(pid, DataClass.SYNTHETIC, it.case.pdf, ScreenConfig(authors = it.case.authors))).flags
                }
            }
        return Run(papers.map { it.first }, dir, rec, screens, cfp)
    }

    /** The environment of a `replay` engine serving [run]'s recordings, with every LLM check routed to it. */
    fun env(run: Run, extra: Map<String, String> = emptyMap()): Map<String, String> =
        buildMap {
            put("PCS_ENGINES", "rep")
            put("PCS_ENGINE_rep_ADAPTER", "replay")
            put("PCS_ENGINE_rep_REPLAY_OF", ENGINE)
            put("PCS_ENGINE_rep_MODEL", MODEL)
            put("PCS_ENGINE_rep_RECORDINGS", run.recordings.toString())
            llmChecks.forEach { put("PCS_CHECK_${it}_ENGINE", "rep") }
            put("PCS_AGENT_DECISIONS", decisionsFile.toString())
            put("PCS_AGENT_CHECKS", checksDir.toString())
            putAll(extra)
        }

    /** [to] is the `--to` value: chair public keys (or files of them), comma separated. */
    fun args(run: Run, out: Path, to: String, vararg more: String): List<String> =
        listOf(
            run.pdfDir.toString(),
            "--out",
            out.toString(),
            "--to",
            to,
            "--cfp",
            run.cfp.toString(),
            "--authors",
            run.authorsFile.toString(),
            "--abstracts-by-paper",
            run.abstractsFile.toString(),
        ) +
            more
}
