@file:Suppress("ktlint:standard:max-line-length")

package net.jonbell.pcs.agent.eval

import net.jonbell.pcs.agent.engines.Adapter
import net.jonbell.pcs.agent.engines.DataClass
import net.jonbell.pcs.agent.engines.EngineConfig
import net.jonbell.pcs.agent.engines.EngineConfigs
import net.jonbell.pcs.agent.engines.EngineFactory
import net.jonbell.pcs.agent.engines.FileResultStore
import net.jonbell.pcs.agent.engines.Prices
import net.jonbell.pcs.agent.engines.ReplayEngine
import net.jonbell.pcs.agent.llm.LiveSample
import java.io.File
import java.math.BigDecimal
import java.nio.file.Files
import java.nio.file.Path

/** The engines that can be exercised with no network, no key and no GPU. */
object OfflineEngines {
    fun replay(agentDir: File): ShootoutEngine {
        val cfg =
            EngineConfig(
                "claude-code-haiku-replay",
                Adapter.REPLAY,
                LiveSample.MODEL,
                DataClass.PUBLIC,
                null,
                replayOf = LiveSample.ENGINE,
                recordings = File(agentDir, "fixtures/replay").path,
                concurrency = 1,
            )
        val store = FileResultStore(File(agentDir, "fixtures/replay").toPath())
        return ShootoutEngine(cfg, { _, _ ->
            ReplayEngine(cfg.id, store)
        }, standIn = false, note = "recorded claude-code / Haiku results (agent/fixtures/replay); only the recorded requests are served", rawVariant = false)
    }

    private fun scripted(profile: Profile, adapter: Adapter, prices: Prices, concurrency: Int, note: String, gpu: Double = 0.0): ShootoutEngine {
        val cfg =
            EngineConfig(
                profile.name,
                adapter,
                profile.name,
                DataClass.PUBLIC,
                null,
                baseUrl = "http://127.0.0.1:0/v1",
                prices = prices,
                concurrency = concurrency,
            )
        return ShootoutEngine(cfg, { run, text -> ScriptedEngine(profile.name, profile, run, text) }, standIn = true, note = note, gpuUsdPerHour = gpu)
    }

    /** Prices are illustrative round numbers, not any provider's; a real run reads them from `PCS_ENGINE_<id>_PRICE_IN` and `_PRICE_OUT`. */
    fun standIns(): List<ShootoutEngine> =
        listOf(
            scripted(Profiles.STRONG, Adapter.ANTHROPIC, Prices(BigDecimal("3"), BigDecimal("15")), 4, "stands in for a strong API engine"),
            scripted(
                Profiles.NOISY,
                Adapter.ANTHROPIC,
                Prices(BigDecimal("1"), BigDecimal("5")),
                8,
                "stands in for a cheaper tier: right on average, unstable between runs",
            ),
            scripted(
                Profiles.SELF_HOSTED,
                Adapter.OPENAI_COMPAT,
                Prices(BigDecimal.ZERO, BigDecimal.ZERO),
                2,
                "stands in for a small self-hosted model behind openai-compat; GPU rate assumed at 2 USD/h",
                gpu = 2.0,
            ),
        )

    fun all(agentDir: File) = listOf(replay(agentDir)) + standIns()
}

/**
 * `pcs agent shootout --corpus held-out|recorded [--offline | --engines id,id] [--checks a,b] [--k 3] [--out dir] [--no-raw] [--confirm-spend]`
 * (agent.md 7.3) and `pcs agent corpus validate|pin|standins` for the `public` manifest.
 *
 * `--offline` runs the replay of the recorded results and three scripted stand-ins: no network, no key.
 * `--engines` names engines configured in the environment (`PCS_ENGINES`...); any of them that is not a
 * replay can spend money, so the run prints what it would call and stops unless `--confirm-spend` is given.
 */
