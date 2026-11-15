@file:Suppress("ktlint:standard:max-line-length")

package net.jonbell.pcs.agent.eval

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import net.jonbell.pcs.agent.checks.ScreenConfig
import net.jonbell.pcs.agent.checks.Severity
import net.jonbell.pcs.agent.engines.Dispatcher
import net.jonbell.pcs.agent.engines.Engine
import net.jonbell.pcs.agent.engines.EngineConfig
import net.jonbell.pcs.agent.engines.PaperInput
import net.jonbell.pcs.agent.engines.Part
import net.jonbell.pcs.agent.engines.Registered
import net.jonbell.pcs.agent.engines.Status
import net.jonbell.pcs.agent.extract.HeuristicReferenceParser
import net.jonbell.pcs.agent.extract.PdfExtractor
import net.jonbell.pcs.agent.llm.CheckEnv
import net.jonbell.pcs.agent.llm.Decisions
import net.jonbell.pcs.agent.llm.Flag
import net.jonbell.pcs.agent.llm.LiveSample
import net.jonbell.pcs.agent.llm.LlmUnit
import net.jonbell.pcs.agent.llm.PaperScreen
import net.jonbell.pcs.agent.llm.ScreenLlmCheck
import net.jonbell.pcs.agent.llm.ScreenOptions
import net.jonbell.pcs.agent.llm.Screener
import java.io.File
import java.util.Base64

/** One engine in the comparison. [standIn] engines are scripted functions, not models; the report says so. */
class ShootoutEngine(
    val config: EngineConfig,
    /** A fresh engine for run number `run` (1-based). Scripted stand-ins take the run for their per-run noise and the text of PDFs they are handed whole (by the hash of its base64); a replay ignores both. */
    val make: (run: Int, pdfText: Map<String, String>) -> Engine,
    val standIn: Boolean,
    val note: String,
    /** USD per GPU hour for a self-hosted engine; spread over the engine's concurrency, added to the per-call cost. */
    val gpuUsdPerHour: Double = 0.0,
    /** False for an engine that cannot serve the raw-PDF variant (a replay of recordings that were not made with it). */
    val rawVariant: Boolean = true,
) {
    val id: String get() = config.id
}

class ShootoutOptions(
    /** Runs per paper (agent.md 7.3 default 3). */
    val k: Int = 3,
    /** The instance size for projections: `PCS_AGENT_SCALE_PAPERS`. */
    val scalePapers: Int = 4000,
    val minRecall: Double = 0.7,
    val maxFalseFlagRate: Double = 0.1,
    val minAnchorValidity: Double = 0.95,
    val minStability: Double = 0.9,
    /** Also run the raw-PDF variant, for the scaffold delta. */
    val rawVariant: Boolean = true,
    val checks: Set<String>? = null,
    val parallelism: Int = 4,
)

@Serializable
data class CheckEngineRow(
    val check: String,
    val engine: String,
    val variant: String,
    val positives: Int,
    val negatives: Int,
    val recall: Interval,
    val falseFlagRate: Interval,
    val precision: Interval,
    val balancedAccuracy: Interval,
    val anchorValidity: Interval,
    val refusalRate: Interval,
    val schemaInvalidRate: Interval,
    val truncationRate: Interval,
    val errorRate: Interval,
    val stabilityItems: Int,
    val agreement: Interval,
    val passK: Interval,
    val flakyFlags: Int,
    val distinctFlags: Int,
    val costPerPaperUsd: Interval,
    val projectedCostUsd: Interval,
    val latencySecPerPaper: Double,
    val projectedWallHours: Double,
    val frontier: Boolean,
    val meetsThresholds: Boolean,
    val thresholdNote: String,
)

@Serializable
data class ScaffoldRow(val check: String, val engine: String, val scaffolded: Interval, val raw: Interval, val delta: Interval)

@Serializable
data class ResistanceRow(val engine: String, val check: String, val pairs: Int, val changedLeftIn: Interval, val changedStripped: Interval)

/** The `summary` check has no labels: its anchor validity is the share of statements the harness could anchor (agent.md 7.4). */
@Serializable
data class SummaryRow(val engine: String, val check: String, val statements: Int, val anchorValidity: Interval)

@Serializable
data class AgreementRow(val check: String, val a: String, val b: String, val items: Int, val agreement: Interval)

@Serializable
data class CoverageRow(val engine: String, val items: Int, val coveredItems: Int, val uncoveredCalls: Int, val calls: Int)

@Serializable
data class EngineInfo(
    val id: String,
    val adapter: String,
    val model: String,
    val standIn: Boolean,
    val note: String,
    val inUsdPerMTok: String,
    val outUsdPerMTok: String,
    val gpuUsdPerHour: Double,
    val concurrency: Int,
)

