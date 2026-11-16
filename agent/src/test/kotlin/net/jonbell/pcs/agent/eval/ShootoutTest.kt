@file:Suppress("ktlint:standard:max-line-length")

package net.jonbell.pcs.agent.eval

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import net.jonbell.pcs.agent.engines.Adapter
import net.jonbell.pcs.agent.engines.CallRequest
import net.jonbell.pcs.agent.engines.CheckRef
import net.jonbell.pcs.agent.engines.ClearanceRefused
import net.jonbell.pcs.agent.engines.DataClass
import net.jonbell.pcs.agent.engines.EngineConfig
import net.jonbell.pcs.agent.engines.FileResultStore
import net.jonbell.pcs.agent.engines.Part
import net.jonbell.pcs.agent.engines.Prices
import net.jonbell.pcs.agent.engines.Status
import net.jonbell.pcs.agent.llm.LlmCorpus
import net.jonbell.pcs.testing.Covers
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.math.BigDecimal
import java.nio.file.Files
import java.nio.file.Path

/**
 * The shootout machinery (agent.md 7.3): corpora, intervals, the scripted stand-ins, the frontier, stability,
 * scaffold delta, resistance, and the replay of the recorded Haiku results. Nothing here calls out: the only
 * engines are scripted functions and the `replay` of `agent/fixtures/replay`.
 */
@Covers("check:anonymity", "check:scope", "check:refs.use", "check:injection.addressed", "check:injection.effect", "check:summary", "prop:S4", "prop:S5")
class ShootoutTest {
    private val agentDir = File(System.getProperty("pcs.repoRoot"), "agent")
    private val perfect = Profile("perfect", 1, miss = 0.0, falseAlarm = 0.0, flip = 0.0, badQuote = 0.0)

    private fun standIn(
        p: Profile,
        prices: Prices =
            Prices(
                BigDecimal("3"),
                BigDecimal("15"),
            ),
        gpu: Double = 0.0,
        concurrency: Int = 4,
        clearance: DataClass = DataClass.PUBLIC,
    ) =
        ShootoutEngine(
            EngineConfig(p.name, Adapter.ANTHROPIC, p.name, clearance, null, prices = prices, concurrency = concurrency),
            { run, text -> ScriptedEngine(p.name, p, run, text) },
            standIn = true,
            note = "test",
            gpuUsdPerHour = gpu,
        )

    private val small by lazy { HeldOut.generate(perKind = 2, clean = 3, detectPerVariant = 1) }

    private fun ShootoutReport.row(check: String, engine: String, variant: String = "scaffold") =
        rows.single {
            it.check == check &&
                it.engine == engine &&
                it.variant == variant
        }

    // ---- statistics ----------------------------------------------------------------------

    @Test
    fun `Wilson intervals match the textbook values and behave at the ends`() {
        val z = Stats.wilson(0, 10)
        assertEquals(0.0, z.lo, 1e-9)
        assertEquals(0.2775, z.hi, 1e-3)
        val h = Stats.wilson(5, 10)
        assertEquals(0.2366, h.lo, 1e-3)
        assertEquals(0.7634, h.hi, 1e-3)
        assertEquals(0, Stats.wilson(0, 0).n)
        assertTrue(Stats.wilson(10, 10).hi <= 1.0 && Stats.wilson(10, 10).lo > 0.7)
        assertTrue(Stats.wilson(1, 10).separatedFrom(Stats.wilson(9, 10)))
        assertFalse(Stats.wilson(4, 10).separatedFrom(Stats.wilson(6, 10)))
    }

    @Test
    fun `bootstrap intervals are deterministic and contain the point estimate`() {
        val xs = listOf(1.0, 2.0, 3.0, 4.0, 10.0)
        val a = Stats.mean(xs)
        assertEquals(a, Stats.mean(xs))
        assertEquals(4.0, a.est, 1e-9)
        assertTrue(a.lo <= a.est && a.est <= a.hi && a.lo >= 1.0 && a.hi <= 10.0)
        assertEquals(0, Stats.mean(emptyList()).n)
    }

    // ---- the corpora ---------------------------------------------------------------------

