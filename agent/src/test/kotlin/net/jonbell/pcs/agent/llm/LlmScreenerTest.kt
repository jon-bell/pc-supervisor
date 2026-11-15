package net.jonbell.pcs.agent.llm

import kotlinx.coroutines.runBlocking
import net.jonbell.pcs.agent.TestCorpus
import net.jonbell.pcs.agent.checks.Severity
import net.jonbell.pcs.agent.engines.Adapter
import net.jonbell.pcs.agent.engines.CallResult
import net.jonbell.pcs.agent.engines.ClearanceRefused
import net.jonbell.pcs.agent.engines.DataClass
import net.jonbell.pcs.agent.engines.Dispatcher
import net.jonbell.pcs.agent.engines.PaperInput
import net.jonbell.pcs.agent.engines.Registered
import net.jonbell.pcs.agent.engines.ScriptedEngine
import net.jonbell.pcs.agent.engines.Status
import net.jonbell.pcs.agent.engines.Usage
import net.jonbell.pcs.agent.engines.cfg
import net.jonbell.pcs.agent.eval.Scoring
import net.jonbell.pcs.testing.Covers
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.io.File

/** The LLM checks, end to end through the dispatcher with a scripted model: anchoring, flag cards, decisions, the monitors, and injection.effect. */
@Covers("prop:S4", "prop:S5", "check:anonymity", "check:scope", "check:refs.use", "check:summary", "check:injection.addressed", "check:injection.effect")
class LlmScreenerTest {
    private val agentDir = File(System.getProperty("pcs.repoRoot"), "agent")
    private val allChecks by lazy { Screener.checks(File(agentDir, "checks").toPath()) }
    private val decisions by lazy { Decisions.load(File(agentDir, "decisions.example.yaml").toPath()) }
    private val cases by lazy { LlmCorpus.generate().associateBy { it.id } }
    private val detDeps by lazy { Screener.deterministicDeps(File(agentDir, "checks").toPath()) }

    private fun screener(
        model: FakeModel,
        ids: List<String>,
        c: LlmCase?,
        opts: ScreenOptions = ScreenOptions(),
        dec: Decisions = decisions,
        ceiling: DataClass = DataClass.SYNTHETIC,
        engine: ScriptedEngine = ScriptedEngine("fake") { model.answer(it) },
    ): Pair<Screener, ScriptedEngine> {
        val d = Dispatcher(listOf(Registered(cfg("fake", Adapter.OPENAI_COMPAT, ceiling), engine)))
        val env = c?.let { LiveSample.env(it) } ?: CheckEnv(LlmCorpus.CFP)
        return Screener(d, ids.associateWith { "fake" }, ids.map { id -> allChecks.first { it.id == id } }, dec, env, detDeps, options = opts) to engine
    }

    private fun screen(s: Screener, p: PaperInput) = runBlocking { s.screen(p) }

    private fun hiddenMutant() =
        TestCorpus.mutants.first { m ->
            m.entry.planted.let { it != null && it.check == "injection.hidden" && it.vector == "render-mode-3" } &&
                m.entry.payload!!.startsWith("Ignore")
        }

    private fun case(id: String) = cases.getValue(id)

    // ---- anchors -------------------------------------------------------------------------