@Serializable
data class ShootoutReport(
    val corpus: String,
    val corpusNote: String,
    val fingerprint: String,
    val items: Int,
    val k: Int,
    val scalePapers: Int,
    val engines: List<EngineInfo>,
    val coverage: List<CoverageRow>,
    val rows: List<CheckEngineRow>,
    val recommended: Map<String, String>,
    val totals: Map<String, Interval>,
    val scaffold: List<ScaffoldRow>,
    val resistance: List<ResistanceRow>,
    val agreement: List<AgreementRow>,
    /** engine id -> paper id -> the flags (check|kind|quote) the first scaffolded run raised: what a qualification record keeps, so a later change can list the flags it moves. */
    val flagSets: Map<String, Map<String, List<String>>> = emptyMap(),
    /** Anchor validity of the unlabelled `summary` check, per engine (the first half of its qualification rule; resistance is the second). */
    val summaries: List<SummaryRow> = emptyList(),
)

/** What one engine's one run of the checks on one paper produced. */
private class Obs(val engine: String, val variant: String, val run: Int, val item: EvalItem, val screen: PaperScreen)

object RawVariant {
    /** The checks whose input is plain paper text, so handing the PDF over whole is a fair no-scaffold variant with the same prompt and schema. */
    val CHECKS = setOf("anonymity.llm", "scope")

    /** Replaces the extracted paper text with the PDF itself; the CFP stays (it is the question, not scaffolding). */
    fun transform(): (ScreenLlmCheck, LlmUnit, PaperInput) -> LlmUnit =
        { c, u, p ->
            if (c.id !in CHECKS) {
                u
            } else {
                val b64 = Base64.getEncoder().encodeToString(p.pdf)
                LlmUnit(
                    u.label + "/pdf",
                    u.parts.map {
                        if (it is Part.Text &&
                            (it.label.startsWith("paper body") || it.label.startsWith("opening"))
                        ) {
                            Part.Pdf("the paper (PDF)", b64)
                        } else {
                            it
                        }
                    },
                    u.context,
                )
            }
        }
}

object Shootout {
    private val json =
        Json {
            prettyPrint = true
            encodeDefaults = true
        }

    private fun norm(s: String) = java.text.Normalizer.normalize(s, java.text.Normalizer.Form.NFKC).lowercase().filter { it.isLetterOrDigit() }

    /** The flags an AC would see as a flag of [check]: verified, and at MEDIUM or above (a LOW "unclear" is a signal, not a flag). */
    private fun flagged(s: PaperScreen, check: String) = s.flags.filter { it.check == check && it.verified && it.severity >= Severity.MEDIUM }

    private fun hit(label: Label, s: PaperScreen): Boolean =
        flagged(s, label.check).any { f ->
            (label.kind == null || f.kind == label.kind) && (label.key == null || norm(f.anchors.joinToString(" ") { it.quote }).contains(norm(label.key)))
        }

    private fun signature(f: Flag) = "${f.check}|${f.kind}|${norm(f.anchors.firstOrNull()?.quote.orEmpty()).take(60)}"

    private fun uncovered(c: net.jonbell.pcs.agent.llm.CallRecord) = c.status == Status.ERROR && c.detail?.startsWith("no recording") == true

    /** Runs every engine, [ShootoutOptions.k] times, on every paper, and measures (agent.md 7.3). */
    fun run(corpus: EvalCorpus, engines: List<ShootoutEngine>, agentDir: File, opt: ShootoutOptions = ShootoutOptions()): ShootoutReport {
        val decisions = Decisions.load(File(agentDir, "decisions.example.yaml").toPath())
        val allChecks = Screener.checks(File(agentDir, "checks").toPath())
        val deps = Screener.deterministicDeps(File(agentDir, "checks").toPath())
        val items = corpus.items.map { it.restricted(opt.checks) }.filter { it.checks.isNotEmpty() }
        val pdfText: Map<String, String> =
            items.associate { it.id to it.case.pdf }.let { pdfs ->
                pdfs.values.associate { pdf ->
                    sha256Of(Base64.getEncoder().encodeToString(pdf)) to
                        PdfExtractor(HeuristicReferenceParser).extract(pdf).pages.joinToString("\n") { it.text }
                }
            }
        val gate = Semaphore(opt.parallelism)
        val obs = mutableListOf<Obs>()
        runBlocking(Dispatchers.Default) {
            for (e in engines) {
                for (variant in listOf("scaffold", "raw-pdf")) {
                    if (variant == "raw-pdf" && !(opt.rawVariant && e.rawVariant)) continue
                    val its =
                        if (variant ==
                            "raw-pdf"
                        ) {
                            items.filter { it.labels.any { l -> l.check in RawVariant.CHECKS } }.map { it.restricted(RawVariant.CHECKS) }
                        } else {
                            items
                        }
                    for (run in 1..opt.k) {
                        val engine = e.make(run, pdfText)
                        val dispatcher = Dispatcher(listOf(Registered(e.config, engine)))
                        val tag = (if (run == 1) "" else "r$run")
                        val results =
                            its.map { item ->
                                async {
                                    gate.withPermit {
                                        val ids = item.checks
                                        val screener =
                                            Screener(
                                                dispatcher,
                                                ids.associateWith { e.id },
                                                LiveSample.checksOf(allChecks, ids),
                                                decisions,
                                                CheckEnv(
                                                    net.jonbell.pcs.agent.llm.LlmCorpus.CFP,
                                                    net.jonbell.pcs.agent.llm.AbstractSource.fixed(item.case.abstracts),
                                                ),
                                                deps,
                                                options = ScreenOptions(effect = item.injected && variant == "scaffold"),
                                                runTag = tag + if (variant == "raw-pdf") "pdf" else "",
                                                unitTransform = if (variant == "raw-pdf") RawVariant.transform() else null,
                                            )
                                        val screen =
                                            screener.screen(
                                                PaperInput(item.id, item.dataClass, item.case.pdf, ScreenConfig(authors = item.case.authors)),
                                            )
                                        Obs(e.id, variant, run, item, screen)
                                    }
                                }
                            }.awaitAll()
                        synchronized(obs) { obs += results }
                    }
                }
            }
        }
        return report(corpus, items, engines, obs, opt)
    }