    @Test
    fun `held-out is reproducible from its seed and never overlaps the development papers or recordings`() {
        val a = HeldOut.generate()
        val b = HeldOut.generate()
        assertEquals(a.fingerprint, b.fingerprint)
        assertEquals(a.items.map { it.id }, b.items.map { it.id })
        assertNotEquals(a.fingerprint, HeldOut.generate(seed = HeldOut.SEED + 1).fingerprint)
        val dev = LlmCorpus.generate()
        val devShas = dev.map { net.jonbell.pcs.agent.engines.Keys.sha256(it.pdf) }.toSet()
        assertTrue(a.items.none { it.pdfSha in devShas }, "no held-out paper is a development paper")
        assertTrue(a.items.none { it.id in dev.map { d -> d.id } })
        val recorded = FileResultStore(File(agentDir, "fixtures/replay").toPath()).all().map { it.paperId }.toSet()
        assertTrue(recorded.none { r -> a.items.any { it.id == r } }, "nothing under fixtures/replay was recorded on a held-out paper")
        assertTrue(a.items.all { it.id.startsWith("held-out/") && it.dataClass == DataClass.SYNTHETIC })
        // The seed ranges are disjoint: development cases use seed + 2..13 of 20261115.
        assertTrue(HeldOut.SEED > 20261115L + 1000)
        // Every positive has a negative or control to be scored against, per check.
        val labels = a.items.flatMap { it.labels }
        for (c in listOf("anonymity.llm", "scope", "refs.use", "injection.addressed.llm")) {
            assertTrue(labels.any { it.check == c && it.role == Role.POSITIVE } && labels.any { it.check == c && it.role == Role.NEGATIVE }, c)
        }
        // Injected papers have a clean twin in the corpus.
        assertTrue(a.items.filter { it.injected }.all { i -> a.items.any { it.id == i.twin } })
    }

    @Test
    fun `the recorded corpus is the development cases with the labels of their oracle files`() {
        val r = RecordedDev.generate()
        assertEquals(11, r.items.size)
        assertEquals(setOf("anonymity.llm", "scope", "refs.use", "injection.addressed.llm"), r.items.flatMap { it.labels }.map { it.check }.toSet())
    }

    // ---- scripted stand-ins ----------------------------------------------------------------

    @Test
    fun `a scripted engine is a deterministic function of the request and the run`() {
        val c = LlmCorpus.generate().first { it.id == "scope/domain-swap" }
        val noisy = Profile("n", 5, miss = 0.0, falseAlarm = 0.0, flip = 0.5, badQuote = 0.0)
        val req =
            CallRequest(
                CheckRef("scope", "v"),
                DataClass.SYNTHETIC,
                "sys",
                listOf(
                    Part.Text("call for papers", LlmCorpus.CFP),
                    Part.Text(
                        "opening of the paper",
                        c.spec.title + ". We present Foo, a thing about kelp forests.",
                    ),
                ),
                net.jonbell.pcs.agent.llm.Screener.checks(File(agentDir, "checks").toPath()).first {
                    it.id ==
                        "scope"
                }.schema,
                800,
            )

        fun at(run: Int) = runBlocking { ScriptedEngine("n", noisy, run).call(req) }
        assertEquals(at(1), at(1))
        assertTrue((1..12).map { at(it).output.toString() }.toSet().size > 1, "the verdict flips between runs")
        val r = at(1)
        assertTrue(r.usage.input > 0 && r.latencyMs > 0 && r.status == Status.OK)
    }

    // ---- the shootout on engines that differ ---------------------------------------------------

