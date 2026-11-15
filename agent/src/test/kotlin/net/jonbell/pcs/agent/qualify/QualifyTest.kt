@file:Suppress("ktlint:standard:max-line-length")

package net.jonbell.pcs.agent.qualify

import kotlinx.coroutines.runBlocking
import net.jonbell.pcs.agent.engines.Adapter
import net.jonbell.pcs.agent.engines.CheckDirs
import net.jonbell.pcs.agent.engines.DataClass
import net.jonbell.pcs.agent.engines.Dispatcher
import net.jonbell.pcs.agent.engines.Engine
import net.jonbell.pcs.agent.engines.EngineConfig
import net.jonbell.pcs.agent.engines.Prices
import net.jonbell.pcs.agent.engines.Registered
import net.jonbell.pcs.agent.engines.ScriptedEngine as FakeEngine
import net.jonbell.pcs.agent.engines.request
import net.jonbell.pcs.agent.eval.HeldOut
import net.jonbell.pcs.agent.eval.Profile
import net.jonbell.pcs.agent.eval.ScriptedEngine
import net.jonbell.pcs.agent.eval.Shootout
import net.jonbell.pcs.agent.eval.ShootoutEngine
import net.jonbell.pcs.agent.eval.ShootoutOptions
import net.jonbell.pcs.agent.llm.Qualification
import net.jonbell.pcs.testing.Covers
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.assertThrows
import org.junit.jupiter.api.io.TempDir
import java.io.File
import java.math.BigDecimal
import java.nio.file.Files
import java.nio.file.Path

/**
 * Qualification records, the gate in front of confidential data, and change classification (agent.md 7.4).
 * The engines are scripted functions; no call is made anywhere.
 */
@Covers("prop:S5", "check:scope")
class QualifyTest {
    private val agentDir = File(System.getProperty("pcs.repoRoot"), "agent")
    private val perfect = Profile("perfect", 1, miss = 0.0, falseAlarm = 0.0, flip = 0.0, badQuote = 0.0)
    private val lenient = Profile("lenient", 2, miss = 0.6, falseAlarm = 0.0, flip = 0.0, badQuote = 0.0)
    private val noisy = Profile("noisy", 3, miss = 0.4, falseAlarm = 0.3, flip = 0.4, badQuote = 0.0)
    private val prices = Prices(BigDecimal("3"), BigDecimal("15"))

    private fun cfg(id: String, model: String = id, prices: Prices = this.prices, concurrency: Int = 4, clearance: DataClass = DataClass.PUBLIC) =
        EngineConfig(id, Adapter.ANTHROPIC, model, clearance, null, prices = prices, concurrency = concurrency)

    /** A "real" engine for the test: not marked a stand-in, so it can earn a record. */
    private fun real(c: EngineConfig, p: (CallPrompt) -> Profile) =
        ShootoutEngine(
            c,
            { run, text ->
                object : Engine {
                    override val id = c.id
                    override val caps = ScriptedEngine(c.id, perfect, run, text).caps

                    override suspend fun call(req: net.jonbell.pcs.agent.engines.CallRequest) = ScriptedEngine(c.id, p(CallPrompt(req.system)), run, text).call(req)
                }
            },
            standIn = false,
            note = "test",
        )

    data class CallPrompt(val system: String)

    /** The checks directory copied to [tmp], so a test can edit a prompt without touching the repository. */
    private fun copyChecks(tmp: Path): Path {
        val dest = tmp.resolve("agent-copy")
        File(agentDir, "checks").copyRecursively(dest.resolve("checks").toFile())
        File(agentDir, "src/main/kotlin").copyRecursively(dest.resolve("src/main/kotlin").toFile())
        File(agentDir, "decisions.example.yaml").copyTo(dest.resolve("decisions.example.yaml").toFile())
        return dest
    }

    private val held by lazy { HeldOut.generate() }

    private fun report(dir: Path, es: List<ShootoutEngine>, k: Int = 3, check: String = "scope") = Shootout.run(held, es, dir.toFile(), ShootoutOptions(k = k, rawVariant = false, checks = setOf(check)))