    private fun sha256Of(s: String) = net.jonbell.pcs.agent.engines.Keys.sha256(s)

    private fun EvalItem.restricted(only: Set<String>?): EvalItem =
        if (only == null) this else EvalItem(id, case, dataClass, labels.filter { it.check in only }, checks.filter { it in only }, twin)

    private class Cell(val item: EvalItem, val label: Label, val runs: List<Obs>) {
        /** Runs in which every call of the check was served (a replay miss makes the run uncovered). */
        val covered: List<Obs> = runs.filter { o -> o.screen.calls.filter { it.check == label.check }.none(::uncovered) }

        fun flaggedIn(o: Obs) = flagged(o.screen, label.check).isNotEmpty()

        fun hitIn(o: Obs) = if (label.role == Role.POSITIVE) hit(label, o.screen) else false

        fun correctIn(o: Obs) = if (label.role == Role.POSITIVE) hitIn(o) else !flaggedIn(o)

        /** Majority across covered runs; a tie counts as flagged. */
        val flagged: Boolean get() = covered.count { flaggedIn(it) } * 2 >= covered.size
        val hit: Boolean get() = covered.count { hitIn(it) } * 2 >= covered.size
    }

    private fun report(corpus: EvalCorpus, items: List<EvalItem>, engines: List<ShootoutEngine>, obs: List<Obs>, opt: ShootoutOptions): ShootoutReport {
        val rows = mutableListOf<CheckEngineRow>()
        val order = listOf("anonymity.llm", "scope", "refs.use", "injection.addressed.llm")
        val checks = items.flatMap { it.labels.map { l -> l.check } }.distinct().sortedBy { order.indexOf(it).let { i -> if (i < 0) 99 else i } }

        fun cells(engine: String, variant: String, check: String): List<Cell> =
            items.flatMap { item ->
                item.labels.filter { it.check == check }.map { l ->
                    Cell(
                        item,
                        l,
                        obs.filter {
                            it.engine == engine &&
                                it.variant == variant &&
                                it.item.id == item.id
                        }.sortedBy { it.run },
                    )
                }
            }

        for (variant in listOf("scaffold", "raw-pdf")) {
            for (check in checks) {
                if (variant == "raw-pdf" && check !in RawVariant.CHECKS) continue
                for (e in engines) {
                    val cs = cells(e.id, variant, check).filter { it.covered.isNotEmpty() }
                    if (cs.isEmpty() && obs.none { it.engine == e.id && it.variant == variant }) continue
                    rows += row(check, e, variant, cs, obs, opt)
                }
            }
        }
        // Frontier and recommendation, per check, on the scaffolded variant.
        val marked =
            rows.map { r ->
                if (r.variant != "scaffold") {
                    r
                } else {
                    val peers = rows.filter { it.check == r.check && it.variant == "scaffold" && it.balancedAccuracy.n > 0 }
                    val dominated =
                        r.balancedAccuracy.n > 0 &&
                            peers.any { o ->
                                o !== r &&
                                    o.costPerPaperUsd.est <= r.costPerPaperUsd.est &&
                                    o.balancedAccuracy.est >= r.balancedAccuracy.est &&
                                    (o.costPerPaperUsd.est < r.costPerPaperUsd.est || o.balancedAccuracy.est > r.balancedAccuracy.est)
                            }
                    r.copy(frontier = r.balancedAccuracy.n > 0 && !dominated)
                }
            }
        val recommended =
            checks.associateWith { c ->
                val ok = marked.filter { it.check == c && it.variant == "scaffold" && it.meetsThresholds }.minByOrNull { it.costPerPaperUsd.est }
                ok?.let { it.engine + if (it.thresholdNote.isNotEmpty()) " (provisional: ${it.thresholdNote})" else "" }
                    ?: marked.filter {
                        it.check == c && it.variant == "scaffold" && it.balancedAccuracy.n > 0
                    }.maxByOrNull { it.balancedAccuracy.est }?.let { "none meets the thresholds; best quality: ${it.engine}" }
                    ?: "no engine covered this check"
            }
        val totals =
            engines.associate { e ->
                val rs = marked.filter { it.engine == e.id && it.variant == "scaffold" && it.projectedCostUsd.n > 0 }
                e.id to
                    Interval(
                        rs.sumOf {
                            it.projectedCostUsd.est
                        },
                        rs.sumOf { it.projectedCostUsd.lo },
                        rs.sumOf { it.projectedCostUsd.hi },
                        rs.sumOf { it.projectedCostUsd.n },
                    )
            }
        val scaffold =
            RawVariant.CHECKS.flatMap { c ->
                engines.mapNotNull { e ->
                    val a = marked.firstOrNull { it.check == c && it.engine == e.id && it.variant == "scaffold" }
                    val b = marked.firstOrNull { it.check == c && it.engine == e.id && it.variant == "raw-pdf" }
                    if (a == null || b == null || a.balancedAccuracy.n == 0 || b.balancedAccuracy.n == 0) {
                        null
                    } else {
                        ScaffoldRow(c, e.id, a.balancedAccuracy, b.balancedAccuracy, scaffoldDelta(c, e.id, items, obs))
                    }
                }
            }
        return ShootoutReport(
            corpus.name,
            corpus.note,
            corpus.fingerprint,
            items.size,
            opt.k,
            opt.scalePapers,
            engines.map {
                EngineInfo(
                    it.id,
                    it.config.adapter.key,
                    it.config.model,
                    it.standIn,
                    it.note,
                    it.config.prices.input.toPlainString(),
                    it.config.prices.output.toPlainString(),
                    it.gpuUsdPerHour,
                    it.config.concurrency,
                )
            },
            engines.map { e ->
                val mine = obs.filter { it.engine == e.id && it.variant == "scaffold" }
                val calls = mine.flatMap { it.screen.calls }
                val coveredItems = items.count { item -> mine.filter { it.item.id == item.id }.any { o -> o.screen.calls.none(::uncovered) } }
                CoverageRow(e.id, items.size, coveredItems, calls.count(::uncovered), calls.size)
            },
            marked,
            recommended,
            totals,
            scaffold,
            resistance(items, engines, obs),
            agreement(checks, items, engines, obs),
            engines.associate { e ->
                e.id to
                    obs.filter { it.engine == e.id && it.variant == "scaffold" && it.run == 1 }.associate { o ->
                        o.item.id to
                            o.screen.flags.filter { f -> f.verified && f.severity >= Severity.MEDIUM && o.item.labels.any { it.check == f.check } }
                                .map(::signature).distinct().sorted()
                    }
            },
            summaries =
                engines.mapNotNull { e ->
                    val mine = obs.filter { it.engine == e.id && it.variant == "scaffold" && "summary" in it.item.checks && !it.screen.calls.any(::uncovered) }
                    val views = mine.mapNotNull { it.screen.summary }
                    if (views.isEmpty()) {
                        null
                    } else {
                        val anchored = views.sumOf { it.items.size }
                        SummaryRow(e.id, "summary", anchored + views.sumOf { it.dropped }, Stats.wilson(anchored, anchored + views.sumOf { it.dropped }))
                    }
                },
        )
    }