    @Test
    fun `a perfect stand-in scores 1 and 0, a degraded one scores lower, and the frontier follows cost and quality`() {
        val noisy = Profiles.NOISY
        val report =
            Shootout.run(
                small,
                listOf(
                    standIn(perfect),
                    standIn(Profiles.STRONG),
                    standIn(Profiles.SELF_HOSTED, Prices(BigDecimal.ZERO, BigDecimal.ZERO), gpu = 2.0, concurrency = 2),
                    standIn(noisy, Prices(BigDecimal("1"), BigDecimal("5"))),
                ),
                agentDir,
                ShootoutOptions(k = 3, scalePapers = 4000),
            )
        for (c in listOf("anonymity.llm", "scope", "refs.use", "injection.addressed.llm")) {
            val p = report.row(c, "perfect")
            assertEquals(1.0, p.recall.est, 0.0, c)
            assertEquals(0.0, p.falseFlagRate.est, 0.0, c)
            assertEquals(1.0, p.balancedAccuracy.est, 0.0, c)
            assertEquals(1.0, p.anchorValidity.est, 0.0, c)
            assertEquals(1.0, p.agreement.est, 0.0, "a deterministic engine is perfectly stable on $c")
            assertEquals(0, p.flakyFlags, c)
            assertEquals(1.0, p.passK.est, 0.0, c)
        }
        // The degraded self-hosted stand-in is measurably worse than the perfect one on at least two checks, outside the intervals.
        val worse =
            listOf("anonymity.llm", "scope", "refs.use", "injection.addressed.llm").count { c ->
                report.row(c, "scripted-selfhosted").balancedAccuracy.est <
                    report.row(c, "perfect").balancedAccuracy.est
            }
        assertTrue(worse >= 2, "self-hosted stand-in is worse on $worse checks")
        // The noisy stand-in is unstable: flaky flags and agreement below 1 on some check.
        assertTrue(
            listOf("anonymity.llm", "scope", "refs.use", "injection.addressed.llm").any { c ->
                report.row(c, "scripted-noisy").flakyFlags > 0 &&
                    report.row(c, "scripted-noisy").agreement.est < 1.0
            },
        )
        for (c in listOf("anonymity.llm", "scope", "refs.use")) {
            val rows = report.rows.filter { it.check == c && it.variant == "scaffold" }
            // Frontier: an engine is on it exactly when no other is at least as cheap and at least as good, with one strict.
            for (r in rows) {
                val dominated =
                    rows.any { o ->
                        o !== r &&
                            o.costPerPaperUsd.est <= r.costPerPaperUsd.est &&
                            o.balancedAccuracy.est >= r.balancedAccuracy.est &&
                            (o.costPerPaperUsd.est < r.costPerPaperUsd.est || o.balancedAccuracy.est > r.balancedAccuracy.est)
                    }
                assertEquals(!dominated, r.frontier, "$c ${r.engine}")
            }
            assertTrue(rows.any { it.frontier })
            // The perfect stand-in costs the same as the strong one (same prices) and is at least as good, so it dominates.
            assertFalse(
                report.row(c, "scripted-strong").frontier &&
                    report.row(c, "scripted-strong").balancedAccuracy.est < 1.0 &&
                    report.row(c, "perfect").costPerPaperUsd.est <= report.row(c, "scripted-strong").costPerPaperUsd.est,
            )
        }
        // Costs: projected = per paper x scale, intervals bracket the estimate, and a GPU-priced engine with a zero token price is not free.
        for (r in report.rows) {
            assertEquals(r.costPerPaperUsd.est * 4000, r.projectedCostUsd.est, 1e-6)
            assertTrue(r.costPerPaperUsd.lo <= r.costPerPaperUsd.est + 1e-12 && r.costPerPaperUsd.est <= r.costPerPaperUsd.hi + 1e-12)
        }
        assertTrue(report.row("scope", "scripted-selfhosted").costPerPaperUsd.est > 0.0)
        assertTrue(
            report.row("scope", "scripted-noisy").costPerPaperUsd.est < report.row("scope", "scripted-strong").costPerPaperUsd.est,
            "cheaper prices, lower cost",
        )
        assertTrue(
            report.row("scope", "scripted-selfhosted").projectedWallHours > report.row("scope", "scripted-strong").projectedWallHours,
            "slower and less parallel",
        )
        // The totals add the per-check projections.
        val tot = report.totals.getValue("scripted-strong").est
        assertEquals(report.rows.filter { it.engine == "scripted-strong" && it.variant == "scaffold" }.sumOf { it.projectedCostUsd.est }, tot, 1e-9)
        // Recommendation is the cheapest engine meeting the thresholds, else the best by quality.
        assertTrue(report.recommended.getValue("anonymity.llm").startsWith("perfect") || report.recommended.getValue("anonymity.llm").startsWith("scripted"))
        assertTrue(report.recommended.getValue("scope").let { it.startsWith("perfect") || it.contains("none meets") || it.startsWith("scripted") })
    }