class ShootoutCli(
    private val env: Map<String, String>,
    private val out: Appendable = System.out,
    private val agentDir: File =
        File(
            env["PCS_AGENT_DIR"] ?: "agent",
        ),
) {
    fun shootout(args: List<String>): Int {
        var corpusName = "held-out"
        var offline = false
        var engineIds: List<String>? = null
        var checks: Set<String>? = null
        var k = 3
        var outDir = File(agentDir, "build/reports/shootout")
        var raw = true
        var confirm = false
        var i = 0
        while (i < args.size) {
            when (args[i]) {
                "--corpus" -> corpusName = args[++i]
                "--offline" -> offline = true
                "--engines" -> engineIds = args[++i].split(',').map { it.trim() }.filter { it.isNotEmpty() }
                "--checks" -> checks = args[++i].split(',').map { it.trim() }.toSet()
                "--k" -> k = args[++i].toInt()
                "--out" -> outDir = File(args[++i])
                "--no-raw" -> raw = false
                "--confirm-spend" -> confirm = true
                else -> {
                    out.appendLine("unknown option ${args[i]}")
                    return 2
                }
            }
            i++
        }
        val corpus =
            when (corpusName) {
                "held-out" -> HeldOut.generate()
                "recorded" -> RecordedDev.generate()
                "public" -> {
                    out.appendLine(
                        "the public corpus needs fetched PDFs and a pinned manifest: see `pcs agent corpus`. Its mutants are not implemented yet (agent.md 7.2 operators work on generated papers), so it cannot be shot out.",
                    )
                    return 2
                }
                else -> {
                    out.appendLine("unknown corpus $corpusName (held-out, recorded, public)")
                    return 2
                }
            }
        val scale = env["PCS_AGENT_SCALE_PAPERS"]?.toIntOrNull()?.takeIf { it > 0 } ?: 4000
        val engines: List<ShootoutEngine> =
            if (offline) {
                OfflineEngines.all(agentDir)
            } else {
                val ids =
                    engineIds ?: run {
                        out.appendLine("give --offline, or --engines <ids> naming engines configured in PCS_ENGINES")
                        return 2
                    }
                val configs = EngineConfigs.parse(env).associateBy { it.id }
                val unknown = ids.filter { it !in configs }
                if (unknown.isNotEmpty()) {
                    out.appendLine("no engine configured for: $unknown")
                    return 1
                }
                ids.map { id ->
                    val reg = EngineFactory.create(configs.getValue(id), env)
                    ShootoutEngine(
                        reg.config,
                        { _, _ -> reg.engine },
                        standIn = false,
                        note = "configured in the environment",
                        gpuUsdPerHour =
                            env["PCS_ENGINE_${id}_GPU_HOUR_USD"]?.toDoubleOrNull() ?: 0.0,
                    )
                }
            }
        val spends = engines.filter { !it.standIn && it.config.adapter != Adapter.REPLAY }
        if (spends.isNotEmpty() && !confirm) {
            val papers = corpus.items.size
            out.appendLine(
                "# plan only: ${spends.joinToString {
                    it.id
                }} would be called live. About ${papers * k} paper-runs of the corpus's checks per engine (at least ${corpus.items.sumOf {
                    it.checks.size
                } * k} requests per engine, more for per-span and rerun calls).",
            )
            out.appendLine("# Re-run with --confirm-spend to make them. Nothing was called.")
            return 2
        }
        val report = Shootout.run(corpus, engines, agentDir, ShootoutOptions(k = k, scalePapers = scale, rawVariant = raw, checks = checks))
        Shootout.write(report, outDir)
        out.append(Shootout.markdown(report))
        out.appendLine("\n# wrote ${File(outDir, "shootout-${report.corpus}.md")} and .json")
        return 0
    }

    /** `corpus validate <manifest> [dir]`, `corpus pin <manifest> <dir>` (rewrites the manifest with checksums), `corpus standins <dir>`. */
    fun corpus(args: List<String>): Int {
        try {
            when (args.firstOrNull()) {
                "validate" -> {
                    val loaded = PublicCorpus.load(Path.of(args[1]), args.getOrNull(2)?.let { Path.of(it) })
                    loaded.forEach { out.appendLine("${it.entry.id}\t${it.entry.split}\t${it.entry.license}\t${it.status}") }
                    out.appendLine("usable: dev ${PublicCorpus.usable(loaded, "dev").size}, held-out ${PublicCorpus.usable(loaded, "held-out").size}")
                    return if (loaded.any { it.status == PublicStatus.CHECKSUM_MISMATCH }) 1 else 0
                }
                "pin" -> {
                    val m = PublicCorpus.pin(Path.of(args[1]), Path.of(args[2]))
                    Files.writeString(Path.of(args[1]), PublicCorpus.render(m))
                    out.appendLine("pinned ${m.entries.count { it.sha256 != null }} of ${m.entries.size} entries in ${args[1]}")
                    return 0
                }
                "standins" -> {
                    val m = PublicCorpus.writeStandIns(Path.of(args[1]))
                    out.appendLine("wrote ${m.entries.size} synthetic stand-ins and manifest.json to ${args[1]}")
                    return 0
                }
            }
        } catch (e: PublicCorpusException) {
            out.appendLine("manifest problems:\n  " + e.problems.joinToString("\n  "))
            return 1
        } catch (e: IndexOutOfBoundsException) {
            out.appendLine("missing argument")
            return 2
        }
        out.appendLine("usage: pcs agent corpus validate <manifest> [dir] | pin <manifest> <dir> | standins <dir>")
        return 2
    }
}

fun main(args: Array<String>) {
    kotlin.system.exitProcess(ShootoutCli(System.getenv()).shootout(args.toList()))
}
