package net.jonbell.pcs.agent.llm

import kotlinx.serialization.json.JsonObject
import net.jonbell.pcs.agent.checks.Checks
import net.jonbell.pcs.agent.checks.Finding
import net.jonbell.pcs.agent.checks.InjectionAddressedCheck
import net.jonbell.pcs.agent.checks.ScreenContext
import net.jonbell.pcs.agent.checks.Severity
import net.jonbell.pcs.agent.engines.CallResult
import net.jonbell.pcs.agent.engines.DataClass
import net.jonbell.pcs.agent.engines.Dispatcher
import net.jonbell.pcs.agent.engines.PaperInput
import net.jonbell.pcs.agent.engines.Status
import net.jonbell.pcs.agent.extract.HeuristicReferenceParser
import net.jonbell.pcs.agent.extract.PdfExtractor
import net.jonbell.pcs.core.rules.Ground
import java.math.BigDecimal
import java.nio.file.Path

/** What was called for one unit: for the cost report and for tests that count calls. */
data class CallRecord(
    val check: String,
    val unit: String,
    /** `shown`, `with-span` (the baseline run of the injection.effect pair), or `hidden-probe`. */
    val run: String,
    val key: String,
    val status: Status,
    val cached: Boolean,
    val costUsd: BigDecimal,
    val servedModel: String,
)

/** The screen of one paper: every flag (verified or not), the summary view, and the calls made. */
class PaperScreen(val pid: String, val flags: List<Flag>, val summary: SummaryView?, val calls: List<CallRecord>, val suspects: List<Span>) {
    val shown: List<Flag> get() = flags.filter { it.verified }
}

class ScreenOptions(
    /** Rerun each LLM check without the suspect spans and compare (agent.md §5.2). */
    val effect: Boolean = true,
    /** Also run each check on text with hidden spans left in, to measure what stripping is worth. Synthetic data only. */
    val probeHidden: Boolean = false,
)

/** The machinery under every flag of the `injection.effect` check: its own check id and decisions. */
private const val EFFECT = "injection.effect"

/**
 * Screens one paper: the deterministic checks, then each LLM check through the [Dispatcher] (so the
 * clearance check and the store apply), with hidden spans stripped before any call, the monitors
 * on every call, and the with-and-without rerun when a suspect span exists. Every quotation is
 * located by the harness before a flag is stored as verified (agent.md §6).
 */