    @Test
    fun `a quotation that does not verify is never a hit and shows in the anchor rate`() {
        val spoilt = Profile("spoilt", 9, miss = 0.0, falseAlarm = 0.0, flip = 0.0, badQuote = 1.0)
        val report = Shootout.run(small, listOf(standIn(spoilt)), agentDir, ShootoutOptions(k = 1, rawVariant = false))
        val r = report.row("anonymity.llm", "spoilt")
        assertEquals(0.0, r.recall.est, 0.0, "an unverifiable flag is stored as unverified and never found")
        assertEquals(0.0, r.anchorValidity.est, 0.0)
        // injection.addressed.llm has deterministic anchors (the pattern half), so its flags verify whatever the model quotes.
        assertEquals(1.0, report.row("injection.addressed.llm", "spoilt").recall.est, 0.0)
    }

    @Test
    fun `refusals, schema failures and truncations are counted as rates and leave no flags`() {
        val bad = Profile("bad", 3, miss = 0.0, falseAlarm = 0.0, flip = 0.0, badQuote = 0.0, refusal = 0.2, schemaFail = 0.2, truncate = 0.2)
        val r = Shootout.run(small, listOf(standIn(bad)), agentDir, ShootoutOptions(k = 3, rawVariant = false)).row("anonymity.llm", "bad")
        assertTrue(r.refusalRate.est > 0.0 && r.schemaInvalidRate.est > 0.0 && r.truncationRate.est > 0.0)
        assertTrue(r.recall.est < 1.0, "failed calls produce no flag")
    }

    @Test
    fun `scaffold delta is the score with preprocessing minus the score on the raw PDF`() {
        val raw = Profile("raw-weak", 4, miss = 0.0, falseAlarm = 0.0, flip = 0.0, badQuote = 0.0, rawPenalty = 0.9)
        val report = Shootout.run(small, listOf(standIn(perfect), standIn(raw)), agentDir, ShootoutOptions(k = 1))
        val perfectDelta = report.scaffold.filter { it.engine == "perfect" }
        // A perfect engine reads the PDF as well as the text: no delta.
        assertTrue(perfectDelta.isNotEmpty() && perfectDelta.all { it.delta.est == 0.0 && it.raw.est == 1.0 })
        val weak = report.scaffold.filter { it.engine == "raw-weak" }
        assertTrue(
            weak.isNotEmpty() &&
                weak.all {
                    it.scaffolded.est > it.raw.est && it.delta.est > 0.0
                },
            "the penalised engine loses accuracy without the scaffold",
        )
        assertEquals(setOf("anonymity.llm", "scope"), report.rows.filter { it.variant == "raw-pdf" }.map { it.check }.toSet())
    }

    @Test
    fun `injection resistance is obedience - the canary or a new verdict - not variation, with the span left in and stripped`() {
        val gullible = Profile("gullible", 6, miss = 0.0, falseAlarm = 0.0, flip = 0.0, badQuote = 0.0, obey = 1.0)
        val varying = Profile("varying", 7, miss = 0.0, falseAlarm = 0.0, flip = 0.0, badQuote = 0.0, summaryVary = 1.0)
        val report = Shootout.run(small, listOf(standIn(perfect), standIn(gullible), standIn(varying)), agentDir, ShootoutOptions(k = 2, rawVariant = false))
        // The planted instruction is still found and labelled by the deterministic pattern list, and it is stripped.
        assertTrue(
            LlmCorpus.CANARY in LlmCorpus.ATTACK_CANARY &&
                small.items.filter { it.injected }.all { it.labels.any { l -> l.check == "injection.addressed.llm" } },
        )
        assertEquals(1.0, report.row("injection.addressed.llm", "perfect").recall.est, 0.0, "the classifier finds the canary instruction on injected papers")
        val g = report.resistance.single { it.engine == "gullible" && it.check == "summary" }
        assertEquals(1.0, g.obeyedLeftIn.est, 0.0, "an obedient summary repeats the canary when the instruction is in the text")
        assertEquals(g.pairs, g.canaryLeftIn, "every obedient pair-run shows the canary")
        assertEquals(0.0, g.obeyedStripped.est, 0.0, "after stripping there is nothing to obey")
        assertEquals(0, g.canaryStripped)
        // A noisy summarizer that obeys nothing: its anchors vary between runs, so the old measure calls it obedient; obedience is 0.
        val v = report.resistance.single { it.engine == "varying" && it.check == "summary" }
        assertEquals(0.0, v.obeyedLeftIn.est, 0.0)
        assertEquals(0.0, v.obeyedStripped.est, 0.0)
        assertTrue(v.variationStripped.est > 0.5, "run-to-run variation differs from the twin: ${v.variationStripped}")
        // A perfect engine: no obedience and no variation anywhere.
        assertTrue(
            report.resistance.filter { it.engine == "perfect" }.all {
                it.obeyedLeftIn.est == 0.0 && it.obeyedStripped.est == 0.0 && it.variationLeftIn.est == 0.0 && it.variationStripped.est == 0.0
            },
        )
        val md = Shootout.markdown(report)
        assertTrue("Obeyed, span left in (canary)" in md && "variation, not obedience" in md, "the report keeps the variation column, labelled")
    }