    @Test
    fun `thresholds come from qualification yaml, which is not part of the check's version`(@TempDir tmp: Path) {
        val dir = copyChecks(tmp).resolve("checks/scope")
        val before = CheckDirs.version(dir, agentDir.toPath())
        val t = Thresholds.read(dir)
        assertEquals(0.8, t.minRecall)
        assertEquals(6, t.minPositives)
        Files.writeString(dir.resolve("qualification.yaml"), "thresholds:\n  min_recall: 0.5\n  min_runs: 2\n")
        assertEquals(before, CheckDirs.version(dir, agentDir.toPath()), "a threshold edit is not a new version")
        assertEquals(0.5, Thresholds.read(dir).minRecall)
        assertEquals(2, Thresholds.read(dir).minRuns)
        assertEquals(0.1, Thresholds.read(dir).maxFalseFlagRate, "unset keys keep the default")
        Files.delete(dir.resolve("qualification.yaml"))
        assertEquals(before, CheckDirs.version(dir, agentDir.toPath()))
        assertEquals(Thresholds(), Thresholds.read(dir))
        // The same hash as the Gradle task computed for the shipped directory.
        assertEquals(CheckDirs.version(File(agentDir, "checks/scope").toPath(), agentDir.toPath()), before)
        assertFalse(CheckDirs.fileHashes(dir, agentDir.toPath()).containsKey("qualification.yaml"))
    }

    @Test
    fun `a good engine earns a record, a poor one, a noisy one, and a stand-in do not, and each says why`(@TempDir tmp: Path) {
        val dir = copyChecks(tmp)
        val good = real(cfg("good"), { perfect })
        val poor = real(cfg("poor"), { lenient })
        val shaky = real(cfg("shaky"), { noisy })
        val standIn = ShootoutEngine(cfg("standin"), { run, text -> ScriptedEngine("standin", perfect, run, text) }, standIn = true, note = "t")
        val r = report(dir, listOf(good, poor, shaky, standIn))
        val out = Qualifier.qualify(r, listOf(good, poor, shaky, standIn), dir.resolve("checks"), agentDir.toPath(), "2026-11-15T12:00:00Z")
        val rec = out.records.single()
        assertEquals("scope", rec.check)
        assertEquals("good", rec.engine)
        assertEquals("scaffold", rec.variant)
        assertEquals(CheckDirs.version(File(agentDir, "checks/scope").toPath(), agentDir.toPath()), rec.version)
        assertTrue(rec.metrics.getValue("recall") >= 0.8 && rec.metrics.getValue("false_flag_rate") <= 0.1 && rec.metrics.getValue("runs") == 3.0)
        assertEquals(Thresholds().asMap(), rec.thresholds)
        assertTrue("prompt.md" in rec.files && rec.files.keys.any { it.startsWith("code:") })
        assertTrue(rec.flags.isNotEmpty() && rec.flags.values.flatten().all { it.startsWith("scope|") })
        assertTrue(out.notes.any { it.startsWith("poor / scope: not qualified") && "recall" in it }, out.notes.toString())
        assertTrue(out.notes.any { it.startsWith("shaky / scope: not qualified") }, out.notes.toString())
        assertTrue(out.notes.any { it.startsWith("standin: a scripted stand-in is not an engine") })
        // Two runs are not enough to claim stability over three (the check says k >= 3).
        val k2 = Qualifier.qualify(report(dir, listOf(good), k = 2), listOf(good), dir.resolve("checks"), agentDir.toPath(), "t")
        assertTrue(k2.records.isEmpty() && k2.notes.single().contains("k=2"), k2.notes.toString())
        // The records file keeps one record per tuple and merges.
        val f = tmp.resolve("q.json")
        QualificationFile.save(f, emptyList(), out.records)
        QualificationFile.save(f, QualificationFile.load(f), out.records + rec.copy(engine = "other"))
        assertEquals(listOf("good", "other"), QualificationFile.load(f).map { it.engine })
    }

    private fun record(version: String = "v1", model: String = "m", engine: String = "e", variant: String = "scaffold") =
        Qualification("toy.summary", version, engine, model, variant, options = "platform=api;structured=json_schema")