    private fun row(check: String, e: ShootoutEngine, variant: String, cs: List<Cell>, obs: List<Obs>, opt: ShootoutOptions): CheckEngineRow {
        val pos = cs.filter { it.label.role == Role.POSITIVE }
        val neg = cs.filter { it.label.role == Role.NEGATIVE }
        val tp = pos.count { it.hit }
        val misplaced = pos.count { !it.hit && it.flagged }
        val fp = neg.count { it.flagged }
        val recall = Stats.wilson(tp, pos.size)
        val ffr = Stats.wilson(fp, neg.size)
        val precision = Stats.wilson(tp, tp + fp + misplaced)
        val ba =
            if (pos.isEmpty() || neg.isEmpty()) {
                Interval.NONE
            } else {
                val pv = pos.map { if (it.hit) 1.0 else 0.0 }
                val nv = neg.map { if (it.flagged) 0.0 else 1.0 }
                Stats.bootstrap(listOf(pos.size, neg.size)) { g -> (g[0].sumOf { pv[it] } / g[0].size + g[1].sumOf { nv[it] } / g[1].size) / 2 }
            }
        val covObs = cs.flatMap { it.covered }
        val calls = covObs.flatMap { o -> o.screen.calls.filter { it.check == check && it.run == "shown" } }
        val allFlags = covObs.flatMap { o -> o.screen.flags.filter { it.check == check } }
        val anchors = Stats.wilson(allFlags.count { it.verified }, allFlags.size)

        fun rate(s: Status) = Stats.wilson(calls.count { it.status == s && !uncovered(it) }, calls.size)
        // Stability: papers for which every one of the k runs was served.
        val full = cs.filter { it.covered.size == opt.k && opt.k > 1 }
        val sigs = full.map { c -> c.covered.map { o -> flagged(o.screen, check).map(::signature).toSet() } }
        val agree = full.indices.count { i -> sigs[i].distinct().size == 1 }
        val flaky = sigs.sumOf { runs -> runs.flatten().toSet().count { s -> runs.any { s !in it } } }
        val distinct = sigs.sumOf { runs -> runs.flatten().toSet().size }
        val passK = full.count { c -> c.covered.all { c.correctIn(it) } }
        // Cost and latency per paper per run, for this check only, from the calls that are shown (a rerun for injection.effect is not counted twice).
        val perRunCost =
            covObs.map { o ->
                o.screen.calls.filter { it.check == check && it.run == "shown" }.sumOf { it.costUsd.toDouble() + gpu(e, it.latencyMs) }
            }
        val perRunLat = covObs.map { o -> o.screen.calls.filter { it.check == check && it.run == "shown" }.sumOf { it.latencyMs.toDouble() } / 1000 }
        val cost = Stats.mean(perRunCost)
        val projected = if (cost.n == 0) Interval.NONE else Interval(cost.est * opt.scalePapers, cost.lo * opt.scalePapers, cost.hi * opt.scalePapers, cost.n)
        val lat = if (perRunLat.isEmpty()) 0.0 else perRunLat.average()
        val wall = lat * opt.scalePapers / e.config.concurrency / 3600
        val notes = mutableListOf<String>()
        if (variant == "scaffold" && ba.n > 0) {
            if (recall.est < opt.minRecall) notes += "recall below ${opt.minRecall}"
            if (ffr.est > opt.maxFalseFlagRate) notes += "false-flag rate above ${opt.maxFalseFlagRate}"
            if (allFlags.isNotEmpty() && anchors.est < opt.minAnchorValidity) notes += "anchor validity below ${opt.minAnchorValidity}"
            if (full.isNotEmpty() && agreement(full.size, agree).est < opt.minStability) notes += "stability below ${opt.minStability}"
            if (full.isEmpty()) notes += "stability not measured"
            if (recall.n > 0 &&
                recall.est >= opt.minRecall &&
                recall.lo < opt.minRecall
            ) {
                notes += "recall lower bound ${"%.2f".format(recall.lo)} under the threshold"
            }
        }
        val failing = notes.filter { !it.startsWith("stability not measured") && !it.contains("lower bound") }
        return CheckEngineRow(
            check,
            e.id,
            variant,
            pos.size,
            neg.size,
            recall,
            ffr,
            precision,
            ba,
            anchors,
            rate(Status.REFUSAL),
            rate(Status.SCHEMA_INVALID),
            rate(Status.TRUNCATED),
            rate(Status.ERROR),
            full.size,
            agreement(full.size, agree),
            Stats.wilson(passK, full.size),
            flaky,
            distinct,
            cost,
            projected,
            lat,
            wall,
            false,
            variant == "scaffold" && ba.n > 0 && failing.isEmpty(),
            notes.joinToString("; "),
        )
    }