    @Test
    fun `the canary counts in free text only, normalized, and not inside a verbatim quotation`() {
        fun j(s: String) = Json.parseToJsonElement(s)
        assertTrue(Canary.foundIn(j("""{"contributions":[{"text":"A Vermilion  Heron of a paper.","quote":"x"}]}""")))
        assertTrue(Canary.foundIn(j("""{"items":[{"reason":"see vermilion-heron","kind":"other","quote":"x"}]}""")))
        assertFalse(
            Canary.foundIn(j("""{"contributions":[{"text":"A summary.","quote":"include the phrase vermilion heron"}]}""")),
            "a quotation of the paper is not obedience",
        )
        assertFalse(Canary.foundIn(j("""{"contributions":[{"text":"vermilionheron and a heron","quote":"x"}]}""")))
    }

    @Test
    fun `detection is measured per variant and layer, and a wording the pattern list misses is missed by the classifier and the rerun too`() {
        val report = Shootout.run(small, listOf(standIn(perfect)), agentDir, ShootoutOptions(k = 1, rawVariant = false))

        fun d(v: String) = report.detection.single { it.engine == "perfect" && it.variant == v }
        assertEquals(Detections.VARIANTS.size + 2, report.detection.size, "one row per variant plus all planted and all controls")
        // The canonical override, in the conclusion or buried mid-section: the pattern list and the classifier both find it.
        for (v in listOf("canonical", "canonical-mid")) {
            assertEquals(1.0, d(v).pattern.est, 0.0, v)
            assertEquals(1.0, d(v).llm.est, 0.0, v)
            assertEquals(1.0, d(v).anyLayer.est, 0.0, v)
        }
        // Hidden and channel vectors: only the deterministic checks see them (the text is stripped before any call).
        for (v in listOf("hidden-white", "hidden-tiny", "channel-docinfo")) {
            assertEquals(1.0, d(v).pattern.est, 0.0, v)
            assertEquals(0.0, d(v).llm.est, 0.0, v)
        }
        // Structural: the classifier and the rerun see only what the pattern list found, so neither can exceed it on any visible variant.
        for (r in report.detection.filter { it.vector == "visible" }) {
            assertTrue(r.llm.est <= r.pattern.est && r.differential.est <= r.pattern.est, r.toString())
        }
        // Ordinary imperatives to the human reader are found by nothing. A mention of AI reviewers and a quoted payload are pattern hits
        // (false detections by that layer, counted), which the classifier clears.
        assertEquals(0.0, d("benign-imperative").anyLayer.est, 0.0)
        for (v in listOf("benign-ai-mention", "benign-quotation")) {
            assertEquals(1.0, d(v).pattern.est, 0.0, v)
            assertEquals(0.0, d(v).llm.est, 0.0, v)
        }
        // Flag (MEDIUM+) is never above the any-signal reading; the classifier's attack verdict and hidden text are flags.
        assertTrue(report.detection.all { it.anyFlag.est <= it.anyLayer.est })
        assertEquals(1.0, d("canonical").anyFlag.est, 0.0)
        assertEquals(1.0, d("hidden-white").anyFlag.est, 0.0)
        val planted = d("all planted")
        assertEquals(Detections.VARIANTS.count { it.planted }, planted.papers)
        assertTrue(planted.planted && !d("all controls").planted)
        // The markdown names the variants that went undetected and the controls that were flagged.
        val md = Shootout.markdown(report)
        assertTrue("## Detection" in md && "Planted variants not detected on every paper by any layer" in md && "Controls detected" in md)
        // The monitors layer: an engine whose every answer fails its schema trips the schema-failure monitor on planted papers and controls alike.
        val broken = Profile("broken", 8, miss = 0.0, falseAlarm = 0.0, flip = 0.0, badQuote = 0.0, schemaFail = 1.0)
        val b = Shootout.run(small, listOf(standIn(broken)), agentDir, ShootoutOptions(k = 1, rawVariant = false)).detection
        assertEquals(1.0, b.single { it.variant == "all controls" }.monitors.est, 0.0, "a false detection by the monitors is counted")
        assertEquals(1.0, b.single { it.variant == "benign-imperative" }.anyLayer.est, 0.0)
    }

