package net.jonbell.pcs.cli.eval

import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import net.jonbell.pcs.agent.checks.AuthorInfo
import net.jonbell.pcs.agent.checks.FormatPolicy
import net.jonbell.pcs.agent.engines.DataClass
import net.jonbell.pcs.agent.engines.EngineConfigException
import net.jonbell.pcs.agent.llm.Decisions
import net.jonbell.pcs.agent.llm.Screener
import net.jonbell.pcs.core.config.Settings
import net.jonbell.pcs.core.config.SettingsException
import java.nio.file.Files
import java.nio.file.Path

/**
 * `pcs eval` (PLAN M21), the federated evaluation kit. A past venue's chair runs it on their own HotCRP data and reads one aggregate report.
 *
 * ```
 * pcs eval (--export <dir> | --token-file <file>) [--pdfs <dir>] [--engine <id>] [--class synthetic|public|confidential]
 *          [--tpms-scores f] [--tpms-registrations f] [--tpms-usable 0.4] [--desk-decision <text>] [--min-cell 5]
 *          [--authors f] [--cfp f] [--abstracts-by-paper f] [--format-policy f] [--no-effect] [--out <file>]
 * ```
 *
 * Offline by default: with `--export` and no `--engine` it opens no connection. `--token-file` reads HotCRP through the client's read paths only;
 * `--engine <id>` (from `PCS_ENGINES`) is the only way an LLM check runs. The report goes to `--out` or standard output. Nothing is uploaded,
 * and the kit has no code that sends a file.
 */