    private fun agreement(n: Int, k: Int) = Stats.wilson(k, n)

    private fun gpu(e: ShootoutEngine, latencyMs: Long) = if (e.gpuUsdPerHour == 0.0) 0.0 else latencyMs / 3_600_000.0 * e.gpuUsdPerHour / e.config.concurrency

    private fun scaffoldDelta(check: String, engine: String, items: List<EvalItem>, obs: List<Obs>): Interval {
        // Paired over the papers both variants scored: balanced accuracy with scaffolding minus without.
        fun outcome(variant: String, item: EvalItem, label: Label): Boolean? {
            val os =
                obs.filter {
                    it.engine == engine &&
                        it.variant == variant &&
                        it.item.id == item.id &&
                        it.screen.calls.filter { c -> c.check == check }.none(::uncovered)
                }
            if (os.isEmpty()) return null
            val c = Cell(item, label, os)
            return if (label.role == Role.POSITIVE) c.hit else !c.flagged
        }
        val pairs =
            items.flatMap { item ->
                item.labels.filter { it.check == check }.map { l -> Triple(l.role, outcome("scaffold", item, l), outcome("raw-pdf", item, l)) }
            }
                .filter { it.second != null && it.third != null }
        val pos = pairs.filter { it.first == Role.POSITIVE }.map { (if (it.second!!) 1.0 else 0.0) - (if (it.third!!) 1.0 else 0.0) }
        val neg = pairs.filter { it.first == Role.NEGATIVE }.map { (if (it.second!!) 1.0 else 0.0) - (if (it.third!!) 1.0 else 0.0) }
        if (pos.isEmpty() || neg.isEmpty()) return Interval.NONE
        return Stats.bootstrap(listOf(pos.size, neg.size)) { g -> (g[0].sumOf { pos[it] } / g[0].size + g[1].sumOf { neg[it] } / g[1].size) / 2 }
    }

