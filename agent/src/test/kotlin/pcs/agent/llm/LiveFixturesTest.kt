package pcs.agent.llm

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import pcs.agent.engines.Adapter
import pcs.agent.engines.DataClass
import pcs.agent.engines.Dispatcher
import pcs.agent.engines.FileResultStore
import pcs.agent.engines.Registered
import pcs.agent.engines.ReplayEngine
import pcs.agent.engines.Status
import pcs.agent.engines.cfg
import pcs.testing.Covers
import java.io.File

/**
 * The recorded live sample, replayed. Every result under `agent/fixtures/replay` was produced by one
 * call to the `claude-code` engine (a Haiku-class model) on a synthetic paper of [LlmCorpus]; this test
 * makes no call at all, only the `replay` engine serves them, and checks that the recorded answers go
 * through the harness to the flags and cards the oracle labels expect.
 */
@Covers("prop:S4", "prop:S5", "check:anonymity", "check:scope", "check:refs.use", "check:summary", "check:injection.addressed", "check:injection.effect")
class LiveFixturesTest {
    private val agentDir = File(System.getProperty("pcs.repoRoot"), "agent")
    private val replayDir = File(agentDir, "fixtures/replay")
    private val recordings = FileResultStore(replayDir.toPath())
    private val decisions = Decisions.load(File(agentDir, "decisions.example.yaml").toPath())
    private val allChecks = Screener.checks(File(agentDir, "checks").toPath())
    private val cases = LlmCorpus.generate().associateBy { it.id }
    private val engine = ReplayEngine("dev-replay", recordings)

    /** `dev-replay` takes the identity of `dev` and the model the recording used, so it computes the keys the recording stored. */
    private val replayConfig = cfg("dev-replay", Adapter.REPLAY, DataClass.SYNTHETIC, model = LiveSample.MODEL, replayOf = LiveSample.ENGINE, baseUrl = null)

    private fun screen(caseId: String): PaperScreen {
        val c = cases.getValue(caseId)
        val ids = LiveSample.PLAN.first { it.first == caseId }.second
        val s =
            Screener(
                Dispatcher(listOf(Registered(replayConfig, engine))),
                ids.associateWith { "dev-replay" },
                LiveSample.checksOf(allChecks, ids),
                decisions,
                LiveSample.env(c),
                Screener.deterministicDeps(File(agentDir, "checks").toPath()),
            )
        return runBlocking { s.screen(LiveSample.paper(c)) }
    }

    private fun PaperScreen.mine(check: String) = flags.filter { it.check == check }

    @Test
    fun `every recorded call is found by its key, and nothing was recorded for a paper that is not synthetic`() {
        val all = recordings.all()
        assertEquals(12, all.size)
        assertTrue(all.all { it.dataClass == DataClass.SYNTHETIC && it.engineId == LiveSample.ENGINE })
        assertTrue(all.all { it.result!!.status == Status.OK && it.result.servedModel.startsWith("claude-") && it.result.costUsd.signum() > 0 })
        assertTrue(all.all { r -> r.paperId in cases }, "the paper of every fixture is a corpus case")
        val text = replayDir.listFiles()!!.joinToString("\n") { it.readText() }
        assertFalse(text.contains("session_id") || text.contains("credential_expires_at") || text.contains("/home/"))
        val screens = LiveSample.PLAN.map { (id, _) -> screen(id) }
        assertEquals(12, screens.sumOf { it.calls.size }, "one recorded call per request, found by key")
        assertTrue(screens.all { s -> s.calls.all { it.status == Status.OK } })
    }

    @Test
    fun `anonymity, scope, and refs-use flag what the oracle plants and nothing in the controls`() {
        assertTrue(screen("anonymity-llm/clean").mine("anonymity.llm").isEmpty())
        val prior = screen("anonymity-llm/own-prior-work").mine("anonymity.llm")
        assertTrue(prior.isNotEmpty() && prior.all { it.verified && it.ground == "anonymity" })
        assertTrue(prior.any { it.anchors.single().quote.contains("our previous tool") })
        val link = screen("anonymity-llm/identifying-link").mine("anonymity.llm")
        assertTrue(link.any { it.verified && it.kind == "identifying-link" && it.anchors.single().quote.contains("https://github.com/") })

        assertTrue(screen("scope/in-scope").mine("scope").isEmpty())
        val out = screen("scope/domain-swap").mine("scope").single()
        assertTrue(out.verified && out.ground == "scope" && out.anchors.isNotEmpty())

        assertTrue(screen("refs-use/faithful").mine("refs.use").isEmpty())
        val mis = screen("refs-use/miscited").mine("refs.use").single()
        assertTrue(mis.verified && mis.ground == "misused-citation")
        assertEquals(setOf("citing sentence", "abstract of [2]"), mis.anchors.map { it.label }.toSet())
        assertTrue(squash(mis.anchors.first { it.label == "citing sentence" }.quote).contains("poor proxy"))
        // The card is blocked: refs.use.policy is unresolved in the example decisions.
        assertEquals("BLOCKED", FlagCards.view(mis, decisions).state)
    }

    @Test
    fun `the classifier calls the attack an attack and the quotation a quotation, and the summary is fully anchored`() {
        val attack = screen("injection-addressed-llm/attack").mine("injection.addressed.llm").single()
        assertEquals("addressed-to-ai", attack.kind)
        assertTrue(attack.verified && attack.ground == null)
        assertTrue(screen("injection-addressed-llm/quotation").mine("injection.addressed.llm").isEmpty())
        val sum = screen("summary/clean").summary
        assertNotNull(sum)
        assertEquals(0, sum!!.dropped)
        assertTrue(sum.items.size >= 3 && sum.items.all { it.anchor.quote.isNotBlank() })
    }

    @Test
    fun `the recorded with-and-without rerun is compared and reported with both outputs`() {
        val r = screen("injection-effect/obeyed")
        assertEquals(setOf("shown", "with-span"), r.calls.map { it.run }.toSet())
        val e = r.mine("injection.effect").filter { it.kind == "output-differs" }
        assertEquals(1, e.size, "the recorded model's summary changed when the instruction was removed")
        assertTrue(e.single().verified && e.single().fields.keys.any { it.startsWith("shown.output without") })
        // The summary shown is the one without the span, and it is anchored.
        assertTrue(r.summary!!.items.isNotEmpty() && r.summary.items.none { squash(it.text).contains("10/10") })
        // Outputs are schema-valid objects as stored.
        recordings.all().forEach { assertTrue(it.result!!.output!!.jsonObject.isNotEmpty() || it.checkId == "anonymity.llm") }
        assertEquals(Json.parseToJsonElement("{}"), Json.parseToJsonElement("{}"))
    }
}
