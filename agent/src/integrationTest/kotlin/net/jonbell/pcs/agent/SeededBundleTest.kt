@file:Suppress("ktlint:standard:max-line-length")

package net.jonbell.pcs.agent

import kotlinx.coroutines.runBlocking
import net.jonbell.pcs.agent.bundle.BundleBuilder
import net.jonbell.pcs.agent.bundle.BundleCli
import net.jonbell.pcs.agent.bundle.BundleFixtures
import net.jonbell.pcs.core.bundle.BundleCodec
import net.jonbell.pcs.core.bundle.BundleImport
import net.jonbell.pcs.core.bundle.BundleKey
import net.jonbell.pcs.core.bundle.ScreeningBundles
import net.jonbell.pcs.core.hotcrp.HotcrpClient
import net.jonbell.pcs.core.imports.ImportKind
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.Sync
import net.jonbell.pcs.core.time.Clock
import net.jonbell.pcs.testing.Family
import net.jonbell.pcs.testing.LocalHarness
import org.junit.jupiter.api.AfterAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import java.nio.file.Files
import java.time.Instant

/**
 * PLAN M12 done-when: a run on the harness's seeded conference produces a bundle that another copy of the app imports
 * with identical findings. Each seeded paper gets a synthetic manuscript (the seeded conference has no PDFs of its own);
 * only the deterministic checks and a replay engine run, so no engine is called; every paper is synthetic.
 */
@Family("T10")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class SeededBundleTest {
    private val tmp = Files.createTempDirectory("pcs-seeded-bundle")
    private val url = LocalHarness.require(System.getenv("PCS_HOTCRP_URL") ?: error("PCS_HOTCRP_URL not set: run scripts/hotcrp-up.sh and source .env.test"))
    private val token = System.getenv("PCS_HOTCRP_TOKEN") ?: error("PCS_HOTCRP_TOKEN not set")
    private val clock = Clock { Instant.parse("2030-02-26T17:00:00Z") }

    @AfterAll
    fun cleanup() {
        tmp.toFile().deleteRecursively()
    }

    /** One chair's copy of the app: its own encrypted store, rebuilt from HotCRP. */
    private fun copyOfTheApp(name: String): Store {
        val s = Store.open(tmp.resolve("$name.db"), "test-only-key")
        runBlocking { HotcrpClient(url, token, chunk = 5).use { Sync(s, clock).run(it) } }
        return s
    }

    private fun pids(s: Store): List<String> =
        s.conn.createStatement().use { st ->
            st.executeQuery("SELECT pid FROM paper ORDER BY pid").use { rs ->
                generateSequence { if (rs.next()) rs.getLong(1).toString() else null }.toList()
            }
        }

    @Test
    fun `a bundle from a run on the seeded conference imports into another copy of the app with identical findings`() {
        val first = copyOfTheApp("chair-a")
        val second = copyOfTheApp("chair-b")
        try {
            val all = pids(first)
            assertTrue(all.size >= 10, "the golden conference has papers: $all")
            assertEquals(all, pids(second), "two copies rebuilt from HotCRP agree")
            val papers = all.zip(BundleFixtures.items(all.size))
            val pids = papers.map { it.first }
            assertTrue(pids.size >= 10)
            val run = BundleFixtures.prepare(tmp.resolve("run").also { Files.createDirectories(it) }, papers)

            // The screening run: `pcs agent bundle`, on a workstation with no HotCRP credential, over replayed answers.
            val out = StringBuilder()
            val key = tmp.resolve("bundle.key")
            val code = BundleCli(BundleFixtures.env(run), out).bundle(BundleFixtures.args(run, tmp.resolve("out"), key, "--at", "2030-02-26T17:00:00Z"))
            assertEquals(0, code, out.toString())
            val file = Files.list(tmp.resolve("out")).use { it.toList() }.single()
            val bytes = Files.readAllBytes(file)
            assertEquals("bundle-${BundleCodec.headerHash(bytes)}.pcsb", file.fileName.toString())
            val k = BundleKey.parse(Files.readString(key))

            // Both copies import the file with the key that travelled separately.
            fun import(s: Store, tag: String): Pair<List<Pair<String, Map<String, String>>>, net.jonbell.pcs.core.bundle.BundlePayload> {
                val imports = Imports(s, clock)
                val bundles = ScreeningBundles(s, imports, clock)
                val r = bundles.import(bytes, k, "$tag.pcsb")
                assertTrue(r is BundleImport.Imported, "$r")
                return imports.latest(ImportKind.SCREENING_BUNDLE)!!.rows.map { it.key to it.data } to bundles.latest()!!
            }
            val a = import(first, "a")
            val b = import(second, "b")
            assertEquals(a.first, b.first, "identical imported findings")
            assertEquals(a.second, b.second, "identical payload: findings, summaries, manifest")
            assertTrue(a.first.isNotEmpty() && a.second.findings.any { it.verified })

            // Every finding is about a paper both copies hold, and equals what the screening run itself produced.
            assertTrue(a.second.findings.all { it.pid in pids })

            fun norm(f: net.jonbell.pcs.core.bundle.BundleFinding) =
                f.copy(
                    engine =
                        if (f.engine ==
                            "local"
                        ) {
                            "local"
                        } else {
                            "llm"
                        },
                    fields = f.fields.toSortedMap(),
                    dependsOn = f.dependsOn.sorted(),
                )
            assertEquals(run.screens.values.flatten().map { norm(BundleBuilder.finding(it)) }.toSet(), a.second.findings.map(::norm).toSet())
            assertEquals(pids.toSet(), a.second.manifest.papers.map { it.pid }.toSet())
            // The visible findings of any one paper agree across copies, and unverified ones are never visible.
            for (pid in pids) {
                assertEquals(
                    ScreeningBundles(first, Imports(first, clock), clock).visibleFor(pid),
                    ScreeningBundles(second, Imports(second, clock), clock).visibleFor(pid),
                )
            }
            assertTrue(a.first.none { (_, d) -> d["status"] == "unverified" && d["anchors"]!!.isNotEmpty() })
            // The same file a second time is recognised, and changes nothing.
            assertTrue(ScreeningBundles(second, Imports(second, clock), clock).import(bytes, k, "again.pcsb") is BundleImport.AlreadyImported)
        } finally {
            first.close()
            second.close()
        }
    }
}
