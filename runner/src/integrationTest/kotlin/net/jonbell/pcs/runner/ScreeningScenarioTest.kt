package net.jonbell.pcs.runner

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import net.jonbell.pcs.core.bundle.BundleAnchor
import net.jonbell.pcs.core.bundle.BundleCodec
import net.jonbell.pcs.core.bundle.BundleFinding
import net.jonbell.pcs.core.bundle.BundleImport
import net.jonbell.pcs.core.bundle.BundleManifest
import net.jonbell.pcs.core.bundle.BundlePaper
import net.jonbell.pcs.core.bundle.BundlePayload
import net.jonbell.pcs.core.bundle.ChairIdentity
import net.jonbell.pcs.core.bundle.ScreeningBundles
import net.jonbell.pcs.core.hotcrp.HotcrpClient
import net.jonbell.pcs.core.imports.Imports
import net.jonbell.pcs.core.readings.Q1
import net.jonbell.pcs.core.readings.Q10
import net.jonbell.pcs.core.readings.Q2
import net.jonbell.pcs.core.readings.Q3
import net.jonbell.pcs.core.readings.Q6
import net.jonbell.pcs.core.readings.QId
import net.jonbell.pcs.core.readings.Readings
import net.jonbell.pcs.core.rules.Stage
import net.jonbell.pcs.core.rules.Tier
import net.jonbell.pcs.core.store.Store
import net.jonbell.pcs.core.store.Sync
import net.jonbell.pcs.core.time.Clock
import net.jonbell.pcs.core.triage.Consistency
import net.jonbell.pcs.core.triage.TriageDrafts
import net.jonbell.pcs.core.triage.TriagePlan
import net.jonbell.pcs.core.triage.TriageReport
import net.jonbell.pcs.core.triage.TriageStatus
import net.jonbell.pcs.core.writeback.ConventionAudit
import net.jonbell.pcs.core.writeback.Writeback
import net.jonbell.pcs.seed.Driver
import net.jonbell.pcs.seed.ScreeningScenario
import net.jonbell.pcs.testing.Covers
import net.jonbell.pcs.testing.Family
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.BeforeAll
import org.junit.jupiter.api.MethodOrderer
import org.junit.jupiter.api.Order
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import org.junit.jupiter.api.TestMethodOrder
import java.nio.file.Files
import java.time.Instant

/**
 * PLAN M13's scenario: the harness is seeded with `screening` (papers 401-417 beside golden's, and 451-475), synced, a screening
 * bundle imported, and the triage queue computed. Every case paper's status is the scenario's own table
 * (`ScreeningScenario.expected`, written down, not computed) and its removability is the Lean model's answer (`lake exe oracle`,
 * asked for each referral as the mirror gave it). Then the chair's steps run through Writeback against the harness.
 * Runs before the scenario runner puts its JVM-wide proxy in place (the seeder talks to the harness directly).
 */
@Order(0)
@Family("T11")
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@TestMethodOrder(MethodOrderer.OrderAnnotation::class)
class ScreeningScenarioTest {
    private val driver by lazy { Driver(Session.harness, Session.token, Session.repo, System.getenv("HOTCRP_COMPOSE_PROJECT") ?: "pcs") }
    private val store: Store = Store.open(Files.createTempFile("pcs-screening", ".db").also { Files.delete(it) }, "test-only-key")
    private val dueH = ScreeningScenario.dueHours
    private var nowH = dueH - 10
    private val clock = Clock { Instant.ofEpochSecond(nowH * 3600) }
    private val readings =
        Readings(q1 = Q1.FIX_WINDOW, q2 = Q2.AC_PLUS_SENIOR, q3 = Q3.ANY_UNTIL_RELEASE, q6 = Q6.GROUNDS, q10 = Q10.WARN_THEN_REJECT)
    private val tier: (String) -> Tier? = { if (it.startsWith("sc-junior")) Tier.JUNIOR else Tier.SENIOR }
    private val cases = 401L..417L

    private fun sync() =
        runBlocking { HotcrpClient(Session.harness, Session.token, chunk = 50, strict = true).use { Sync(store, clock).run(it) } }

    private fun finding(pid: Long, ground: String) =
        BundleFinding(
            pid = "$pid",
            check = "synthetic-check",
            version = "v1",
            kind = "violation",
            ground = ground,
            severity = "high",
            status = "verified",
            engine = "replay-stand-in",
            key = "$pid|synthetic-check|$ground",
            anchors = listOf(BundleAnchor("pdf", "a quoted sentence of paper $pid", page = 2)),
        )

