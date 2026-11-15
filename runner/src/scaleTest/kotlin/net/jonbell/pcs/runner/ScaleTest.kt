package net.jonbell.pcs.runner

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import net.jonbell.pcs.core.assignment.Assignment
import net.jonbell.pcs.core.assignment.AssignmentBuild
import net.jonbell.pcs.core.assignment.AssignmentData
import net.jonbell.pcs.core.assignment.AssignmentInput
import net.jonbell.pcs.core.assignment.AssignmentSettings
import net.jonbell.pcs.core.hotcrp.HotcrpClient
import net.jonbell.pcs.core.imports.ImportKind
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.secrets.Keychain
import net.jonbell.pcs.core.session.Conferences
import net.jonbell.pcs.core.session.Session
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.Sync
import net.jonbell.pcs.core.store.Tables
import net.jonbell.pcs.core.time.Clock
import net.jonbell.pcs.seed.Generated
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import net.jonbell.pcs.testing.LocalHarness
import net.jonbell.pcs.testing.Measurements
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.TestMethodOrder
import java.nio.file.Files
import java.nio.file.Path
import java.time.Instant
import kotlin.random.Random

/**
 * T9, PLAN M19: the `scale` scenario (4,000 papers) seeded into the harness, then, across every module that exists: a full sync and a
 * no-change re-sync, imports of affinity, a full solve, the analyses the dashboards read, and the table loads. The tables' render and
 * filter times are measured in-process by the app's `scaleUiTest` on the store this test leaves behind. Each measurement is written as an
 * evidence record of kind `measurement` that `lake exe check-evidence` re-derives.
 *
 * Needs the harness seeded with `scale` (`./gradlew :seed:run --args=scale`); the nightly job does that on a harness of its own.
 */