class Screener(
    private val dispatcher: Dispatcher,
    private val routing: Map<String, String>,
    private val checks: List<ScreenLlmCheck>,
    private val decisions: Decisions,
    private val env: CheckEnv = CheckEnv(),
    private val deterministicDeps: Map<String, List<String>> = emptyMap(),
    private val effectCheckVersion: String = Checks.version(EFFECT),
    private val options: ScreenOptions = ScreenOptions(),
) {
    private fun engineFor(c: ScreenLlmCheck) = routing[c.id] ?: error("no engine routed to check ${c.id} (PCS_CHECK_${c.id}_ENGINE)")

    private class Run(val unit: LlmUnit, val result: CallResult, val cached: Boolean)

    suspend fun screen(p: PaperInput): PaperScreen {
        if (options.probeHidden) require(p.dataClass == DataClass.SYNTHETIC) { "the hidden-text probe sends hidden text to an engine: synthetic papers only" }
        val x = PdfExtractor(HeuristicReferenceParser).extract(p.pdf)
        val ctx = ScreenContext(p.pdf, x, p.config)
        try {
            return screen(p, ctx)
        } finally {
            ctx.close()
        }
    }

    private suspend fun screen(p: PaperInput, ctx: ScreenContext): PaperScreen {
        val x = ctx.x
        val findings = Checks.all().flatMap { it.run(ctx) }
        val flags = findings.map { Flags.fromFinding(p.id, it, x, deterministicDeps[it.check].orEmpty()) }.toMutableList()
        val calls = mutableListOf<CallRecord>()
        val view = PaperView(ctx)
        // A suspect span is cut out with its whole sentence, so the rest of an instruction does not stay behind.
        val visibleSuspects =
            findings.filter { it.check == InjectionAddressedCheck.id }.mapNotNull(::spanOf).map { sp ->
                val t = x.page(sp.page).text
                Span(sp.page, Citations.sentenceStart(t, sp.start, 0), Citations.sentenceEnd(t, sp.end, t.length))
            }.distinct()
        val rerun = options.effect && visibleSuspects.isNotEmpty()
        val without = if (rerun) view.without(visibleSuspects) else view
        var summary: SummaryView? = null
        val seenHits = mutableSetOf<String>()

        for (c in checks) {
            val engine = engineFor(c)

            suspend fun runAll(v: PaperView, run: String): List<Run> =
                c.units(v, env).map { u ->
                    val d = dispatcher.call(engine, c.request(u, p.dataClass, decisions), p.id)
                    calls +=
                        CallRecord(
                            c.id,
                            u.label,
                            run,
                            d.result.key,
                            d.result.status,
                            d.cached,
                            if (d.cached) BigDecimal.ZERO else d.result.costUsd,
                            d.result.servedModel,
                        )
                    Run(u, d.result, d.cached)
                }

            // The run that is shown. When a suspect span exists it is the run without it (agent.md §3.2).
            val shown = runAll(if (c.readsPaper) without else view, "shown")

            fun monitor(rs: List<Run>, run: String) {
                for (r in rs) {
                    for (h in Monitors.inspect(c, r.result)) {
                        if (seenHits.add("${c.id}|${h.kind}|${r.unit.label}|$run")) flags += monitorFlag(p, c, r, h, engine)
                    }
                }
            }
            for (r in shown) {
                monitor(listOf(r), "shown")
                val out = r.result.output as? JsonObject
                if (r.result.status != Status.OK || out == null) continue
                val interp = c.interpret(r.unit, out, if (c.readsPaper) without else view)
                var failed = 0
                for (cand in interp.candidates) {
                    val f = anchored(p, c, cand, without, engine, r.result.key)
                    if (!f.verified) failed++
                    flags += f
                }
                interp.summary?.let { draft ->
                    val items = mutableListOf<SummaryItem>()
                    for (d in draft) {
                        val a = anchorOf(d.quote, without)
                        if (a == null) failed++ else items += SummaryItem(d.section, d.text, a)
                    }
                    summary = SummaryView(c.id, c.version, engine, r.result.key, items, draft.size - items.size)
                }
                if (failed > 0 && seenHits.add("${c.id}|unverified-quotation|${r.unit.label}|shown")) {
                    flags += monitorFlag(p, c, r, MonitorHit("unverified-quotation", Severity.LOW, "$failed quotation(s) not found in the paper"), engine)
                }
            }

            val baseline =
                if (c.readsPaper && rerun) {
                    runAll(view, "with-span").also { monitor(it, "with-span") }.also {
                        compare(p, c, engine, it, shown, visibleSuspects, x, "with the suspect span left in")?.let { f ->
                            flags +=
                                f
                        }
                    }
                } else {
                    shown
                }
            if (c.readsPaper && options.probeHidden && ctx.hidden.spans.any { it.channel == null }) {
                val probe = runAll(PaperView(ctx, stripHidden = false), "hidden-probe").also { monitor(it, "hidden-probe") }
                val hiddenSpans = ctx.hidden.spans.filter { it.channel == null }.map { Span(it.page, it.start, it.end) }
                compare(p, c, engine, probe, baseline, hiddenSpans, x, "with hidden text left in")?.let { flags += it }
            }
        }
        return PaperScreen(p.id, flags, summary, calls, visibleSuspects)
    }

    private fun spanOf(f: Finding): Span? = f.anchor.page?.let { pg -> f.anchor.start?.let { s -> f.anchor.end?.let { e -> Span(pg, s, e) } } }

    private fun anchorOf(q: Quote, view: PaperView): FlagAnchor? =
        when (val s = q.source) {
            QuoteSource.Paper -> Anchoring.locatePage(view, q.text, q.hintPage, q.label)
            is QuoteSource.Abstract -> Anchoring.locateAbstract(s.abstract, q.text, s.ref, q.label)
        }

    private fun anchored(p: PaperInput, c: ScreenLlmCheck, cand: Candidate, view: PaperView, engine: String, key: String): Flag {
        val found = cand.quotes.map { it to anchorOf(it, view) }
        val problems =
            found.filter {
                it.second == null
            }.map { "quotation not found in ${if (it.first.source is QuoteSource.Abstract) "the abstract" else "the paper"}: ${it.first.label}" }
        val anchors = cand.anchored + found.mapNotNull { it.second }
        val ok = problems.isEmpty() && anchors.isNotEmpty()
        return Flag(
            p.id,
            c.id,
            c.version,
            c.dependsOn,
            cand.kind,
            cand.ground?.key,
            cand.severity,
            anchors,
            cand.fields,
            engine,
            key,
            if (ok) FlagStatus.VERIFIED else FlagStatus.UNVERIFIED,
            if (ok || problems.isNotEmpty()) problems else listOf("no anchor"),
        )
    }

    private fun monitorFlag(p: PaperInput, c: ScreenLlmCheck, r: Run, h: MonitorHit, engine: String) =
        Flag(
            p.id,
            EFFECT,
            effectCheckVersion,
            listOf("injection.policy"),
            h.kind,
            null,
            h.severity,
            emptyList(),
            mapOf("message" to "Monitor on a call of ${c.id}: ${h.kind}", "measured.check" to "${c.id}@${c.version}", "measured.detail" to h.detail),
            engine,
            r.result.key,
            FlagStatus.VERIFIED,
        )

    /** Compares the signature of a run that carried suspect text with the shown run, and reports both when they differ materially. */
    private fun compare(
        p: PaperInput,
        c: ScreenLlmCheck,
        engine: String,
        other: List<Run>,
        shown: List<Run>,
        spans: List<Span>,
        x: net.jonbell.pcs.agent.extract.Extraction,
        what: String,
    ): Flag? {
        fun sig(rs: List<Run>): Set<String>? =
            rs.takeIf {
                it.isNotEmpty() &&
                    it.all { r ->
                        r.result.status == Status.OK
                    }
            }?.flatMap { r -> c.signature(r.unit, r.result.output as JsonObject) }?.toSet()
        val a = sig(other) ?: return null
        val b = sig(shown) ?: return null
        val union = (a + b).size
        val distance = if (union == 0) 0.0 else 1.0 - (a intersect b).size.toDouble() / union
        if (distance <= c.materialThreshold) return null
        val anchors =
            spans.take(3).mapNotNull { s ->
                val t = x.page(s.page).text
                if (s.end > t.length ||
                    s.start >= s.end
                ) {
                    null
                } else {
                    FlagAnchor(FlagAnchor.SOURCE_PAGE, s.start, s.end, t.substring(s.start, s.end), page = s.page, label = "suspect span")
                }
            }
        return Flag(
            p.id,
            EFFECT,
            effectCheckVersion,
            listOf("injection.policy"),
            "output-differs",
            Ground.PROMPT_INJECTION.key,
            Severity.HIGH,
            anchors,
            mapOf(
                "message" to "The output of ${c.id} changes when the suspect span is removed ($what versus without it); the output without it is the one shown",
                "measured.check" to "${c.id}@${c.version}",
                "measured.distance" to "%.2f".format(distance),
                "shown.output $what" to a.sorted().joinToString("; ").ifEmpty { "(nothing)" },
                "shown.output without the span" to b.sorted().joinToString("; ").ifEmpty { "(nothing)" },
            ),
            engine,
            shown.firstOrNull()?.result?.key.orEmpty(),
            if (anchors.isNotEmpty()) FlagStatus.VERIFIED else FlagStatus.UNVERIFIED,
            if (anchors.isNotEmpty()) emptyList() else listOf("no anchor"),
        )
    }

    companion object {
        /** The checks of a directory tree, in catalog order, with their code root (the `agent` module directory). */
        fun checks(checksDir: Path): List<ScreenLlmCheck> {
            val code = checksDir.parent
            return listOf(
                AnonymityLlmCheck(checksDir.resolve("anonymity.llm"), code),
                ScopeCheck(checksDir.resolve("scope"), code),
                RefsUseCheck(checksDir.resolve("refs.use"), code),
                SummaryCheck(checksDir.resolve("summary"), code),
                AddressedLlmCheck(checksDir.resolve("injection.addressed.llm"), code),
            )
        }

        /** The decisions each deterministic check cites, from its `check.yaml`. */
        fun deterministicDeps(checksDir: Path): Map<String, List<String>> =
            CheckSpec.readAll(checksDir).filter { it.category == "deterministic" }.associate { it.id to it.dependsOn }
    }
}