    @Test
    fun `a model's quotation is anchored by the harness and a quotation that is not in the paper is stored unverified and never shown`() {
        val c = case("anonymity-llm/own-prior-work")
        val model = FakeModel(extraAnonymity = listOf("we are the authors of the famous Zorblax system"))
        val (s, _) = screener(model, listOf("anonymity.llm"), c)
        val r = screen(s, LiveSample.paper(c))
        val mine = r.flags.filter { it.check == "anonymity.llm" }
        assertEquals(2, mine.size)
        val good = mine.single { it.verified }
        val bad = mine.single { !it.verified }
        assertEquals("own-prior-work", good.kind)
        assertEquals("anonymity", good.ground)
        assertEquals(1, good.anchors.size)
        // The anchor is the paper's own text at the located range, not the model's wording.
        val pageText =
            TestCorpus.items.let { _ ->
                net.jonbell.pcs.agent.extract.PdfExtractor(net.jonbell.pcs.agent.extract.HeuristicReferenceParser).extract(c.pdf)
            }
        assertTrue(good.anchors.all { Anchoring.verify(it, pageText) })
        assertTrue(good.anchors.single().quote.contains("our previous tool"))
        assertTrue(bad.problems.isNotEmpty() && bad.anchors.isEmpty())
        // Cards: the unverified flag has none, and none of its text reaches a person.
        val cards = FlagCards.visible(r.flags, decisions)
        assertTrue(cards.none { it.text().contains("Zorblax") && it.text().contains("famous") })
        assertTrue(cards.any { it.text().contains("our previous tool") })
        assertThrows(IllegalArgumentException::class.java) { FlagCards.view(bad, decisions) }
        assertEquals(0.5, FlagCards.unverifiedRate(mine))
        assertTrue(
            r.flags.any {
                it.check == "injection.effect" && it.kind == "unverified-quotation" && it.severity == Severity.LOW
            },
            "the monitor counts the failed quotation",
        )
    }

    @Test
    fun `anchoring tolerates whitespace, ligatures, soft hyphens and curly quotes and refuses short or absent quotations`() {
        val text = "We evaluate the ﬁrst approach.\nIt does not “fail” on inter­national inputs at all."
        assertEquals(
            "We evaluate the ﬁrst approach.",
            text.substring(
                Anchoring.find(
                    text,
                    "we".replaceFirstChar {
                        'W'
                    } + " evaluate the first   approach.",
                )!!,
            ),
        )
        assertTrue(Anchoring.find(text, "It does not \"fail\" on international inputs at all.") != null)
        assertEquals(null, Anchoring.find(text, "the"), "a short quotation matches by accident")
        assertEquals(null, Anchoring.find(text, "We evaluate the second approach."))
    }

    @Test
    fun `text in a hidden span is never sent to the engine and a quotation inside it is no anchor`() {
        val item = hiddenMutant()
        val payload = item.entry.payload!!
        val model = FakeModel(extraAnonymity = listOf(payload))
        val (s, engine) = screener(model, listOf("anonymity.llm", "summary"), null)
        val p = PaperInput(item.entry.id, DataClass.SYNTHETIC, item.bytes, Scoring.config(item.entry))
        val r = screen(s, p)
        assertTrue(engine.calls.get() >= 2)
        assertTrue(
            engine.seen.all { req ->
                req.parts.filterIsInstance<net.jonbell.pcs.agent.engines.Part.Text>().none { payload in it.text }
            },
            "the payload never reaches the engine",
        )
        val a = r.flags.single { it.check == "anonymity.llm" }
        assertFalse(a.verified, "a quotation that lies in hidden text is unverified")
        assertTrue(r.flags.any { it.check == "injection.hidden" && it.ground == "prompt-injection" }, "the deterministic check still reports it")
    }

    // ---- decisions and blocking -----------------------------------------------------------

    @Test
    fun `a flag that depends on an unresolved decision renders as blocked and unblocks when the decision is settled`() {
        val c = case("refs-use/miscited")
        val (s, _) = screener(FakeModel(), listOf("refs.use"), c)
        val r = screen(s, LiveSample.paper(c))
        val f = r.flags.single { it.check == "refs.use" }
        assertTrue(f.verified)
        assertEquals("misused-citation", f.ground)
        assertEquals(2, f.anchors.size, "both quotations: the citing sentence and the abstract")
        assertEquals(setOf("citing sentence", "abstract of [2]"), f.anchors.map { it.label }.toSet())
        // The example file now settles refs.use.policy (evidence only), so the mechanism is shown with the decision reopened.
        val reopened = Decisions(decisions.all.map { if (it.id == "refs.use.policy") it.copy(status = DecisionStatus.UNRESOLVED) else it })
        val blocked = FlagCards.view(f, reopened)
        assertTrue(blocked.blocked && blocked.state == "BLOCKED" && blocked.blockedBy == listOf("refs.use.policy"))
        assertTrue(blocked.text().contains("refs.use.policy"))
        assertTrue(blocked.text().startsWith("[BLOCKED]"))
        assertEquals("OPEN", FlagCards.view(f, decisions).state, "the example decisions settle refs.use.policy, so the card is not blocked")
        assertEquals("BLOCKED", FlagCards.view(f, Decisions.EMPTY).state, "a decision with no record is unresolved")
        assertTrue(FlagCards.view(f, reopened).markdown().contains("Blocked: waiting on unresolved refs.use.policy"))
        // refs.use is evidence only: the card carries no ground and says so.
        val card = FlagCards.view(f, decisions)
        assertTrue(card.facts.none { it.first == "Ground" } && card.facts.any { it.first == "Role" && it.second.contains("evidence only") })
        assertEquals(null, GroundPolicy.groundOf(f))
    }