    @Test
    fun `production refuses an unqualified check and engine for confidential data before any adapter, store or guard is touched`() {
        val fake = FakeEngine("e")
        val c = cfg("e", model = "m", clearance = DataClass.CONFIDENTIAL).copy(clearanceDecision = "d-settled")
        val none = Dispatcher(listOf(Registered(c, fake)), gate = QualificationGate(emptyList()))
        val ex = assertThrows<Unqualified> { runBlocking { none.call("e", request(DataClass.CONFIDENTIAL)) } }
        assertTrue(ex.message!!.contains("toy.summary") && ex.message!!.contains("'e'") && ex.message!!.contains("no qualification record"))
        assertEquals(0, fake.calls.get())
        // Synthetic and public data need no record.
        assertEquals(net.jonbell.pcs.agent.engines.Status.OK, runBlocking { none.call("e", request(DataClass.PUBLIC)).result.status })
        assertEquals(net.jonbell.pcs.agent.engines.Status.OK, runBlocking { none.call("e", request(DataClass.SYNTHETIC)).result.status })
        // A matching record admits it.
        val ok = Dispatcher(listOf(Registered(c, fake)), gate = QualificationGate(listOf(record())))
        assertEquals(net.jonbell.pcs.agent.engines.Status.OK, runBlocking { ok.call("e", request(DataClass.CONFIDENTIAL)).result.status })
        // Another version of the check, another model, another variant, another engine: each is refused and says why.
        fun refused(g: QualificationGate, req: net.jonbell.pcs.agent.engines.CallRequest, cfgs: EngineConfig = c, part: String) {
            val e = assertThrows<Unqualified> { runBlocking { Dispatcher(listOf(Registered(cfgs, FakeEngine(cfgs.id))), gate = g).call(cfgs.id, req) } }
            assertTrue(e.message!!.contains(part), e.message)
        }
        refused(QualificationGate(listOf(record())), request(DataClass.CONFIDENTIAL, version = "v2"), part = "needs requalification")
        refused(QualificationGate(listOf(record(model = "older"))), request(DataClass.CONFIDENTIAL), part = "model older")
        refused(QualificationGate(listOf(record(variant = "raw-pdf"))), request(DataClass.CONFIDENTIAL), part = "variant")
        refused(QualificationGate(listOf(record(engine = "someone-else"))), request(DataClass.CONFIDENTIAL), part = "no qualification record")
        // Clearance still comes first: a record cannot raise an engine above its ceiling.
        val low = cfg("e", model = "m", clearance = DataClass.PUBLIC)
        assertThrows<net.jonbell.pcs.agent.engines.ClearanceRefused> { runBlocking { Dispatcher(listOf(Registered(low, FakeEngine("e"))), gate = QualificationGate(listOf(record()))).call("e", request(DataClass.CONFIDENTIAL)) } }
    }

