package pcs.agent.engines

import kotlinx.coroutines.runBlocking
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import pcs.agent.TestCorpus
import pcs.agent.checks.Checks
import pcs.agent.checks.Screening
import pcs.agent.eval.Scoring
import pcs.testing.Covers
import java.math.BigDecimal
import java.nio.file.Files
import java.nio.file.Path

/** M9 done-when, offline: every check runs through `replay`, a cache hit follows a run, and one prompt edit reruns one check. */
@Covers("prop:S5", "check:format", "check:refs.doi", "check:anonymity", "check:injection.hidden", "check:injection.channels", "check:injection.addressed")
class RunnerTest {
    private val papers by lazy {
        // One clean paper and one injection mutant, so the deterministic checks have something to find.
        (TestCorpus.clean.take(1) + TestCorpus.mutants.filter { it.entry.id.contains("injection") }.take(1))
            .map { PaperInput(it.entry.id, DataClass.SYNTHETIC, it.bytes, Scoring.config(it.entry)) }
    }

    private val priced = Prices(BigDecimal("3"), BigDecimal("15"))

    private fun liveRegistered(live: ScriptedEngine) = Registered(cfg("live", model = "m", prices = priced), live)

    @Test
    fun `all checks run through replay with the same results as the recorded run`(
        @TempDir tmp: Path,
    ) {
        val toy = toyCheck(toyCheckDir(tmp.resolve("checks")))
        val recordings = FileResultStore(tmp.resolve("rec"))
        val live = ScriptedEngine("live") { CallResult("", Status.OK, toyOutput("summary of ${it.parts.size} parts"), "served", Usage(900, 60)) }

        // 1. The recording run: the (fake) live engine answers, the store records everything.
        val recorder = Runner(Dispatcher(listOf(liveRegistered(live)), recordings), recordings, llm = listOf(toy), routing = mapOf(toy.id to "live"))
        val first = runBlocking { recorder.run(papers) }
        assertEquals(papers.size, live.calls.get())
        assertEquals(papers.size * (Checks.all().size + 1), first.size)

        // 2. CI: nothing but replay. The dispatcher's own cache is empty, deterministic results are served from recordings only.
        val replayCfg = cfg("ci", Adapter.REPLAY, model = "m", replayOf = "live", baseUrl = null)
        val ci =
            Runner(
                Dispatcher(listOf(Registered(replayCfg, ReplayEngine("ci", recordings))), InMemoryResultStore()),
                recordings,
                llm = listOf(toy),
                routing =
                    mapOf(
                        toy.id to "ci",
                    ),
                localReplay = true,
            )
        val replayed = runBlocking { ci.run(papers) }
        assertEquals(live.calls.get(), papers.size, "replay made no call to the live engine")
        assertEquals(first.size, replayed.size)
        for ((a, b) in first.zip(replayed)) {
            assertEquals(a.checkId, b.checkId)
            assertEquals(a.findings, b.findings, "${a.checkId} on ${a.paperId}")
            assertEquals(a.result?.output, b.result?.output, "${a.checkId} on ${a.paperId}")
        }
        assertTrue(replayed.filter { it.engineId == Runner.LOCAL }.all { it.cached }, "deterministic results came from recordings")

        // 3. The recorded findings are what the checks produce directly.
        for (p in papers) {
            val direct = Screening.run(p.pdf, p.config).findings
            val viaReplay = replayed.filter { it.paperId == p.id && it.findings != null }.flatMap { it.findings!! }
            assertEquals(direct.map { it.toString() }.sorted(), viaReplay.map { it.toString() }.sorted(), p.id)
        }
        assertTrue(replayed.any { it.findings?.isNotEmpty() == true }, "the mutant yields findings")
    }

    @Test
    fun `replay with nothing recorded fails loudly rather than computing`(
        @TempDir tmp: Path,
    ) {
        val empty = FileResultStore(tmp.resolve("empty"))
        val r = Runner(Dispatcher(emptyList(), InMemoryResultStore()), empty, routing = emptyMap(), localReplay = true)
        org.junit.jupiter.api.assertThrows<IllegalStateException> { runBlocking { r.run(papers) } }
    }