    /** Injection resistance (agent.md 7.3): how often a planted instruction changes a check's output, with the span left in and after it is stripped. */
    private fun resistance(items: List<EvalItem>, engines: List<ShootoutEngine>, obs: List<Obs>): List<ResistanceRow> {
        val out = mutableListOf<ResistanceRow>()

        fun sig(s: PaperScreen, check: String): Set<String> =
            if (check ==
                "summary"
            ) {
                s.summary?.items?.map { norm(it.anchor.quote).take(60) }.orEmpty().toSet()
            } else {
                flagged(s, check).map(::signature).toSet()
            }
        for (e in engines) {
            for (check in listOf("anonymity.llm", "scope", "refs.use", "summary")) {
                var pairs = 0
                var left = 0
                var strip = 0
                for (o in obs.filter { it.engine == e.id && it.variant == "scaffold" && it.item.injected && check in it.item.checks }) {
                    val twin = obs.firstOrNull { it.engine == e.id && it.variant == "scaffold" && it.item.id == o.item.twin && it.run == o.run } ?: continue
                    if (o.screen.calls.any(::uncovered) || twin.screen.calls.any(::uncovered)) continue
                    pairs++
                    if (o.screen.flags.any {
                            it.check == "injection.effect" &&
                                it.kind == "output-differs" &&
                                it.fields["measured.check"]?.startsWith("$check@") == true
                        }
                    ) {
                        left++
                    }
                    if (sig(o.screen, check) != sig(twin.screen, check)) strip++
                }
                if (pairs > 0) out += ResistanceRow(e.id, check, pairs, Stats.wilson(left, pairs), Stats.wilson(strip, pairs))
            }
        }
        return out
    }

    private fun agreement(checks: List<String>, items: List<EvalItem>, engines: List<ShootoutEngine>, obs: List<Obs>): List<AgreementRow> {
        val out = mutableListOf<AgreementRow>()
        for (c in checks) {
            fun verdicts(e: String): Map<String, Boolean> =
                items.filter { i -> i.labels.any { it.check == c } }.mapNotNull { i ->
                    val os =
                        obs.filter {
                            it.engine == e &&
                                it.variant == "scaffold" &&
                                it.item.id == i.id &&
                                it.screen.calls.filter { x -> x.check == c }.none(::uncovered)
                        }
                    if (os.isEmpty()) null else i.id to (os.count { flagged(it.screen, c).isNotEmpty() } * 2 >= os.size)
                }.toMap()
            val v = engines.associate { it.id to verdicts(it.id) }
            for (i in engines.indices) {
                for (j in i + 1 until engines.size) {
                    val a = v.getValue(engines[i].id)
                    val b = v.getValue(engines[j].id)
                    val common = a.keys.intersect(b.keys)
                    if (common.isNotEmpty()) {
                        out +=
                            AgreementRow(c, engines[i].id, engines[j].id, common.size, Stats.wilson(common.count { a[it] == b[it] }, common.size))
                    }
                }
            }
        }
        return out
    }

    // ---- rendering -------------------------------------------------------------------------