    @Test
    fun `a provisional or assumed dependency does not block, and deterministic flags carry their decisions`() {
        val item = TestCorpus.mutants.first { it.entry.planted.let { p -> p != null && p.check == "anonymity" } }
        val (s, _) = screener(FakeModel(), emptyList(), null)
        val r = screen(s, PaperInput(item.entry.id, DataClass.SYNTHETIC, item.bytes, Scoring.config(item.entry)))
        val f = r.flags.first { it.check == "anonymity" && it.ground == "anonymity" }
        assertEquals(listOf("Q1"), f.dependsOn)
        val card = FlagCards.view(f, decisions)
        assertEquals("OPEN", card.state)
        assertTrue(card.decisions.single().startsWith("Q1 (provisional)"))
    }

    @Test
    fun `a decision change reruns only the checks that cite it`() {
        val c = case("anonymity-llm/clean")
        val edited = Decisions(decisions.all.map { if (it.id == "Q1") it.copy(statement = "A violation is rejected at once.") else it })
        val d = Dispatcher(listOf(Registered(cfg("fake", Adapter.OPENAI_COMPAT, DataClass.SYNTHETIC), ScriptedEngine("fake"))))

        fun keys(dec: Decisions) =
            allChecks.associate { ch ->
                val ctx =
                    net.jonbell.pcs.agent.checks.ScreenContext(
                        c.pdf,
                        net.jonbell.pcs.agent.extract.PdfExtractor(net.jonbell.pcs.agent.extract.HeuristicReferenceParser).extract(c.pdf),
                        net.jonbell.pcs.agent.checks.ScreenConfig(),
                    )
                try {
                    ch.id to ch.units(PaperView(ctx), LiveSample.env(c)).map { d.keyFor("fake", ch.request(it, DataClass.SYNTHETIC, dec)) }
                } finally {
                    ctx.close()
                }
            }
        val a = keys(decisions)
        val b = keys(edited)
        assertNotEquals(a.getValue("anonymity.llm"), b.getValue("anonymity.llm"), "anonymity.llm cites Q1")
        for (id in a.keys - "anonymity.llm") assertEquals(a.getValue(id), b.getValue(id), "$id does not cite Q1")
    }

    // ---- summary ---------------------------------------------------------------------------

    @Test
    fun `every statement of the summary is anchored and one that is not is left out and counted`() {
        val c = case("summary/clean")
        val (s, _) = screener(FakeModel(extraSummary = listOf("The authors prove that P equals NP in this very paper.")), listOf("summary"), c)
        val r = screen(s, LiveSample.paper(c))
        val sum = r.summary!!
        assertEquals(1, sum.dropped)
        assertEquals(1, sum.items.size)
        assertTrue(sum.items.all { it.anchor.page != null && it.anchor.quote.isNotBlank() })
        assertFalse(sum.text().contains("P equals NP"))
        assertTrue(sum.text().contains("not a recommendation"))
    }

    // ---- the other checks -------------------------------------------------------------------