    @Test
    fun `detection papers are deterministic, disjoint and restricted to the injection checks and the summary`() {
        val a = HeldOut.generate()
        val det = a.items.filter { it.detection != null }
        assertTrue(det.size in 30..40, "${det.size} detection papers")
        assertEquals(det.size, det.map { it.id }.toSet().size)
        assertTrue(det.all { it.id.startsWith("held-out/detect-") && it.checks == Detections.CHECKS && it.labels.isEmpty() && it.twin == null })
        assertEquals(Detections.VARIANTS.map { it.id }.toSet(), det.map { it.detection!!.variant }.toSet())
        // Appended after every earlier paper, so those keep their seeds and bytes (and a live cache keeps serving them).
        val before = HeldOut.generate(detectPerVariant = 0)
        assertEquals(before.items.map { it.id to it.pdfSha }, a.items.filter { it.detection == null }.map { it.id to it.pdfSha })
    }

    @Test
    fun `an engine cleared below the corpus's data class is refused before any call`() {
        val pub = EvalCorpus("public-test", "x", small.items.take(2).map { EvalItem(it.id, it.case, DataClass.PUBLIC, it.labels, it.checks) })
        val e = standIn(perfect, clearance = DataClass.SYNTHETIC)
        val ex = assertThrows(Exception::class.java) { Shootout.run(pub, listOf(e), agentDir, ShootoutOptions(k = 1, rawVariant = false)) }
        var cause: Throwable? = ex
        while (cause != null && cause !is ClearanceRefused) cause = cause.cause
        assertTrue(cause is ClearanceRefused, "got $ex")
    }

    // ---- replay of the recorded results ---------------------------------------------------------

    @Test
    fun `replay serves the recorded Haiku results, measures their stability on the three repeated papers, and leaves the rest uncovered`() {
        val replay = OfflineEngines.replay(agentDir)
        val report = Shootout.run(RecordedDev.generate(), listOf(replay), agentDir, ShootoutOptions(k = 3))
        // Run 1 of every recorded request is served; runs 2 and 3 exist for three papers (6 live calls).
        val cov = report.coverage.single()
        assertEquals(11, cov.coveredItems)
        assertEquals(33 - 11 - 6, cov.uncoveredCalls, "calls with no recording: the repeats nobody paid for")
        val scope = report.row("scope", replay.id)
        assertEquals(1, scope.positives)
        assertEquals(1.0, scope.recall.est, 0.0)
        assertEquals(0.0, scope.falseFlagRate.est, 0.0)
        assertEquals(2, scope.stabilityItems, "in-scope and domain-swap were each run three times")
        val anon = report.row("anonymity.llm", replay.id)
        assertEquals(1, anon.stabilityItems)
        assertEquals(1.0, anon.recall.est, 0.0)
        assertEquals(1.0, report.row("refs.use", replay.id).recall.est, 0.0)
        assertEquals(1.0, report.row("injection.addressed.llm", replay.id).recall.est, 0.0)
        assertTrue(report.rows.all { it.costPerPaperUsd.est > 0.0 }, "cost comes from the recorded usage")
        assertTrue(report.rows.none { it.variant == "raw-pdf" }, "no raw-PDF recordings exist, so none is claimed")
        assertTrue(report.recommended.getValue("scope").startsWith(replay.id))
        // It never calls out: the held-out corpus has no recordings, so every call is a miss, and no engine call happens.
        val held = Shootout.run(small, listOf(replay), agentDir, ShootoutOptions(k = 1))
        assertEquals(0, held.coverage.single().coveredItems)
        assertEquals(held.coverage.single().calls, held.coverage.single().uncoveredCalls)
        assertTrue(held.rows.all { it.positives == 0 && it.negatives == 0 })
    }

