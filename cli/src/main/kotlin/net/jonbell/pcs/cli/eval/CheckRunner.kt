package net.jonbell.pcs.cli.eval

import kotlinx.coroutines.runBlocking
import net.jonbell.pcs.agent.checks.AuthorInfo
import net.jonbell.pcs.agent.checks.FormatPolicy
import net.jonbell.pcs.agent.checks.ScreenConfig
import net.jonbell.pcs.agent.checks.Severity
import net.jonbell.pcs.agent.engines.DataClass
import net.jonbell.pcs.agent.engines.Dispatcher
import net.jonbell.pcs.agent.engines.EgressPolicy
import net.jonbell.pcs.agent.engines.EngineConfig
import net.jonbell.pcs.agent.engines.EngineConfigException
import net.jonbell.pcs.agent.engines.EngineConfigs
import net.jonbell.pcs.agent.engines.EngineFactory
import net.jonbell.pcs.agent.engines.PaperInput
import net.jonbell.pcs.agent.engines.ResultStore
import net.jonbell.pcs.agent.llm.AbstractSource
import net.jonbell.pcs.agent.llm.CheckEnv
import net.jonbell.pcs.agent.llm.Decisions
import net.jonbell.pcs.agent.llm.Flag
import net.jonbell.pcs.agent.llm.GroundPolicy
import net.jonbell.pcs.agent.llm.ScreenLlmCheck
import net.jonbell.pcs.agent.llm.ScreenOptions
import net.jonbell.pcs.agent.llm.Screener
import net.jonbell.pcs.agent.qualify.QualificationFile
import net.jonbell.pcs.agent.qualify.QualificationGate
import java.math.BigDecimal
import java.nio.file.Files
import java.nio.file.Path

/** What the screening checks did to one paper, reduced to what the kit may keep: which checks flagged it, and what the calls cost. */
class PaperOutcome(val pid: Long, val flaggedBy: Set<String>, val costUsd: BigDecimal, val calls: Int)

/** Which engine a run uses. [adapter] is the kind (`replay`, `openai-compat`, `anthropic`, `claude-code`), the only thing about it the report names. */
class EngineChoice(val config: EngineConfig, val adapter: String, val checks: List<ScreenLlmCheck>, val dispatcher: Dispatcher)

/**
 * Runs the screening checks on a directory of PDFs named `<pid>.pdf`. With no engine, only the deterministic checks run, locally, and nothing
 * is constructed that could connect. With an engine, every LLM check is routed to it and the dispatcher's clearance and qualification checks
 * apply as they do for `pcs agent bundle`. The result is a set of check ids per paper: no anchor, quotation or text survives this class.
 */
object CheckRunner {
    /** Builds the engine the chair picked from `PCS_ENGINES` / `PCS_ENGINE_<id>_*`, asking [gate] first if it can connect. */
    fun engine(id: String, env: Map<String, String>, gate: NetworkGate): EngineChoice {
        val configs = EngineConfigs.parse(env)
        val cfg =
            configs.firstOrNull { it.id == id }
                ?: throw EngineConfigException(listOf("no engine '$id' is configured (PCS_ENGINES lists ${configs.joinToString { it.id }.ifEmpty { "none" }})"))
        EgressPolicy.assertDisjoint(listOfNotNull(cfg.egressHost()), EgressPolicy.forResolver(env["PCS_AGENT_EGRESS"]))
        // replay serves recordings from disk; every other adapter calls out (the CLI adapter through its own login)
        if (cfg.adapter != net.jonbell.pcs.agent.engines.Adapter.REPLAY) gate.open("engine:${cfg.adapter.key}")
        val registered = EngineFactory.create(cfg, env)
        val quals = QualificationFile.load(env["PCS_AGENT_QUALIFICATIONS"]?.let { Path.of(it) })
        val store: ResultStore = net.jonbell.pcs.agent.engines.InMemoryResultStore()
        val dispatcher = Dispatcher(listOf(registered), store, gate = QualificationGate(quals))
        val checksDir = Path.of(env["PCS_AGENT_CHECKS"] ?: "agent/checks")
        require(Files.isDirectory(checksDir)) { "the LLM checks' directory is not at $checksDir; set PCS_AGENT_CHECKS" }
        return EngineChoice(cfg, cfg.adapter.key, Screener.checks(checksDir), dispatcher)
    }

    class Options(
        val dataClass: DataClass = DataClass.CONFIDENTIAL,
        val format: FormatPolicy = FormatPolicy(),
        val authors: Map<String, AuthorInfo> = emptyMap(),
        val cfp: String? = null,
        val abstracts: Map<String, Map<String, String>> = emptyMap(),
        val decisions: Decisions = Decisions.EMPTY,
        val effect: Boolean = true,
    )

    /** The pids with a PDF in [dir], sorted. Files that are not `<number>.pdf` are ignored. */
    fun pdfs(dir: Path): Map<Long, Path> =
        Files.list(dir).use { s ->
            s.toList().mapNotNull { f ->
                f.fileName.toString().removeSuffix(".pdf").takeIf { f.fileName.toString().endsWith(".pdf") }?.toLongOrNull()?.let {
                    it to
                        f
                }
            }
        }.sortedBy { it.first }.toMap(java.util.LinkedHashMap())

    fun run(
        files: Map<Long, Path>,
        only: Set<Long>,
        options: Options,
        engine: EngineChoice?,
        deps: Map<String, List<String>> = emptyMap(),
    ): List<PaperOutcome> {
        val routing = engine?.checks?.associate { it.id to engine.config.id }.orEmpty()
        val screener = { abs: AbstractSource ->
            Screener(
                engine?.dispatcher ?: Dispatcher(emptyList()),
                routing,
                engine?.checks.orEmpty(),
                options.decisions,
                CheckEnv(options.cfp, abs),
                deps,
                options = ScreenOptions(effect = options.effect),
            )
        }
        return files.filterKeys { it in only }.map { (pid, f) ->
            val id = pid.toString()
            val paper =
                PaperInput(
                    id,
                    options.dataClass,
                    Files.readAllBytes(f),
                    ScreenConfig(
                        format = options.format,
                        authors =
                            options.authors[id] ?: AuthorInfo(),
                    ),
                )
            val abs = options.abstracts[id]?.let { AbstractSource.fixed(it) } ?: AbstractSource.NONE
            val s = runBlocking { screener(abs).screen(paper) }
            PaperOutcome(
                pid,
                s.flags.filter(::isFlag).map { it.check }.toSortedSet(),
                s.calls.fold(BigDecimal.ZERO) { a, c -> a + c.costUsd },
                s.calls.size,
            )
        }
    }

    /** The app's own notion of a flag a person sees: verified, and a ground or at least MEDIUM. */
    fun isFlag(f: Flag): Boolean = f.verified && (GroundPolicy.groundOf(f) != null || f.severity >= Severity.MEDIUM)
}