    @Test
    fun `a prompt edit needs requalification and names the file, a price or concurrency change is covered`(@TempDir tmp: Path) {
        val dir = copyChecks(tmp)
        val good = real(cfg("good"), { perfect })
        val recs = Qualifier.qualify(report(dir, listOf(good)), listOf(good), dir.resolve("checks"), agentDir.toPath(), "2026-11-15T12:00:00Z").records
        val routing = mapOf("scope" to "good")
        fun classify(configs: List<EngineConfig>, records: List<Qualification> = recs) = ChangePlanner.classify(dir.resolve("checks"), agentDir.toPath(), routing, configs, records).single()

        val same = classify(listOf(cfg("good")))
        assertEquals(ChangeClass.COVERED, same.cls, same.reasons.toString())
        // A price and a concurrency change are covered by the evidence that exists.
        assertEquals(ChangeClass.COVERED, classify(listOf(cfg("good", prices = Prices(BigDecimal("1"), BigDecimal("2")), concurrency = 16))).cls)
        // A model upgrade needs requalification.
        val up = classify(listOf(cfg("good", model = "good-v2")))
        assertEquals(ChangeClass.REQUALIFY, up.cls)
        assertTrue(up.reasons.any { it.contains("model good -> good-v2") })
        // A different engine with no record: requalification (the engine swap).
        assertEquals(ChangeClass.REQUALIFY, classify(listOf(cfg("good"), cfg("swap")), recs.map { it.copy(engine = "elsewhere") }).cls)
        // A prompt edit.
        val prompt = dir.resolve("checks/scope/prompt.md")
        Files.writeString(prompt, Files.readString(prompt) + "\nBe more lenient about papers that only touch the call's topics.\n")
        val edited = classify(listOf(cfg("good")))
        assertEquals(ChangeClass.REQUALIFY, edited.cls)
        assertEquals(listOf("prompt.md"), edited.files)
        assertNotEquals(edited.currentVersion, edited.qualifiedVersion)
        assertTrue(edited.reasons.single().contains("prompt.md"))
        assertTrue(ChangePlanner.render(listOf(edited)).contains("SCOPE".lowercase() + " on good: NEEDS REQUALIFICATION"))
        // Editing the oracle needs new evidence, not just a rerun.
        Files.writeString(dir.resolve("checks/scope/oracle/cases.json"), Files.readString(dir.resolve("checks/scope/oracle/cases.json")).replace("]", ",{\"id\":\"scope/new\",\"kind\":\"positive\",\"description\":\"a new case\"}]"))
        assertEquals(ChangeClass.NEW_EVIDENCE, classify(listOf(cfg("good"))).cls)
        // A check with no labelled positives can never be qualified.
        val summary = ChangePlanner.classify(dir.resolve("checks"), agentDir.toPath(), mapOf("summary" to "good"), listOf(cfg("good")), recs).single()
        assertEquals(ChangeClass.NEW_EVIDENCE, summary.cls)
        // Nothing routed, nothing to classify.
        assertTrue(ChangePlanner.classify(dir.resolve("checks"), agentDir.toPath(), emptyMap(), emptyList(), recs).isEmpty())
    }

    @Test
    fun `a prompt edit shows the flags it moves on the held-out corpus`(@TempDir tmp: Path) {
        val dir = copyChecks(tmp)
        // The engine's behaviour depends on its prompt: the edited prompt makes it far more lenient (a stand-in for a model).
        val engine = real(cfg("good"), { p -> if ("more lenient" in p.system) lenient else perfect })
        val recs = Qualifier.qualify(report(dir, listOf(engine)), listOf(engine), dir.resolve("checks"), agentDir.toPath(), "2026-11-15T12:00:00Z").records
        val base = recs.single()
        assertTrue(base.flags.values.any { it.isNotEmpty() })
        // Unchanged: running again moves nothing.
        assertTrue(ChangePlanner.moves(base.flags, report(dir, listOf(engine), k = 1).flagSets.getValue("good").mapValues { (_, s) -> s.filter { it.startsWith("scope|") } }).isEmpty())
        val prompt = dir.resolve("checks/scope/prompt.md")
        Files.writeString(prompt, Files.readString(prompt) + "\nBe more lenient about papers that only touch the call's topics.\n")
        val now = report(dir, listOf(engine), k = 1).flagSets.getValue("good").mapValues { (_, s) -> s.filter { it.startsWith("scope|") } }
        val moves = ChangePlanner.moves(base.flags, now)
        assertTrue(moves.isNotEmpty(), "the lenient prompt moves flags")
        assertTrue(moves.all { it.check == "scope" && !it.gained }, "a more lenient prompt only loses flags here")
        val change = ChangePlanner.classify(dir.resolve("checks"), agentDir.toPath(), mapOf("scope" to "good"), listOf(cfg("good")), recs).single()
        val text = ChangePlanner.render(listOf(change), mapOf("scope" to moves))
        assertTrue(text.contains("NEEDS REQUALIFICATION") && text.contains("flags it moves on held-out: ${moves.size}") && text.contains("  - held-out/") .or(text.contains("    - held-out/")), text)
        assertEquals(moves.sortedBy { it.paper }, ChangePlanner.moves(base.flags, now).sortedBy { it.paper })
        assertNull(ChangePlanner.moves(base.flags, base.flags).firstOrNull())
    }
}