    fun markdown(r: ShootoutReport): String =
        buildString {
            fun usd(x: Double) = if (x < 0.1) "$%.4f".format(x) else "$%.2f".format(x)

            fun usd(i: Interval) = if (i.n == 0) "n/a" else "${usd(i.est)} [${usd(i.lo)}, ${usd(i.hi)}]"
            appendLine("# Shootout: corpus `${r.corpus}` (${r.items} papers, fingerprint ${r.fingerprint}), k = ${r.k}")
            appendLine()
            appendLine(
                "${r.corpusNote}. Intervals are 95 percent: Wilson for rates, a seeded bootstrap for balanced accuracy and costs. Projections are for ${r.scalePapers} papers (`PCS_AGENT_SCALE_PAPERS`).",
            )
            appendLine()
            appendLine("## Engines")
            appendLine()
            appendLine("| Engine | Adapter | Model | Real? | USD per M tokens in / out | GPU USD/h | Concurrency | Note |")
            appendLine("|---|---|---|---|---|---|---|---|")
            r.engines.forEach {
                appendLine(
                    "| `${it.id}` | ${it.adapter} | ${it.model} | ${if (it.standIn) "**scripted stand-in, not a model**" else "recorded results of a real model"} | ${it.inUsdPerMTok} / ${it.outUsdPerMTok} | ${it.gpuUsdPerHour} | ${it.concurrency} | ${it.note} |",
                )
            }
            appendLine()
            appendLine("Coverage (an engine with no recording for a request leaves that paper out of its numbers; it is never filled in):")
            appendLine()
            appendLine("| Engine | Papers served in at least one run | Calls | Calls with no recording |")
            appendLine("|---|---|---|---|")
            r.coverage.forEach { appendLine("| `${it.engine}` | ${it.coveredItems} / ${it.items} | ${it.calls} | ${it.uncoveredCalls} |") }
            val checks = r.rows.map { it.check }.distinct()
            for (c in checks) {
                appendLine()
                appendLine("## `$c`")
                appendLine()
                appendLine(
                    "| Engine | Recall | False-flag rate | Precision | Balanced accuracy | Anchors verify | Refusal / schema / truncated / error | Stability: agree (papers), pass^k, flaky flags | Cost per paper | At ${r.scalePapers} papers | Wall time | On frontier | Meets thresholds |",
                )
                appendLine("|---|---|---|---|---|---|---|---|---|---|---|---|---|")
                for (x in r.rows.filter { it.check == c && it.variant == "scaffold" }) {
                    val stab =
                        if (x.stabilityItems ==
                            0
                        ) {
                            "not measured"
                        } else {
                            "${x.agreement.fmt()} (${x.stabilityItems}), ${x.passK.fmt()}, ${x.flakyFlags}/${x.distinctFlags}"
                        }
                    appendLine(
                        "| `${x.engine}` | ${x.recall.fmt()} (${x.positives}) | ${x.falseFlagRate.fmt()} (${x.negatives}) | ${x.precision.fmt()} | ${x.balancedAccuracy.fmt()} | ${x.anchorValidity.fmt()} | " +
                            "${x.refusalRate.fmt()} / ${x.schemaInvalidRate.fmt()} / ${x.truncationRate.fmt()} / ${x.errorRate.fmt()} | $stab | ${usd(
                                x.costPerPaperUsd,
                            )} | ${usd(
                                x.projectedCostUsd,
                            )} | ${"%.1f".format(
                                x.projectedWallHours,
                            )} h | ${if (x.frontier) "yes" else "no"} | ${if (x.meetsThresholds) {
                                "yes"
                            } else {
                                "no: ${x.thresholdNote.ifEmpty {
                                    "no paper was served"
                                }}"
                            }} |",
                    )
                }
                val ordered = r.rows.filter { it.check == c && it.variant == "scaffold" && it.balancedAccuracy.n > 0 }.sortedBy { it.costPerPaperUsd.est }
                if (ordered.isNotEmpty()) {
                    appendLine()
                    appendLine("Frontier, cheapest to dearest (quality = balanced accuracy; `*` is on the frontier):")
                    appendLine()
                    appendLine("```")
                    ordered.forEach { x ->
                        appendLine(
                            "%-26s %-12s %s %.3f  %s".format(
                                x.engine,
                                usd(x.costPerPaperUsd.est),
                                if (x.frontier) "*" else " ",
                                x.balancedAccuracy.est,
                                "#".repeat(
                                    (
                                        x.balancedAccuracy.est *
                                            40
                                    ).toInt(),
                                ),
                            ),
                        )
                    }
                    appendLine("```")
                    val seps =
                        ordered.zipWithNext().filter { (a, b) ->
                            b.balancedAccuracy.separatedFrom(a.balancedAccuracy)
                        }.map { (a, b) -> "${a.engine} and ${b.engine}" }
                    appendLine()
                    appendLine(
                        "Quality differences outside the intervals: ${if (seps.isEmpty()) {
                            "none between neighbours on the cost axis"
                        } else {
                            seps.joinToString(
                                "; ",
                            )
                        }}.",
                    )
                }
                appendLine()
                appendLine("**Recommended engine:** ${r.recommended[c] ?: "n/a"}")
            }
            appendLine()
            appendLine("## Projected cost at ${r.scalePapers} papers, all labelled checks")
            appendLine()
            appendLine("| Engine | Projected cost |")
            appendLine("|---|---|")
            r.totals.forEach { (e, v) -> appendLine("| `$e` | ${usd(v)} |") }
            appendLine()
            appendLine(
                "Costs come from the usage and prices recorded for each call (for a replay, the cost the provider reported); per-paper means are over the runs and papers of the check alone. Interval ends are sums of per-check ends, so the total interval is wider than a joint one.",
            )
            appendLine()
            appendLine("## Scaffold delta")
            appendLine()
            if (r.scaffold.isEmpty()) {
                appendLine("No engine served both variants on this corpus.")
            } else {
                appendLine(
                    "Balanced accuracy with our preprocessing minus the same engine given the PDF whole and the same question (agent.md 7.3). Only checks whose input is plain paper text have a raw variant here.",
                )
                appendLine()
                appendLine("| Check | Engine | With scaffold | Raw PDF | Delta |")
                appendLine("|---|---|---|---|---|")
                r.scaffold.forEach { appendLine("| `${it.check}` | `${it.engine}` | ${it.scaffolded.fmt()} | ${it.raw.fmt()} | ${it.delta.fmt()} |") }
            }
            appendLine()
            appendLine("## Injection")
            appendLine()
            val det = r.rows.filter { it.check == "injection.addressed.llm" && it.variant == "scaffold" }
            if (det.isNotEmpty()) {
                appendLine(
                    "Detection, vector `visible-addressed` (the classifier on a span the pattern list found): planted instructions found, and benign quotations flagged.",
                )
                appendLine()
                appendLine("| Engine | Found | Benign controls flagged |")
                appendLine("|---|---|---|")
                det.forEach { appendLine("| `${it.engine}` | ${it.recall.fmt()} (${it.positives}) | ${it.falseFlagRate.fmt()} (${it.negatives}) |") }
                appendLine()
            }
            appendLine(
                "The hidden-text and channel vectors are found by the deterministic checks, which do not depend on the engine; their per-vector scores are in `mutation-score.md` (`:agent:screeningScore`).",
            )
            appendLine()
            if (r.resistance.isEmpty()) {
                appendLine("Resistance: no injected/clean pairs were served on this corpus.")
            } else {
                appendLine(
                    "Resistance: over injected papers and their clean twins, the share of runs in which the planted instruction changes the check's output when it is left in, and when it has been stripped (the second is what the defence leaves). A stripped paper can still differ from its twin through run-to-run noise alone, so read the second column against the engine's stability.",
                )
                appendLine()
                appendLine("| Engine | Check | Pair-runs | Changed, span left in | Changed, span stripped |")
                appendLine("|---|---|---|---|---|")
                r.resistance.forEach {
                    appendLine("| `${it.engine}` | `${it.check}` | ${it.pairs} | ${it.changedLeftIn.fmt()} | ${it.changedStripped.fmt()} |")
                }
            }
            if (r.summaries.isNotEmpty()) {
                appendLine()
                appendLine(
                    "`summary` has no labels; its qualification rule is anchor validity (the share of statements the harness could anchor) and the resistance rows above, with no human rating.",
                )
                appendLine()
                appendLine("| Engine | Statements | Anchor validity |")
                appendLine("|---|---|---|")
                r.summaries.forEach { appendLine("| `${it.engine}` | ${it.statements} | ${it.anchorValidity.fmt()} |") }
            }
            appendLine()
            appendLine("## Cross-engine agreement")
            appendLine()
            if (r.agreement.isEmpty()) {
                appendLine("No two engines covered the same papers.")
            } else {
                appendLine("| Check | Engines | Papers | Same verdict |")
                appendLine("|---|---|---|---|")
                r.agreement.forEach { appendLine("| `${it.check}` | `${it.a}` and `${it.b}` | ${it.items} | ${it.agreement.fmt()} |") }
            }
            val raw = r.rows.filter { it.variant == "raw-pdf" }
            if (raw.isNotEmpty()) {
                appendLine()
                appendLine("## Raw-PDF variant rows")
                appendLine()
                appendLine("| Check | Engine | Recall | False-flag rate | Balanced accuracy | Cost per paper |")
                appendLine("|---|---|---|---|---|---|")
                raw.forEach {
                    appendLine(
                        "| `${it.check}` | `${it.engine}` | ${it.recall.fmt()} | ${it.falseFlagRate.fmt()} | ${it.balancedAccuracy.fmt()} | ${usd(
                            it.costPerPaperUsd,
                        )} |",
                    )
                }
            }
        }

    fun write(r: ShootoutReport, dir: File) {
        dir.mkdirs()
        File(dir, "shootout-${r.corpus}.md").writeText(markdown(r))
        File(dir, "shootout-${r.corpus}.json").writeText(json.encodeToString(ShootoutReport.serializer(), r))
    }
}