    private fun plan(): TriageReport.Ready {
        val bundle = ScreeningBundles(store, Imports(store, clock), clock).latest()
        return TriagePlan.compute(store, bundle, emptyList(), readings, Stage.SCREENING, nowH, tier) as TriageReport.Ready
    }

    private fun statuses(): Map<Long, String> = plan().rows.filter { it.pid in cases }.associate { it.pid to it.status.name }

    private fun expected(h: Int) = ScreeningScenario.expected(h).mapValues { it.value.name }

    @BeforeAll
    fun seedSyncImport() {
        driver.seed(ScreeningScenario.scenario)
        sync()
        val findings = cases.map { finding(it, ScreeningScenario.groundOf.getValue(it.toInt())) }
        val payload =
            BundlePayload(
                BundleManifest(
                    createdAt = "2030-01-01T00:00:00Z",
                    papers =
                        cases.map {
                            BundlePaper("$it", "0".repeat(64), "synthetic")
                        },
                    checks = emptyList(),
                ),
                findings,
            )
        val chair = ChairIdentity.generate()
        val r = ScreeningBundles(store, Imports(store, clock), clock).import(BundleCodec.encrypt(payload, listOf(chair.publicKey)), chair, "test")
        assertTrue(r is BundleImport.Imported, "$r")
    }

    @Test
    @Order(1)
    @Covers("prop:S8", "prop:S10", "card:E3", "card:E8", "card:E9", "card:E11")
    fun `every case paper stands where the scenario's table puts it, before and after the fix window closes`() {
        assertEquals(expected(-10), statuses(), "10 hours before the window closes")
        nowH = dueH + 2
        assertEquals(expected(2), statuses(), "after it closed")
        nowH = dueH - 10
        val rows = plan().rows.associateBy { it.pid }
        assertTrue(rows.getValue(412).flagged && rows.getValue(412).status == TriageStatus.UNTRIAGED, "S8: a flagged paper nobody triaged stays in review")
        assertTrue(rows.getValue(402).blockers.single().startsWith("Q2"), "the referral with no second opinion says which rule holds it")
    }

    private fun oracle(): (JsonObject) -> JsonObject {
        val p = ProcessBuilder(Session.repo.resolve("model/.lake/build/bin/oracle").toString()).start()
        val w = p.outputStream.bufferedWriter()
        val r = p.inputStream.bufferedReader()
        Runtime.getRuntime().addShutdownHook(Thread { p.destroy() })
        return { q ->
            w.write(q.toString())
            w.newLine()
            w.flush()
            Json.parseToJsonElement(r.readLine()).jsonObject
        }
    }

    @Test
    @Order(2)
    @Covers("rule:may-remove", "prop:S1", "prop:S9", "prop:S10")
    fun `each paper's removability is the Lean model's answer for the referral the mirror gives`() {
        val ask = oracle()
        val reading =
            JsonObject(
                QId.entries.associate { q -> q.code to JsonPrimitive(q.readings.first().key) } +
                    mapOf(
                        "Q1" to JsonPrimitive(readings.q1!!.key),
                        "Q2" to JsonPrimitive(readings.q2!!.key),
                        "Q3" to JsonPrimitive(readings.q3!!.key),
                        "Q6" to JsonPrimitive(readings.q6!!.key),
                        "Q10" to JsonPrimitive(readings.q10!!.key),
                    ),
            )
        for (h in listOf(-10L, 2L)) {
            nowH = dueH + h
            for (row in plan().rows.filter { it.pid in cases }) {
                val ref = row.facts?.referral(Stage.SCREENING, nowH) ?: continue
                if (row.status == TriageStatus.REMOVED) continue
                val q =
                    JsonObject(
                        mapOf(
                            "q" to JsonPrimitive("mayRemove"),
                            "mutant" to JsonNull,
                            "reading" to reading,
                            "referral" to
                                JsonObject(
                                    mapOf(
                                        "ac" to JsonPrimitive(ref.ac),
                                        "ground" to JsonPrimitive(ref.ground.key),
                                        "stage" to JsonPrimitive(ref.stage.key),
                                        "opinions" to
                                            JsonArray(
                                                ref.opinions.map { o ->
                                                    JsonObject(
                                                        mapOf(
                                                            "who" to JsonPrimitive(o.who),
                                                            "isAc" to JsonPrimitive(o.isAc),
                                                            "tier" to (o.tier?.let { JsonPrimitive(it.name.lowercase()) } ?: JsonNull),
                                                            "conflicted" to JsonPrimitive(o.conflicted),
                                                            "agrees" to JsonPrimitive(o.agrees),
                                                        ),
                                                    )
                                                },
                                            ),
                                        "remedyOffered" to JsonPrimitive(ref.remedyOffered),
                                        "remedyDue" to JsonPrimitive(ref.remedyDue),
                                        "cured" to JsonPrimitive(ref.cured),
                                        "warned" to JsonPrimitive(ref.warned),
                                        "askedAt" to JsonPrimitive(ref.askedAt),
                                        "now" to JsonPrimitive(ref.now),
                                    ),
                                ),
                        ),
                    )
                val model = ask(q)["result"]?.jsonPrimitive?.boolean ?: ask(q)["answer"]!!.jsonObject["result"]!!.jsonPrimitive.boolean
                assertEquals(model, row.status == TriageStatus.READY, "paper ${row.pid} at due${if (h > 0) "+" else ""}$h: the model says $model")
            }
        }
        nowH = dueH - 10
    }