class EvalCommand(
    private val env: Map<String, String>,
    private val out: Appendable = System.out,
    private val err: Appendable = System.err,
    private val gateFor: (Set<String>) -> NetworkGate = { RequestedNetwork(it) },
) {
    fun run(args: List<String>): Int {
        val o =
            try {
                Opts.parse(args)
            } catch (e: IllegalArgumentException) {
                err.appendLine(e.message)
                err.appendLine(USAGE)
                return 2
            }
        return try {
            execute(o)
        } catch (e: OfflineViolation) {
            err.appendLine(e.message)
            1
        } catch (e: EngineConfigException) {
            err.appendLine("configuration problems:\n  " + e.problems.joinToString("\n  "))
            1
        } catch (e: SettingsException) {
            err.appendLine(e.message)
            1
        } catch (e: IllegalArgumentException) {
            err.appendLine(e.message)
            1
        } catch (e: net.jonbell.pcs.agent.engines.ClearanceRefused) {
            err.appendLine("refused: ${e.message}")
            1
        }
    }

    private class Opts(
        val export: Path?,
        val tokenFile: Path?,
        val pdfs: Path?,
        val engine: String?,
        val dataClass: DataClass,
        val tpmsScores: Path?,
        val tpmsRegistrations: Path?,
        val tpmsUsable: Double,
        val deskMatch: String,
        val minCell: Int,
        val authors: Path?,
        val cfp: Path?,
        val abstracts: Path?,
        val formatPolicy: Path?,
        val effect: Boolean,
        val outFile: Path?,
    ) {
        companion object {
            fun parse(args: List<String>): Opts {
                val m = HashMap<String, String>()
                var effect = true
                var i = 0
                while (i < args.size) {
                    val a = args[i]
                    when {
                        a == "--no-effect" -> effect = false
                        a in VALUE_FLAGS -> m[a] = args.getOrNull(++i) ?: throw IllegalArgumentException("$a needs a value")
                        else -> throw IllegalArgumentException("unknown option $a")
                    }
                    i++
                }

                fun p(k: String) = m[k]?.let { Path.of(it) }
                require((m["--export"] == null) != (m["--token-file"] == null)) { "give exactly one of --export <dir> and --token-file <file>" }
                val dc =
                    m["--class"]?.let { v -> DataClass.entries.firstOrNull { it.name.equals(v, true) } ?: throw IllegalArgumentException("--class: $v") }
                        ?: DataClass.CONFIDENTIAL
                val usable =
                    m["--tpms-usable"]?.toDoubleOrNull() ?: if ("--tpms-usable" in m) throw IllegalArgumentException("--tpms-usable: not a number") else 0.4
                require(usable in 0.0..1.0) { "--tpms-usable must be from 0 to 1" }
                val min =
                    m["--min-cell"]?.toIntOrNull() ?: if ("--min-cell" in m) throw IllegalArgumentException("--min-cell: not a number") else Disclosure.MIN_CELL
                require(min >= Disclosure.MIN_CELL) { "--min-cell may raise the smallest cell shown, never lower it below ${Disclosure.MIN_CELL}" }
                return Opts(
                    p("--export"),
                    p("--token-file"),
                    p("--pdfs"),
                    m["--engine"],
                    dc,
                    p("--tpms-scores"),
                    p("--tpms-registrations"),
                    usable,
                    m["--desk-decision"]?.takeIf { it.isNotBlank() } ?: "desk",
                    min,
                    p("--authors"),
                    p("--cfp"),
                    p("--abstracts-by-paper"),
                    p("--format-policy"),
                    effect,
                    p("--out"),
                )
            }
        }
    }

    private fun settings(): Settings {
        // the kit reads no answers file and, for an export, no HotCRP URL: placeholders keep the shared loader happy
        val base = env + mapOf("PCS_ANSWERS" to (env["PCS_ANSWERS"] ?: "unused"))
        val withUrl = if ("PCS_HOTCRP_URL" in base) base else base + ("PCS_HOTCRP_URL" to "http://localhost")
        val conf = env["PCS_CONF"]?.let { Path.of(it) }?.takeIf(Files::exists)?.let(Settings::readConf).orEmpty()
        return Settings.load(withUrl, conf).getOrThrow()
    }

    private fun execute(o: Opts): Int {
        val settings = settings()
        val allowed = buildSet { if (o.tokenFile != null) add("hotcrp") }
        // the engine decides at construction what it will ask for; the gate lets it ask for exactly its own kind
        val engineCfg = o.engine?.let { id -> net.jonbell.pcs.agent.engines.EngineConfigs.parse(env).firstOrNull { it.id == id } }
        if (o.engine != null && engineCfg == null) throw EngineConfigException(listOf("no engine '${o.engine}' is configured (PCS_ENGINES)"))
        val gate =
            gateFor(
                allowed + setOfNotNull(engineCfg?.takeIf { it.adapter != net.jonbell.pcs.agent.engines.Adapter.REPLAY }?.let { "engine:${it.adapter.key}" }),
            )

        val input =
            if (o.export != null) {
                EvalInput.fromExport(o.export)
            } else {
                val token = Files.readString(o.tokenFile!!).trim()
                require(token.isNotEmpty()) { "the token file is empty" }
                EvalInput.fromClient(settings.hotcrpUrl, token, gate)
            }
        val tpmsData = TpmsData.read(o.tpmsScores, o.tpmsRegistrations)
        val reviewed = EvalMetrics.reviewed(input.papers, o.deskMatch)

        val checks =
            o.pdfs?.let { dir ->
                val files = CheckRunner.pdfs(dir).filterKeys { pid -> input.papers.any { it.pid == pid } }
                val desk = input.papers.filter { EvalMetrics.deskRejected(it, o.deskMatch) }.map { it.pid }.toSet()
                val engine = o.engine?.let { CheckRunner.engine(it, env, gate) }
                val checksDir = Path.of(env["PCS_AGENT_CHECKS"] ?: "agent/checks")
                val json = kotlinx.serialization.json.Json
                val opts =
                    CheckRunner.Options(
                        dataClass = o.dataClass,
                        format = o.formatPolicy?.let { json.decodeFromString(FormatPolicy.serializer(), Files.readString(it)) } ?: FormatPolicy(),
                        authors =
                            o.authors?.let {
                                json.decodeFromString(
                                    MapSerializer(String.serializer(), AuthorInfo.serializer()),
                                    Files.readString(it),
                                )
                            }.orEmpty(),
                        cfp = o.cfp?.let(Files::readString),
                        abstracts =
                            o.abstracts?.let {
                                json.decodeFromString(
                                    MapSerializer(String.serializer(), MapSerializer(String.serializer(), String.serializer())),
                                    Files.readString(it),
                                )
                            }.orEmpty(),
                        decisions = env["PCS_AGENT_DECISIONS"]?.let { Decisions.load(Path.of(it)) } ?: Decisions.EMPTY,
                        effect = o.effect,
                    )
                val deps = if (engine != null && Files.isDirectory(checksDir)) Screener.deterministicDeps(checksDir) else emptyMap()
                val outcomes = CheckRunner.run(files, files.keys, opts, engine, deps)
                val screened = outcomes.map { it.pid }.toSet()
                val flagged = outcomes.filter { it.flaggedBy.isNotEmpty() }.map { it.pid }.toSet()
                val names = outcomes.flatMap { it.flaggedBy }.toSortedSet()
                ChecksResult(
                    papersWithPdf = outcomes.size,
                    deskRejectedWithPdf = screened.count { it in desk },
                    perCheck =
                        (net.jonbell.pcs.agent.checks.Checks.ids() + names).toSortedSet().map { c ->
                            val by = outcomes.filter { c in it.flaggedBy }.map { it.pid }.toSet()
                            CheckRow(c, by.size, by.count { it in desk })
                        },
                    any = EvalMetrics.confusion(screened, flagged, desk),
                    costUsd = outcomes.fold(java.math.BigDecimal.ZERO) { a, r -> a + r.costUsd },
                    calls = outcomes.sumOf { it.calls },
                )
            }

        val report =
            EvalReport(
                RunFacts(
                    engine = engineCfg?.adapter?.key ?: "deterministic only",
                    network = (gate as? RequestedNetwork)?.requested ?: allowed,
                    source = if (o.export != null) "an export directory" else "a HotCRP token (read-only)",
                ),
                reviewed = reviewed.size,
                pcMembers = input.pc.size,
                checks = checks,
                tpms = EvalMetrics.tpms(input, tpmsData, settings.reviewsRequired, o.tpmsUsable, o.deskMatch),
                composition = EvalMetrics.composition(input, settings.tierTags, settings.loadMax, o.deskMatch),
                earlyReject = EvalMetrics.earlyReject(input, settings.scoreScale, settings.fieldMerit, settings.reviewsRequired, o.deskMatch),
                disclosure = Disclosure(o.minCell),
            ).render()
        if (o.outFile != null) {
            Files.writeString(o.outFile, report)
            out.appendLine("wrote the report to ${o.outFile.fileName}. Read it before you send it anywhere; pcs eval sends nothing.")
        } else {
            out.append(report)
        }
        return 0
    }

    companion object {
        private val VALUE_FLAGS =
            setOf(
                "--export",
                "--token-file",
                "--pdfs",
                "--engine",
                "--class",
                "--tpms-scores",
                "--tpms-registrations",
                "--tpms-usable",
                "--desk-decision",
                "--min-cell",
                "--authors",
                "--cfp",
                "--abstracts-by-paper",
                "--format-policy",
                "--out",
            )
        const val USAGE =
            "usage: pcs eval (--export <dir> | --token-file <file>) [--pdfs <dir>] [--engine <id>] [--class synthetic|public|confidential] " +
                "[--tpms-scores f] [--tpms-registrations f] [--tpms-usable 0.4] [--desk-decision <text>] [--min-cell 5] [--authors f] [--cfp f] " +
                "[--abstracts-by-paper f] [--format-policy f] [--no-effect] [--out <file>]"
    }
}