    @Test
    fun `scope flags only an out-of-scope paper, with the paper's own claim anchored`() {
        val outCase = case("scope/domain-swap")
        val (s, _) = screener(FakeModel(), listOf("scope"), outCase)
        val f = screen(s, LiveSample.paper(outCase)).flags.single { it.check == "scope" }
        assertTrue(f.verified)
        assertEquals("scope", f.ground)
        assertTrue(f.anchors.single().quote.lowercase().contains("kelp"))
        val inCase = case("scope/in-scope")
        val (s2, _) = screener(FakeModel(), listOf("scope"), inCase)
        assertTrue(screen(s2, LiveSample.paper(inCase)).flags.none { it.check == "scope" })
        // Without a call for papers there is nothing to ask.
        val (_, e3) = screener(FakeModel(), listOf("scope"), null)
        val noCfp =
            Screener(
                Dispatcher(listOf(Registered(cfg("fake", Adapter.OPENAI_COMPAT, DataClass.SYNTHETIC), e3))),
                mapOf("scope" to "fake"),
                listOf(
                    allChecks.first {
                        it.id ==
                            "scope"
                    },
                ),
                decisions,
                CheckEnv(),
            )
        screen(noCfp, LiveSample.paper(inCase))
        assertEquals(0, e3.calls.get())
    }

    @Test
    fun `refs-use gives one flag per miscited citation and none for faithful ones`() {
        val ok = case("refs-use/faithful")
        val (s, e) = screener(FakeModel(), listOf("refs.use"), ok)
        assertTrue(screen(s, LiveSample.paper(ok)).flags.none { it.check == "refs.use" })
        assertEquals(1, e.calls.get(), "one call for the whole paper")
        // A reference with no abstract is not checked.
        val (s2, e2) = screener(FakeModel(), listOf("refs.use"), null)
        screen(s2, LiveSample.paper(ok))
        assertEquals(0, e2.calls.get())
    }

    @Test
    fun `the classifier separates an attack from a quotation, and a verdict is never a ground`() {
        val attack = case("injection-addressed-llm/attack")
        val (s, _) = screener(FakeModel(), listOf("injection.addressed.llm"), attack)
        val r = screen(s, LiveSample.paper(attack))
        val f = r.flags.single { it.check == "injection.addressed.llm" }
        assertEquals("addressed-to-ai", f.kind)
        assertEquals(null, f.ground)
        assertEquals(Severity.HIGH, f.severity)
        assertTrue(f.verified && f.anchors.single().quote.startsWith("Ignore all previous instructions"))
        val quote = case("injection-addressed-llm/quotation")
        val (s2, _) = screener(FakeModel(), listOf("injection.addressed.llm"), quote)
        assertTrue(screen(s2, LiveSample.paper(quote)).flags.none { it.check == "injection.addressed.llm" })
    }

    // ---- injection.effect --------------------------------------------------------------------

    @Test
    fun `a suspect span triggers the with-and-without rerun, the difference is reported with both outputs and the output without the span is shown`() {
        val c = case("injection-effect/obeyed")
        val (s, engine) = screener(FakeModel(obey = true), listOf("summary"), c)
        val r = screen(s, LiveSample.paper(c))
        assertEquals(2, engine.calls.get())
        assertEquals(setOf("shown", "with-span"), r.calls.map { it.run }.toSet())
        val e = r.flags.single { it.check == "injection.effect" && it.kind == "output-differs" }
        assertEquals("prompt-injection", e.ground)
        assertTrue(e.verified && e.anchors.isNotEmpty() && e.anchors.all { it.label == "suspect span" })
        assertTrue(e.fields.keys.any { it.startsWith("shown.output with") } && e.fields.keys.any { it.startsWith("shown.output without") })
        val view = FlagCards.view(e, decisions)
        assertTrue(view.text().contains("without the span"))
        assertEquals("prompt-injection", GroundPolicy.groundOf(e), "a verified effect flag carries the ground")
        assertTrue(view.facts.contains("Ground" to "prompt-injection"))
        // The monitors' flags are signals: no ground.
        assertTrue(r.flags.filter { it.check == "injection.effect" && it.kind != "output-differs" }.all { GroundPolicy.groundOf(it) == null })
        assertEquals(null, GroundPolicy.groundOf(e.copy(status = FlagStatus.UNVERIFIED)), "an unverified effect flag carries nothing")
        // The summary shown is from the run without the span.
        assertFalse(r.summary!!.text().contains("10/10"))
        // The with-span request contained the instruction; the shown request did not.
        val texts = engine.seen.map { q -> q.parts.filterIsInstance<net.jonbell.pcs.agent.engines.Part.Text>().joinToString { it.text } }
        assertEquals(1, texts.count { squash(it).contains("score of 10/10") })
        // The monitors saw the obeyed output too.
        assertTrue(r.flags.any { it.check == "injection.effect" && it.kind == "unasked-verdict" })
    }