@Family("T9")
@Covers("prop:Q1")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ScaleTest {
    private val pretty = kotlinx.serialization.json.Json { prettyPrint = true }
    private val repo: Path = Path.of(System.getProperty("pcs.repoRoot"))
    private val out: Path = Path.of(System.getProperty("pcs.scaleDir")).also { Files.createDirectories(it) }
    private val budgets = Measurements.budgets(repo)
    private val runs = System.getenv("PCS_SCALE_RUNS")?.toIntOrNull() ?: budgets.runs
    private val token = System.getenv("PCS_HOTCRP_TOKEN") ?: error("PCS_HOTCRP_TOKEN not set")
    private val url = LocalHarness.require(System.getenv("PCS_HOTCRP_URL") ?: error("PCS_HOTCRP_URL not set"))
    private val dbKey = "scale-only-not-secret"
    private val dbFile: Path = out.resolve("scale.db")
    private val env = Measurements.environment()
    private val prov = Measurements.provenance(repo)
    private val facts = linkedMapOf<String, Any?>()
    private var t = Instant.parse("2030-02-26T17:00:00Z")
    private val clock = Clock { t }

    // the production client settings (Settings defaults: chunk 200, concurrency 2)
    private fun client() = HotcrpClient(url, token, chunk = 200, concurrency = 2, strict = false)

    private fun ms(block: () -> Unit): Long {
        val t0 = System.nanoTime()
        block()
        return (System.nanoTime() - t0) / 1_000_000
    }

    private fun one(store: Store, sql: String): Long =
        store.conn.createStatement().use { s ->
            s.executeQuery(sql).use {
                it.next()
                it.getLong(1)
            }
        }

    private fun workload(extra: Map<String, Any?> = emptyMap()): JsonObject =
        Measurements.jsonOf(
            mapOf(
                "scenario" to "scale (seed/Generated.SCALE, fixed seed 20301)",
                "papers" to facts["papers"],
                "reviews" to facts["reviews"],
                "comments" to facts["comments"],
                "pcMembers" to facts["pc"],
                "runs" to runs,
            ) + extra,
        )

    private fun record(metric: String, samples: List<Long>, extra: Map<String, Any?> = emptyMap()) {
        Measurements.record(out.resolve("records"), metric, budgets[metric], samples, budgets.runs, workload(extra), listOf("prop:Q1"), env, prov)
        println("scale: $metric samples=$samples budget=${budgets[metric].ms} ms")
    }

    @Test
    @Order(1)
    fun `the harness holds the scale scenario`() {
        val pids = runBlocking { client().use { it.paperIds() } }
        assertTrue(pids.size >= Generated.SCALE.papers - 50, "seed the scale scenario first (:seed:run --args=scale); the harness has ${pids.size} papers")
        facts["papers"] = pids.size
    }

    @Test
    @Order(2)
    fun `full sync into an empty store`() {
        val samples = mutableListOf<Long>()
        var tables: Map<String, Long> = emptyMap()
        for (i in 1..runs) {
            val f = if (i == 1) dbFile else out.resolve("scratch-$i.db")
            Files.deleteIfExists(f)
            Store.open(f, dbKey).use { store ->
                var counts: net.jonbell.pcs.core.store.SyncCounts? = null
                samples += ms { counts = runBlocking { client().use { c -> Sync(store, clock).run(c) } } }
                if (i == 1) {
                    tables =
                        listOf("person", "paper", "review", "review_version", "review_text", "comment", "comment_text", "assignment", "fts").associateWith {
                            store.count(it)
                        }
                    facts["newRowsFirstSync"] = counts!!.newRows
                }
            }
            if (i > 1) Files.deleteIfExists(f)
            println("scale: full sync $i: ${samples.last()} ms")
        }
        facts["rows"] = tables
        facts["papers"] = tables.getValue("paper")
        facts["reviews"] = tables.getValue("review")
        facts["comments"] = tables.getValue("comment")
        facts["pc"] = tables.getValue("person")
        assertTrue(tables.getValue("paper") >= Generated.SCALE.papers - 50)
        record("sync.full", samples, mapOf("rows" to tables))
    }

    @Test
    @Order(3)
    fun `a re-sync with no change writes nothing`() {
        val samples = mutableListOf<Long>()
        Store.open(dbFile, dbKey).use { store ->
            val watched = listOf("review_version", "review_text", "comment_text", "rating_change", "fts", "paper", "review", "comment", "assignment", "person")
            val before = watched.associateWith { store.count(it) }
            for (i in 1..runs) {
                t = t.plusSeconds(900)
                var noop = false
                samples += ms { noop = runBlocking { client().use { c -> Sync(store, clock).run(c) } }.isNoop }
                assertTrue(noop, "re-sync $i changed something")
                println("scale: re-sync $i: ${samples.last()} ms")
            }
            assertEquals(before, watched.associateWith { store.count(it) }, "a no-change re-sync wrote rows")
        }
        record("sync.noop", samples)
    }

    private fun scoresCsv(): String {
        val rnd = Random(77)
        val s = Generated.SCALE
        val people = (1..s.seniors).map { "sen$it" } + (1..s.juniors).map { "jun$it" } + (1..s.nominees).map { "nom$it" }
        return buildString {
            appendLine("paper,email,score")
            for (p in 1..s.papers) {
                // 60 candidates per paper, as an area-pruned TPMS export would hold
                val cands = HashSet<Int>()
                while (cands.size < 60) cands += rnd.nextInt(people.size)
                for (c in cands.sorted()) appendLine("$p,${people[c]}@example.org,${"%.3f".format(rnd.nextDouble())}")
            }
        }
    }

    /** The appointments sheet: the 300 juniors and the first 1,200 nominee accounts are classified junior; everyone else is a senior PC member with no row. */
    private fun appointmentsCsv(): String =
        buildString {
            appendLine("email,origin,nominated_by,area,ac_email,decision,tier,consent,on_pc_at")
            for (i in 1..Generated.SCALE.juniors) appendLine("jun$i@example.org,invited,,area,ac1@example.org,accept,junior,yes,")
            for (i in 1..1200) appendLine("nom$i@example.org,invited,,area,ac1@example.org,accept,junior,yes,")
        }

    private fun conf(): Session {
        val dir = out.resolve("conferences").also { Files.createDirectories(it) }
        Files.writeString(
            dir.resolve("scale.conf"),
            listOf(
                "PCS_HOTCRP_URL=$url",
                "PCS_ANSWERS=${repo.resolve("model/answers/complete.txt")}",
                "PCS_DB_PATH=$dbFile",
                "PCS_TZ=America/New_York",
                "PCS_NOW=2030-02-26T12:00",
                "PCS_PHASE_REVIEW_DUE=2030-02-01T23:59",
                "PCS_PHASE_RESPONSE_OPEN=2030-02-08T00:00",
                "PCS_PHASE_RESPONSE_CLOSE=2030-02-11T23:59",
                "PCS_PHASE_DISCUSSION_OPEN=2030-02-12T00:00",
                "PCS_PHASE_DISCUSSION_CLOSE=2030-03-01T23:59",
                "PCS_PHASE_DECISIONS_DUE=2030-03-03T23:59",
                "PCS_PHASE_EARLYREJECT_OPEN=2030-02-02T00:00",
                "PCS_LOAD_SENIOR_MAX=8",
                "PCS_LOAD_JUNIOR_MAX=6",
                "PCS_TIER_TAGS=junior=junior,nominee=nominee",
            ).joinToString("\n") + "\n",
        )
        val e = mapOf("PCS_HOTCRP_TOKEN" to token, "PCS_DB_KEY" to dbKey, "PCS_CONFERENCES" to dir.toString())
        val kc =
            object : Keychain {
                override val backend = "in-memory"

                override fun read(account: String): String? = null

                override fun write(account: String, secret: String) {}
            }
        val c = Conferences.load(dir.resolve("scale.conf"), e)
        check(c.settings.isSuccess) { c.problems.toString() }
        return Session.open(c, kc, e)
    }

    @Test
    @Order(4)
    fun `affinity import and the analyses the dashboards read`() {
        conf().use { s ->
            val csv = scoresCsv()
            val importMs =
                ms {
                    check(
                        Imports(
                            s.store,
                            Clock {
                                Instant.parse("2030-02-26T16:00:00Z")
                            },
                        ).import(ImportKind.TPMS_SCORES, csv.toByteArray(), "scale-tpms-scores.csv") is net.jonbell.pcs.core.imports.ImportResult.Accepted,
                    )
                }
            facts["tpmsRows"] = csv.lines().size - 2
            check(
                Imports(
                    s.store,
                    Clock {
                        Instant.parse("2030-02-26T16:00:00Z")
                    },
                ).import(ImportKind.APPOINTMENTS, appointmentsCsv().toByteArray(), "scale-appointments.csv") is
                    net.jonbell.pcs.core.imports.ImportResult.Accepted,
            )
            facts["appointmentRows"] = Generated.SCALE.juniors + 1200
            val times = linkedMapOf<String, Long>("import.tpms-scores" to importMs)
            times["discussion"] = ms { s.discussion() }
            times["accountability"] = ms { s.accountability() }
            times["early-reject"] = ms { s.earlyReject() }
            times["table.papers.load"] = ms { Tables.papers(s.store) }
            times["table.reviews.load"] = ms { Tables.reviews(s.store) }
            facts["analysisMs"] = times
            println("scale: analyses $times")
        }
    }

    @Test
    @Order(5)
    fun `a full solve from scratch`() {
        conf().use { s ->
            val settings = AssignmentSettings.of(s.settings)
            val built = AssignmentData(s.store, Imports(s.store, s.clock)).build(s.answers().readings, settings)
            val b = (built as? AssignmentInput.Ready ?: error("blocked: $built")).build
            // the first assignment: nobody has a review yet, so the pinned reviews the mirror holds are dropped
            val fresh = AssignmentBuild(b.input.copy(pinned = emptyList()), b.config, b.emailOf, b.tierOf, b.sources, b.tpmsAssignment, b.notes, b.settings)
            val samples = mutableListOf<Long>()
            var last: net.jonbell.pcs.core.assignment.SolveReport? = null
            for (i in 1..runs) {
                samples +=
                    ms {
                        // from the mirror, as a chair's click does: build the input, then solve, audit, scan and write the CSV
                        val input = (AssignmentData(s.store, Imports(s.store, s.clock)).build(s.answers().readings, settings) as AssignmentInput.Ready).build
                        val f =
                            AssignmentBuild(
                                input.input.copy(pinned = emptyList()),
                                input.config,
                                input.emailOf,
                                input.tierOf,
                                input.sources,
                                input.tpmsAssignment,
                                input.notes,
                                input.settings,
                            )
                        last = Assignment.report(f)
                    }
                println("scale: solve $i: ${samples.last()} ms")
            }
            val r = last!!
            assertEquals(emptyList<String>(), r.audit, "the independent audit found a fault in the plan")
            val plan = r.plan
            val withPins = ms { Assignment.report(b) }
            facts["solve"] =
                mapOf(
                    "papers" to r.papers,
                    "reviewers" to fresh.input.reviewers.size,
                    "candidateEdges" to plan.candidateEdges,
                    "composed" to plan.composed,
                    "seniorShort" to plan.seniorShort,
                    "thirdShort" to plan.thirdShort,
                    "cyclesFirst" to plan.cyclesFirst,
                    "cyclesLeft" to plan.cyclesLeft.size,
                    "repairs" to plan.repairs.size,
                    "newEdges" to plan.edges.size,
                    "infeasible" to plan.infeasible,
                    "withPinnedReviewsMs" to withPins,
                )
            record("solve.full", samples, mapOf("solve" to facts["solve"], "tpmsRows" to facts["tpmsRows"]))
        }
    }

    @Test
    @Order(9)
    fun `the store's size and a summary`() {
        val size = Files.size(dbFile)
        val tables =
            Store.open(dbFile, dbKey).use { st ->
                listOf(
                    "person",
                    "paper",
                    "review",
                    "review_version",
                    "review_text",
                    "comment",
                    "comment_text",
                    "assignment",
                    "fts",
                    "import_row",
                ).associateWith {
                    runCatching { st.count(it) }.getOrDefault(-1)
                }
            }
        facts["dbBytes"] = size
        facts["dbTables"] = tables
        Files.writeString(
            out.resolve("facts.json"),
            pretty.encodeToString(JsonObject.serializer(), Measurements.jsonOf(facts)) + "\n",
        )
        println("scale: store ${size / (1024 * 1024)} MiB, $tables")
    }
}