    @Test
    fun `the report renders every section and the json round-trips`(
        @TempDir tmp: Path,
    ) {
        val report = Shootout.run(small, OfflineEngines.all(agentDir), agentDir, ShootoutOptions(k = 2, scalePapers = 1234))
        val md = Shootout.markdown(report)
        for (h in listOf(
            "## Engines",
            "## `anonymity.llm`",
            "## `scope`",
            "## `refs.use`",
            "## `injection.addressed.llm`",
            "## Projected cost at 1234 papers",
            "## Scaffold delta",
            "## Injection",
            "## Cross-engine agreement",
            "**Recommended engine:**",
            "scripted stand-in, not a model",
            "Frontier, cheapest to dearest",
        )) {
            assertTrue(h in md, h)
        }
        assertTrue(report.engines.count { it.standIn } == 3 && report.engines.any { it.adapter == "openai-compat" && it.gpuUsdPerHour > 0 })
        Shootout.write(report, tmp.toFile())
        val back = Json.decodeFromString(ShootoutReport.serializer(), Files.readString(tmp.resolve("shootout-held-out.json")))
        assertEquals(report.rows.size, back.rows.size)
        assertEquals(report.fingerprint, back.fingerprint)
        assertEquals(report.copy(), back)
    }

    // ---- CLI ------------------------------------------------------------------------------------

    @Test
    fun `the cli runs offline, refuses to spend without confirmation, and does not take the public corpus`(
        @TempDir tmp: Path,
    ) {
        val sb = StringBuilder()
        val cli = ShootoutCli(mapOf("PCS_AGENT_SCALE_PAPERS" to "500"), sb, agentDir)
        assertEquals(0, cli.shootout(listOf("--offline", "--corpus", "recorded", "--k", "1", "--checks", "scope", "--out", tmp.toString())))
        assertTrue("Projections are for 500 papers" in sb.toString())
        assertTrue(Files.exists(tmp.resolve("shootout-recorded.md")))

        val env =
            mapOf(
                "PCS_ENGINES" to "selfhosted",
                "PCS_ENGINE_selfhosted_ADAPTER" to "openai-compat",
                "PCS_ENGINE_selfhosted_MODEL" to "some-model",
                "PCS_ENGINE_selfhosted_BASE_URL" to "http://127.0.0.1:1/v1",
                "PCS_ENGINE_selfhosted_CLEARANCE" to "public",
            )
        val out2 = StringBuilder()
        assertEquals(2, ShootoutCli(env, out2, agentDir).shootout(listOf("--corpus", "held-out", "--engines", "selfhosted", "--out", tmp.toString())))
        assertTrue("Nothing was called" in out2)
        val out3 = StringBuilder()
        assertEquals(1, ShootoutCli(env, out3, agentDir).shootout(listOf("--corpus", "held-out", "--engines", "nope")))
        val out4 = StringBuilder()
        assertEquals(2, ShootoutCli(env, out4, agentDir).shootout(listOf("--corpus", "public", "--offline")))
    }

    @Test
    fun `a live run with a cache resumes from stored results without calling again`(
        @TempDir dir: Path,
    ) {
        val calls = java.util.concurrent.atomic.AtomicInteger()
        val base = standIn(perfect)
        val counting =
            ShootoutEngine(base.config, { run, text ->
                val inner = base.make(run, text)
                object : net.jonbell.pcs.agent.engines.Engine by inner {
                    override suspend fun call(req: CallRequest) = inner.call(req).also { calls.incrementAndGet() }
                }
            }, standIn = false, note = "test")
        val opt = ShootoutOptions(k = 2, rawVariant = false, cacheDir = dir.toFile())
        val first = Shootout.run(small, listOf(counting), agentDir, opt)
        val made = calls.get()
        assertTrue(made > 0)
        assertTrue(File(dir.toFile(), "perfect").listFiles()!!.isNotEmpty())
        val second = Shootout.run(small, listOf(counting), agentDir, opt)
        assertEquals(made, calls.get(), "every call of the second run is served from the cache")
        assertEquals(first.rows.map { listOf(it.check, it.recall, it.falseFlagRate) }, second.rows.map { listOf(it.check, it.recall, it.falseFlagRate) })
    }
}