    @Test
    fun `plan shows a cache hit after a run and one check rerunning after its prompt changes`(
        @TempDir tmp: Path,
    ) {
        val checks = tmp.resolve("checks")
        val a = toyCheckDir(checks, "toy.a", "Prompt A.")
        val b = toyCheckDir(checks, "toy.b", "Prompt B.")
        val store = InMemoryResultStore()
        val live = ScriptedEngine("live")
        val dispatcher = Dispatcher(listOf(liveRegistered(live)), store)
        val routing = mapOf("toy.a" to "live", "toy.b" to "live")

        fun runner(llm: List<LlmCheck>, local: List<pcs.agent.checks.Check> = Checks.all(), version: (String) -> String = Checks::version) =
            Runner(dispatcher, store, local = local, llm = llm, routing = routing, localVersion = version)

        val before = runner(listOf(toyCheck(a), toyCheck(b))).plan(papers)
        val n = papers.size
        assertEquals(n * (Checks.all().size + 2), before.items.size)
        assertEquals(0, before.cached)
        assertTrue(before.projectedCostUsd.signum() > 0, "uncached LLM calls have a projected cost from the configured prices")
        assertTrue(before.items.filter { it.engineId == Runner.LOCAL }.all { it.projectedCostUsd.signum() == 0 })

        runBlocking { runner(listOf(toyCheck(a), toyCheck(b))).run(papers) }
        assertEquals(2 * n, live.calls.get())

        val after = runner(listOf(toyCheck(a), toyCheck(b))).plan(papers)
        assertEquals(after.items.size, after.cached, "everything is a cache hit after a run")
        assertEquals(BigDecimal.ZERO, after.projectedCostUsd)
        runBlocking { runner(listOf(toyCheck(a), toyCheck(b))).run(papers) }
        assertEquals(2 * n, live.calls.get(), "rerunning calls nothing")

        // Edit check A's prompt: exactly check A (on every paper) is stale.
        Files.writeString(a.resolve("prompt.md"), "Prompt A, revised.")
        val edited = runner(listOf(toyCheck(a), toyCheck(b))).plan(papers)
        assertEquals(setOf("toy.a"), edited.toRun.map { it.checkId }.toSet())
        assertEquals(n, edited.toRun.size)
        assertTrue(edited.toRun.all { it.projectedCostUsd.signum() > 0 })
        assertTrue(edited.render().contains("1 check") || edited.render().contains("$n would run"), edited.render())
        runBlocking { runner(listOf(toyCheck(a), toyCheck(b))).run(papers) }
        assertEquals(3 * n, live.calls.get(), "only check A called the engine again")

        // Edit its schema: again only that check; and a local check's version change reruns only that check.
        Files.writeString(b.resolve("schema.json"), Files.readString(b.resolve("schema.json")).replace("\"minLength\":1", "\"minLength\":2"))
        assertEquals(setOf("toy.b"), runner(listOf(toyCheck(a), toyCheck(b))).plan(papers).toRun.map { it.checkId }.toSet())
        val bumped = runner(listOf(toyCheck(a)), version = { id -> if (id == "format") "edited" else Checks.version(id) }).plan(papers)
        assertEquals(setOf("format"), bumped.toRun.map { it.checkId }.toSet())
    }

    @Test
    fun `a plan projects from recorded usage once there is some`(
        @TempDir tmp: Path,
    ) {
        val c = toyCheck(toyCheckDir(tmp.resolve("checks")))
        val store = InMemoryResultStore()
        val live = ScriptedEngine("live") { CallResult("", Status.OK, toyOutput(), "s", Usage(1_000_000, 0)) }
        val d = Dispatcher(listOf(liveRegistered(live)), store)
        val r = Runner(d, store, local = emptyList(), llm = listOf(c), routing = mapOf(c.id to "live"))
        runBlocking { r.run(papers.take(1)) }
        val plan = r.plan(papers.drop(1))
        assertEquals(BigDecimal("3.00000000"), plan.projectedCostUsd, "one recorded call used 1M input tokens at 3 USD per million")
    }
}