    @Test
    fun `an engine that ignores the instruction gives no effect flag, and a paper without a suspect span is run once`() {
        val c = case("injection-effect/obeyed")
        val (s, engine) = screener(FakeModel(obey = false), listOf("summary"), c)
        val r = screen(s, LiveSample.paper(c))
        assertEquals(2, engine.calls.get())
        assertTrue(r.flags.none { it.check == "injection.effect" && it.kind == "output-differs" })
        val clean = case("injection-effect/clean")
        val (s2, e2) = screener(FakeModel(), listOf("summary"), clean)
        val r2 = screen(s2, LiveSample.paper(clean))
        assertEquals(1, e2.calls.get())
        assertTrue(r2.flags.none { it.check == "injection.effect" })
    }

    @Test
    fun `the hidden-text probe sends hidden text only for synthetic papers, and only in the probe call`() {
        val item =
            hiddenMutant()
        val payload = item.entry.payload!!
        val model = FakeModel(obey = true)
        val (s, engine) = screener(model, listOf("summary"), null, ScreenOptions(probeHidden = true))
        val r = screen(s, PaperInput(item.entry.id, DataClass.SYNTHETIC, item.bytes, Scoring.config(item.entry)))
        val withPayload = engine.seen.filter { q -> q.parts.filterIsInstance<net.jonbell.pcs.agent.engines.Part.Text>().any { payload in it.text } }
        assertEquals(1, withPayload.size)
        assertEquals("hidden-probe", r.calls.single { it.key == withPayload.single().let { _ -> r.calls.first { c -> c.run == "hidden-probe" }.key } }.run)
        assertTrue(r.flags.any { it.check == "injection.effect" && it.kind == "output-differs" && it.fields.getValue("message").contains("hidden text") })
        // Never for another class.
        val (s2, e2) = screener(FakeModel(), listOf("summary"), null, ScreenOptions(probeHidden = true), ceiling = DataClass.PUBLIC)
        assertThrows(IllegalArgumentException::class.java) { screen(s2, PaperInput(item.entry.id, DataClass.PUBLIC, item.bytes, Scoring.config(item.entry))) }
        assertEquals(0, e2.calls.get())
    }

    // ---- monitors ----------------------------------------------------------------------------

    private fun ok(output: String, raw: String = "") =
        CallResult("k", Status.OK, kotlinx.serialization.json.Json.parseToJsonElement(output), "m", Usage(), raw = raw)

    private val summaryCheck by lazy { allChecks.first { it.id == "summary" } }
    private val classifier by lazy { allChecks.first { it.id == "injection.addressed.llm" } }