    @Test
    @Order(3)
    @Covers("prop:S1", "prop:S2", "prop:M2")
    fun `the chair's steps go through Writeback - mirror and move, findings, then a removal that passes its dry run`() {
        val wb = Writeback(store, clock, Session.harness, Session.token)

        fun apply(artifacts: List<net.jonbell.pcs.core.writeback.Artifact>) {
            for (a in artifacts) {
                val id = wb.draft(a)
                val dr = wb.dryRun(id)
                assertTrue(dr.valid, "HotCRP's dry run refused ${a.summary()}: ${dr.messages}")
                wb.confirm(id)
                wb.apply(id)
            }
            sync()
        }
        // the AC's triage is mirrored into hidden tags and her screening metareview moves to the normal round (M3a's leftover)
        val before = plan()
        assertTrue(before.rows.filter { it.pid in cases && it.facts?.choice != null }.all { it.needsMirror })
        apply(TriageDrafts.mirrorTriage(store))
        val after = plan()
        assertEquals(statuses(), after.rows.filter { it.pid in cases }.associate { it.pid to it.status.name }, "mirroring changes no status")
        assertTrue(after.rows.filter { it.pid in cases }.none { it.needsMirror })
        val moved =
            store.conn.createStatement().use { st ->
                st.executeQuery("SELECT count(*) FROM review WHERE rtype = 5 AND pid = 401 AND round IS NULL AND gone_at IS NULL").use {
                    it.next()
                    it.getInt(1)
                }
            }
        assertEquals(1, moved, "the AC's metareview on 401 is in the normal round")
        assertEquals(emptyList<Any>(), ConventionAudit.run(store).filter { it.pid in cases.map { p -> p } }, "nothing in the traces is reported")
        // the screening record as a reviewer-visible comment
        apply(TriageDrafts.postFindings(store, after.rows.filter { it.pid in cases }))
        assertTrue(TriageDrafts.findingsComments(store).keys.containsAll(cases.filter { it != 413L }.toList()))
        // the removal: only the paper that is ready, with its decision artifact passing HotCRP's dry run
        val ready = plan().rows.filter { it.status == TriageStatus.READY && it.pid in cases }
        assertEquals(setOf(401L, 410L, 411L, 415L, 416L), ready.map { it.pid }.toSet())
        apply(listOf(TriageDrafts.remove(ready, setOf(401L)).first))
        assertEquals(TriageStatus.REMOVED, plan().status(401))
        assertEquals(TriageStatus.READY, plan().status(410), "the others wait for a chair's confirmation")
    }

    @Test
    @Order(4)
    @Covers("prop:M1")
    fun `M1 end to end - the AC who refers every paper is outside the band, and the band is empty without them`() {
        val rows = plan().rows
        val m1 = ScreeningScenario.m1Acs.toSet()
        val per = Consistency.rates(store, rows).filter { it.ac in m1 }
        assertEquals(listOf(0, 1, 0, 1, 5), per.map { it.referred }, "referrals of sc-m1 .. sc-m5")
        assertEquals(setOf("sc-m5@example.org"), Consistency.bandAlerts(per).map { it.ac }.toSet())
        assertEquals(emptyList<Any>(), Consistency.bandAlerts(per.filter { it.ac != "sc-m5@example.org" }))
    }
}
