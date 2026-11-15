package net.jonbell.pcs.cli.eval

import net.jonbell.pcs.agent.checks.FormatPolicy
import net.jonbell.pcs.core.readings.Q13
import net.jonbell.pcs.core.readings.Q15
import net.jonbell.pcs.core.rules.ScoreScale
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import java.io.File
import java.net.ProxySelector
import java.net.ServerSocket
import java.net.SocketAddress
import java.net.URI
import java.nio.file.Files
import java.nio.file.Path
import java.security.MessageDigest

/**
 * PLAN M21, the federated evaluation kit, on a synthetic conference: no model, no network, no HotCRP. The conference is an export directory and a
 * directory of PDFs; the report is read as text.
 */
@Family("T7")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class EvalKitTest {
    private lateinit var tmp: Path
    private lateinit var conf: SeededConference
    private val repo = File(System.getProperty("pcs.repoRoot"))

    @BeforeAll
    fun seed() {
        tmp = Files.createTempDirectory("pcs-eval-test")
        conf = SeededConference(tmp)
        Files.writeString(tmp.resolve("format.json"), kotlinx.serialization.json.Json.encodeToString(FormatPolicy.serializer(), FormatPolicy.SYNTHETIC))
    }

    @AfterAll
    fun clean() {
        tmp.toFile().deleteRecursively()
    }

    private fun env(extra: Map<String, String> = emptyMap()) = mapOf("PCS_TIER_TAGS" to "junior=jr,senior=sr") + extra

    private fun args(vararg more: String) =
        listOf(
            "--export",
            conf.export.toString(),
            "--pdfs",
            conf.pdfDir.toString(),
            "--format-policy",
            tmp.resolve("format.json").toString(),
            "--tpms-scores",
            tmp.resolve("tpms-scores.csv").toString(),
        ) +
            more

    private fun run(args: List<String>, env: Map<String, String> = env(), gate: (Set<String>) -> NetworkGate = { NetworkGate.CLOSED }): Pair<Int, String> {
        val out = StringBuilder()
        val err = StringBuilder()
        val code = EvalCommand(env, out, err, gate).run(args)
        return code to (if (code == 0) out.toString() else "$out$err")
    }

    private val replayRun by lazy {
        run(
            args(
                "--engine",
                "rep",
                "--class",
                "synthetic",
                "--cfp",
                tmp.resolve("cfp.txt").toString(),
                "--abstracts-by-paper",
                tmp.resolve("abstracts.json").toString(),
                "--authors",
                tmp.resolve("authors.json").toString(),
            ),
            replayEnv(),
        )
    }

    private val base by lazy { run(args()) }

    private fun replayEnv() =
        env(
            mapOf(
                "PCS_ENGINES" to "rep",
                "PCS_ENGINE_rep_ADAPTER" to "replay",
                "PCS_ENGINE_rep_REPLAY_OF" to net.jonbell.pcs.agent.llm.LiveSample.ENGINE,
                "PCS_ENGINE_rep_MODEL" to net.jonbell.pcs.agent.llm.LiveSample.MODEL,
                "PCS_ENGINE_rep_RECORDINGS" to File(repo, "agent/fixtures/replay").path,
                "PCS_AGENT_CHECKS" to File(repo, "agent/checks").path,
                "PCS_AGENT_DECISIONS" to File(repo, "agent/decisions.example.yaml").path,
            ),
        )

    // ---- identifier scan ------------------------------------------------------------------------------------------------------------------

    private fun sha(b: ByteArray) = MessageDigest.getInstance("SHA-256").digest(b).joinToString("") { "%02x".format(it) }

    /** The T7-style scan: every ID, title, name, email, hash, path and review text of the input, looked for in the report. */
    private fun scan(report: String) {
        val lower = report.lowercase()
        for (s in conf.secrets) assertFalse(lower.contains(s.lowercase()), "the report contains an input string")
        for (pid in conf.pids) assertFalse(Regex("(?<![0-9])$pid(?![0-9])").containsMatchIn(report), "the report contains a paper id")
        for (p in conf.papers) assertFalse(report.contains(sha(p.pdf)) || report.contains(sha(p.pdf).take(12)), "the report contains a PDF hash")
        assertFalse(report.contains(tmp.toString()) || report.contains("example.org") || report.contains("@"), "the report contains a path, host, or address")
    }

    @Test
    @Covers("prop:C1", "prop:S5")
    fun `the report holds no identifier, title, name, address, hash or text from the input`() {
        val (code, report) = base
        assertEquals(0, code, report)
        assertTrue(report.contains("## Checks against the recorded desk rejects") && report.contains("`reject-only`"), report)
        scan(report)
        // the replay engine's report too: engine calls add cost and flags, never text
        val (c2, r2) = replayRun
        assertEquals(0, c2, r2)
        scan(r2)
    }

    // ---- suppression ----------------------------------------------------------------------------------------------------------------------

    /** The integers in the report's cells: what is left after the fixed wording, backticked names, percentages and the settings quoted in text. */
    private fun cellNumbers(report: String): List<Int> =
        report.lines().filter { it.startsWith("- ") || it.startsWith("| ") }.map { l ->
            l.replace(Regex("`[^`]*`"), "").replace(Regex("at least \\d+ PC members"), "").replace(Regex("[A-Za-z]+\\d+"), "")
        }.flatMap { Regex("(?<![\\w.])\\d+(?![\\w.%])").findAll(it).map { m -> m.value.toInt() }.toList() }

    @Test
    @Covers("prop:C1")
    fun `every count of 1 to 4 is suppressed in the seeded report, a true zero is shown, and the minimum cannot be lowered`() {
        val (_, report) = base
        val small = cellNumbers(report).filter { it in 1..4 }
        assertTrue(small.isEmpty(), "a count of 1 to 4 is in the report: $small\n$report")
        assertTrue(report.contains("<5") || report.contains("suppressed"), "the seeded conference has small cells, so something is suppressed")
        assertTrue(report.contains("- Rows the kit could not read: 0"), "a zero is shown as 0, not as <5\n$report")
        assertTrue(0 in cellNumbers(report))
        val (code, msg) = run(args("--min-cell", "4"))
        assertEquals(2, code)
        assertTrue(msg.contains("never lower"))
        val (c2, raised) = run(args("--min-cell", "9"))
        assertEquals(0, c2)
        assertTrue(cellNumbers(raised).none { it in 1..8 }, "raising the minimum raises it everywhere (zero stays visible)")
    }

    private fun report(
        checks: ChecksResult? = null,
        reviewed: Int = 40,
        pc: Int = 24,
        tpms: TpmsResult = TpmsResult(24, 20, 40, 30, 0, 0.4, 3),
        comp: CompositionResult = CompositionResult(24, 8, 40, Q13.entries.map { CompositionRow(it, 40, 30, 6, 6) }),
        er: EarlyRejectResult = EarlyRejectResult(40, Q15.entries.mapIndexed { i, q -> EarlyRejectRow(q, 8 + 8 * i, 5 + 2 * i) }),
    ) = EvalReport(RunFacts("deterministic only", emptySet(), "an export directory"), reviewed, pc, checks, tpms, comp, er).render()

    private fun checksOf(papers: Int, desk: Int, tp: Int, fp: Int, rowFlagged: Int, rowTp: Int) =
        ChecksResult(
            papers,
            desk,
            listOf(CheckRow("format", rowFlagged, rowTp), CheckRow("anonymity", 20, 15)),
            Confusion(tp, fp, desk - tp),
            java.math.BigDecimal("1.5"),
            3,
        )

    @Test
    @Covers("prop:C1")
    fun `no small cell can be read back from the report whatever its value, including by subtraction`() {
        // Non-interference: a number that is a small cell (1 to 4), or whose complement is, may change among 1 to 4 without changing one byte of the report.
        // Zero is not a small cell: it is shown (the next test), so the baseline here is 1.
        for (n in 1..4) {
            assertEquals(report(reviewed = 1), report(reviewed = n))
            assertEquals(report(pc = 1), report(pc = n))
            assertEquals(report(tpms = TpmsResult(24, n, 40, 30, 0, 0.4, 3)), report(tpms = TpmsResult(24, 1, 40, 30, 0, 0.4, 3)))
            assertEquals(report(tpms = TpmsResult(24, 20, 40, 40 - n, 0, 0.4, 3)), report(tpms = TpmsResult(24, 20, 40, 39, 0, 0.4, 3)))
            assertEquals(report(tpms = TpmsResult(24, 20, 40, 30, n, 0.4, 3)), report(tpms = TpmsResult(24, 20, 40, 30, 1, 0.4, 3)))
            val comp = { c: Int, s: Int -> CompositionResult(24, 8, 40, Q13.entries.map { CompositionRow(it, 40, c, s, s) }) }
            assertEquals(report(comp = comp(n, 6)), report(comp = comp(1, 6)))
            assertEquals(report(comp = comp(40 - n, 6)), report(comp = comp(39, 6)))
            assertEquals(report(comp = comp(30, n)), report(comp = comp(30, 1)))
            // the confusion group: any of the three cells small hides precision, recall, the true positives and the row
            assertEquals(report(checksOf(60, 20, n, 30, 20, 12)), report(checksOf(60, 20, 1, 30, 20, 12)))
            assertEquals(report(checksOf(60, 20, 12, n, 20, 12)), report(checksOf(60, 20, 12, 1, 20, 12)))
            assertEquals(report(checksOf(60, 20, 20 - n, 30, 20, 12)), report(checksOf(60, 20, 19, 30, 20, 12)))
            assertEquals(report(checksOf(n, 0, 0, 0, 0, 0)), report(checksOf(1, 0, 0, 0, 0, 0)))
            // a check row that differs from the any-check row by a small number of papers
            assertEquals(report(checksOf(60, 20, 15, 30, 45 - n, 15 - n)), report(checksOf(60, 20, 15, 30, 44, 14)))
            val er = { c: Int -> EarlyRejectResult(40, Q15.entries.map { EarlyRejectRow(it, c, c) }) }
            assertEquals(report(er = er(n)), report(er = er(1)))
            assertEquals(report(er = er(40 - n)), report(er = er(39)))
        }
        // and a large value is shown: the rules hide small cells, not everything
        assertTrue(report(checksOf(60, 20, 15, 30, 25, 8)).contains("| `format` | 25 | 8 |"))
    }

    @Test
    @Covers("prop:C1")
    fun `true zeros are shown, and only 1 to 4 is suppressed, in counts, rates, nested counts and the confusion group`() {
        val d = Disclosure()
        for (n in 1..4) {
            assertEquals("<5", d.count(n))
            assertEquals("suppressed", d.rate(n, 40), "a numerator of $n")
            assertEquals("suppressed", d.rate(40 - n, 40), "a complement of $n")
        }
        assertEquals("0", d.count(0))
        assertEquals("5", d.count(5))
        assertEquals("0.0% (0 of 40)", d.rate(0, 40), "a zero numerator is the failure worth seeing")
        assertEquals("100.0% (40 of 40)", d.rate(40, 40), "a zero complement is a zero")
        assertEquals("50.0% (20 of 40)", d.rate(20, 40))
        assertEquals("suppressed", d.rate(0, 3), "the complement of 3 is a small cell")
        assertEquals("suppressed", d.rate(2, 5))
        // complements under 5 stay suppressed: 36 of 40 would give back a 4
        assertEquals("suppressed", d.rate(36, 40))
        assertEquals(listOf(true, true, true), d.nested(listOf(5, 12, 30)))
        assertEquals(listOf(true, false, true), d.nested(listOf(5, 8, 30)))
        assertEquals(listOf(true, false, false), d.nested(listOf(0, 3, 4)))
        assertEquals(listOf(true, true, true), d.nested(listOf(0, 0, 0)), "equal counts differ by a zero")
        assertEquals(listOf(true, true, false), d.nested(listOf(10, 10, 12)), "a difference of 2 is a small cell")
        assertEquals("suppressed", d.mean(java.math.BigDecimal.TEN, 4))
        assertEquals("n/a", d.mean(java.math.BigDecimal.ZERO, 0))
        assertEquals("2.5000", d.mean(java.math.BigDecimal("100"), 40))
        // the confusion group: zero cells are shown, a 1 to 4 hides all of it
        assertTrue(Confusion(0, 12, 20).shown(d))
        assertEquals("0.0%", Confusion(0, 12, 20).recall(d))
        assertTrue(Confusion(0, 0, 0).shown(d))
        assertEquals(false, Confusion(0, 12, 3).shown(d))
        assertEquals("suppressed", Confusion(7, 2, 20).precision(d))
        // and in the rendered report
        assertTrue(report(reviewed = 0).contains("went to review (not withdrawn, not desk rejected): 0"))
        assertTrue(report(checksOf(60, 20, 0, 30, 20, 0)).contains("recall 0.0%"), report(checksOf(60, 20, 0, 30, 20, 0)))
        assertTrue(report(checksOf(60, 20, 0, 30, 20, 0)).contains("| `format` | 20 | 0 |"))
        assertTrue(report(checksOf(60, 20, 2, 30, 20, 2)).contains("recall suppressed"), "a true-positive cell of 2 hides the group")
    }

    // ---- what the numbers are -------------------------------------------------------------------------------------------------------------

    @Test
    fun `early-reject candidates match the scores in the export under each Q15 reading, and the nesting holds`() {
        val input = EvalInput.fromExport(conf.export)
        val e = EvalMetrics.earlyReject(input, ScoreScale.HOTCRP_DEFAULT, "OveMer", 3, "desk")
        val reviewed = conf.papers.filter { it.decision != "Desk reject" }
        assertEquals(reviewed.size, e.reviewed)

        fun count(vararg k: Int) = reviewed.count { (it.pid % 8).toInt() in k }
        assertEquals(count(0, 1), e.rows[Q15.entries.indexOf(Q15.REJECT_ONLY)].candidates)
        assertEquals(count(0, 1, 2), e.rows[Q15.entries.indexOf(Q15.REJECT_OR_WEAK)].candidates)
        assertEquals(count(0, 1, 2), e.rows[Q15.entries.indexOf(Q15.BELOW_ACCEPT)].candidates)
        assertTrue(e.rows.zipWithNext().all { (a, b) -> a.candidates <= b.candidates })
        assertTrue(e.rows.all { it.candidatesRejected <= it.candidates })
    }

    @Test
    fun `the checks find the planted desk rejects, precision and recall against the recorded outcome`() {
        val (_, report) = base
        val any = Regex("Any check: precision (\\S+), recall (\\S+)").find(report)!!
        assertTrue(any.groupValues[1] != "suppressed" && any.groupValues[2] != "suppressed", report)
        assertTrue(any.groupValues[2].removeSuffix("%").toDouble() > 50.0, "recall: ${any.groupValues[2]}")
        assertTrue(report.contains("| `format` |") && report.contains("| `injection.hidden` |"))
    }

    @Test
    fun `composition counts reflect real conflicts, tiers and the Q13 reading`() {
        val input = EvalInput.fromExport(conf.export)
        val c = EvalMetrics.composition(input, mapOf("junior" to "jr"), mapOf("senior" to 15, "junior" to 8), "desk")
        assertEquals(24, c.reviewers)
        assertEquals(8, c.juniors)
        assertEquals(Q13.entries.size, c.rows.size)
        assertTrue(c.rows.all { it.composed in 0..it.planned })
        // with no junior tag every seat is senior, so a reading that requires a junior composes nothing
        val none = EvalMetrics.composition(input, emptyMap(), mapOf("senior" to 15, "junior" to 8), "desk")
        assertEquals(0, none.juniors)
        assertEquals(0, none.rows.first { it.q13 == Q13.ONE_JUNIOR }.composed)
        assertTrue(c.rows.first { it.q13 == Q13.ONE_JUNIOR }.composed > 0)
    }

    @Test
    fun `TPMS coverage counts members with a profile and papers with enough usable scores`() {
        val input = EvalInput.fromExport(conf.export)
        val t = EvalMetrics.tpms(input, TpmsData.read(tmp.resolve("tpms-scores.csv"), null), 3, 0.4, "desk")
        assertEquals(24, t.pcMembers)
        assertEquals(20, t.pcWithProfile, "four members have no row")
        assertTrue(t.papersCovered in 1..t.papers)
        val none = EvalMetrics.tpms(input, TpmsData.NONE, 3, 0.4, "desk")
        assertEquals(0, none.pcWithProfile)
        assertEquals(0, none.papersCovered)
    }

    @Test
    fun `an export with review text keeps no text in memory`() {
        val input = EvalInput.fromExport(conf.export)
        assertTrue(input.reviews.isNotEmpty() && input.reviews.all { r -> r.fields.keys.none { it in EvalInput.TEXT_FIELDS } })
        assertTrue(input.reviews.all { it.fields.toString().contains("SECRET").not() })
    }

    // ---- determinism ----------------------------------------------------------------------------------------------------------------------

    @Test
    @Covers("prop:C1")
    fun `two runs give byte-identical reports, deterministic and with the replay engine`() {
        val a = base
        val b = run(args())
        assertEquals(0, a.first)
        assertEquals(a.second, b.second)
        val r1 = replayRun
        val r2 =
            run(
                args(
                    "--engine",
                    "rep",
                    "--class",
                    "synthetic",
                    "--cfp",
                    tmp.resolve("cfp.txt").toString(),
                    "--abstracts-by-paper",
                    tmp.resolve("abstracts.json").toString(),
                    "--authors",
                    tmp.resolve("authors.json").toString(),
                ),
                replayEnv(),
            )
        assertEquals(0, r1.first, r1.second)
        assertEquals(r1.second, r2.second)
        assertTrue(r1.second.contains("- Engine: replay") && r1.second.contains("- Network used: none"), "replay serves recordings from disk")
        assertFalse(r1.second.contains("Cost per paper screened (USD, over the papers with a PDF): 0.0000"), "the recorded calls carry their recorded cost")
        assertTrue(a.second.contains("- Engine: deterministic only"))
        assertTrue(a.second.contains("Cost per paper screened (USD, over the papers with a PDF): 0.0000"))
        // --out writes the same bytes the command would print
        val f = tmp.resolve("report.md")
        val out = StringBuilder()
        assertEquals(0, EvalCommand(env(), out, out).run(args("--out", f.toString())))
        assertEquals(a.second, Files.readString(f))
    }

    // ---- offline by default ---------------------------------------------------------------------------------------------------------------

    private class Watch : ProxySelector() {
        val asked = mutableListOf<URI>()

        override fun select(uri: URI): List<java.net.Proxy> {
            asked += uri
            return listOf(java.net.Proxy.NO_PROXY)
        }

        override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: java.io.IOException?) = Unit
    }

    @Test
    @Covers("prop:H4", "prop:C1")
    fun `with no token and no engine the kit opens no connection of any kind`() {
        val watch = Watch()
        val before = ProxySelector.getDefault()
        ProxySelector.setDefault(watch)
        ServerSocket(0, 5, java.net.InetAddress.getLoopbackAddress()).use { listener ->
            listener.soTimeout = 1
            try {
                // the gate throws on any request to open a connection; the proxy selector sees any URL connection or JDK HTTP call
                val (code, report) = run(args(), gate = { NetworkGate.CLOSED })
                assertEquals(0, code, report)
                val (c2, _) = run(args("--out", tmp.resolve("o.md").toString()), gate = { NetworkGate.CLOSED })
                assertEquals(0, c2)
            } finally {
                ProxySelector.setDefault(before)
            }
            assertTrue(watch.asked.isEmpty(), "something asked to connect: ${watch.asked}")
            assertTrue(runCatching { listener.accept() }.isFailure, "something connected to the listener")
        }
    }

    @Test
    @Covers("prop:H4", "prop:S5")
    fun `a token or an engine is the only way a connection is asked for, and the gate allows exactly that`() {
        val tokenFile = tmp.resolve("token")
        Files.writeString(tokenFile, "not-a-real-token")
        val asked = mutableListOf<Set<String>>()
        val (code, msg) =
            run(listOf("--token-file", tokenFile.toString()), env(mapOf("PCS_HOTCRP_URL" to "http://127.0.0.1:1")), gate = { allowed ->
                asked += allowed
                NetworkGate.CLOSED
            })
        assertEquals(1, code)
        assertTrue(msg.contains("offline unless you ask"), msg)
        assertEquals(listOf(setOf("hotcrp")), asked, "a token asks for HotCRP and nothing else")
        // an engine that calls out asks for its own kind; replay asks for nothing
        val live =
            env(
                mapOf(
                    "PCS_ENGINES" to "gpu",
                    "PCS_ENGINE_gpu_ADAPTER" to "openai-compat",
                    "PCS_ENGINE_gpu_BASE_URL" to "http://127.0.0.1:1/v1",
                    "PCS_ENGINE_gpu_MODEL" to "m",
                    "PCS_AGENT_CHECKS" to File(repo, "agent/checks").path,
                ),
            )
        val seen = mutableListOf<Set<String>>()
        val (c2, m2) =
            run(args("--engine", "gpu"), live, gate = { allowed ->
                seen += allowed
                NetworkGate.CLOSED
            })
        assertEquals(1, c2)
        assertTrue(m2.contains("engine:openai-compat"), m2)
        assertEquals(listOf(setOf("engine:openai-compat")), seen)
        val rep = mutableListOf<Set<String>>()
        run(args("--engine", "rep", "--class", "synthetic"), replayEnv(), gate = { allowed ->
            rep += allowed
            NetworkGate.CLOSED
        })
        assertEquals(listOf(emptySet<String>()), rep)
        // the real gate refuses what was not asked for
        val g = RequestedNetwork(emptySet())
        assertTrue(runCatching { g.open("hotcrp") }.exceptionOrNull() is OfflineViolation)
        val h = RequestedNetwork(setOf("hotcrp"))
        h.open("hotcrp")
        assertEquals(setOf("hotcrp"), h.requested)
        assertTrue(runCatching { h.open("engine:anthropic") }.exceptionOrNull() is OfflineViolation)
    }

    @Test
    @Covers("prop:H4", "prop:C1")
    fun `no kit source can connect or send except through the gate, and none uploads`() {
        val dir = File(repo, "cli/src/main/kotlin/net/jonbell/pcs/cli/eval")
        val files = dir.listFiles { f -> f.extension == "kt" }!!
        assertTrue(files.size >= 6)
        for (f in files) {
            val text = f.readText()
            for (needle in listOf("HotcrpClient(", "EngineFactory.create(")) {
                var at = text.indexOf(needle)
                while (at >= 0) {
                    assertTrue(text.substring(0, at).contains("gate.open("), "${f.name}: $needle is not behind the gate")
                    at = text.indexOf(needle, at + 1)
                }
            }
            for (banned in listOf(
                "java.net.http",
                "io.ktor",
                "java.net.Socket",
                "URL(",
                "HttpURLConnection",
                "ProcessBuilder",
                "Runtime.getRuntime",
                "HotcrpWriter",
                "post(",
            )) {
                assertFalse(text.contains(banned), "${f.name} mentions $banned")
            }
        }
    }
}