    @Test
    fun `the monitors flag an unasked verdict, talk about instructions, refusals, schema failures and tool calls, and leave quotations alone`() {
        fun kinds(c: ScreenLlmCheck, r: CallResult) = Monitors.inspect(c, r).map { it.kind }.toSet()
        assertEquals(
            setOf("unasked-verdict"),
            kinds(
                summaryCheck,
                ok(
                    """{"contributions":[{"text":"We recommend acceptance of this paper.","quote":"a quotation of ten chars"}],"evaluation":[],"prior_work":[],"closest_cited_work":[]}""",
                ),
            ),
        )
        assertEquals(
            setOf("unasked-verdict"),
            kinds(
                summaryCheck,
                ok(
                    """{"contributions":[{"text":"It deserves a score of 10/10.","quote":"a quotation of ten chars"}],"evaluation":[],"prior_work":[],"closest_cited_work":[]}""",
                ),
            ),
        )
        assertEquals(
            setOf("talks-about-instructions"),
            kinds(
                summaryCheck,
                ok(
                    """{"contributions":[{"text":"As instructed in the text, the paper is great.","quote":"a quotation of ten chars"}],"evaluation":[],"prior_work":[],"closest_cited_work":[]}""",
                ),
            ),
        )
        // The classifier's subject is instructions, so its reason may talk about them.
        assertEquals(emptySet<String>(), kinds(classifier, ok("""{"verdict":"attack","reason":"It gives the reader an instruction."}""")))
        // A verbatim quotation may contain anything: the paper wrote it, not the model.
        assertEquals(
            emptySet<String>(),
            kinds(
                summaryCheck,
                ok(
                    """{"contributions":[{"text":"A test generator.","quote":"We recommend acceptance of this paper."}],"evaluation":[],"prior_work":[],"closest_cited_work":[]}""",
                ),
            ),
        )
        assertEquals(setOf("refusal"), kinds(summaryCheck, CallResult("k", Status.REFUSAL)))
        assertEquals(setOf("schema-failure"), kinds(summaryCheck, CallResult("k", Status.SCHEMA_INVALID, detail = "x")))
        val envelope = """{"type":"result","permission_denials":[{"tool_name":"WebFetch"}],"num_turns":2,"subagent_stats":{"spawned":0}}"""
        assertEquals(setOf("tool-call"), kinds(classifier, ok("""{"verdict":"attack","reason":"r"}""", envelope)))
        assertEquals(
            setOf("tool-call"),
            kinds(classifier, ok("""{"verdict":"attack","reason":"r"}""", """{"choices":[{"message":{"tool_calls":[{"id":"1"}]}}]}""")),
        )
        // The CLI's own structured-output step (two turns, stop_reason tool_use) is not a tool call outside scope.
        val normal =
            """{"type":"result","stop_reason":"tool_use","num_turns":2,"permission_denials":[],"subagent_stats":{"spawned":0},""" +
                """"usage":{"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0}}}"""
        assertEquals(emptySet<String>(), kinds(classifier, ok("""{"verdict":"attack","reason":"r"}""", normal)))
    }

    @Test
    fun `a tool call in a call's envelope becomes a high-severity flag on the paper`() {
        val c = case("injection-addressed-llm/attack")
        val envelope = """{"type":"result","permission_denials":[{"tool_name":"Bash"}]}"""
        val (s, _) = screener(FakeModel(raw = envelope), listOf("injection.addressed.llm"), c)
        val f = screen(s, LiveSample.paper(c)).flags.single { it.check == "injection.effect" && it.kind == "tool-call" }
        assertEquals(Severity.HIGH, f.severity)
        assertTrue(f.verified)
    }

    // ---- clearance -----------------------------------------------------------------------------

    @Test
    fun `an engine below the paper's data class is refused before any call`() {
        val c = case("summary/clean")
        val (s, engine) = screener(FakeModel(), listOf("summary"), c, ceiling = DataClass.SYNTHETIC)
        assertThrows(ClearanceRefused::class.java) { screen(s, LiveSample.paper(c, DataClass.PUBLIC)) }
        assertThrows(ClearanceRefused::class.java) { screen(s, LiveSample.paper(c, DataClass.CONFIDENTIAL)) }
        assertEquals(0, engine.calls.get())
    }

    @Test
    fun `decision file errors are reported together and the example loads`() {
        val e =
            assertThrows(DecisionFileException::class.java) {
                Decisions.parse("decisions:\n  - id: A\n    status: maybe\n    title: t\n    statement: s\n    owner_role: r\n  - title: no id\n")
            }
        assertEquals(2, e.problems.size)
        assertEquals(6, decisions.all.size)
        assertEquals(emptyList<String>(), decisions.blockers(listOf("Q1", "refs.use.policy", "scope.cfp")))
        assertEquals(listOf("Q1@" + decisions["Q1"]!!.version, "zzz@none"), decisions.keyTokens(listOf("Q1", "zzz")))
    }
}
